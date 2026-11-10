"""Run the actual Grafana route with isolated primary/backup loopback fixtures."""

import importlib.util
import json
import tempfile
import time
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "ingress_fixture", Path(__file__).with_name("check-location.py")
)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.HOST = "grafana.example.com"


def configuration(primary, backup):
    adapted = json.loads(
        fixture.docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--env-file",
            str(fixture.ROOT / "caddy.env.example"),
            "-e",
            "GRAFANA_ACCESS_POLICY=public_access",
            "-e",
            "GRAFANA_UPSTREAM=127.0.0.1:18082 127.0.0.1:18081",
            "-v",
            str(fixture.ROOT / "Caddyfile") + ":/etc/caddy/Caddyfile:ro",
            fixture.IMAGE,
            "caddy",
            "adapt",
            "--config",
            "/etc/caddy/Caddyfile",
        ).stdout
    )
    selected = [
        route
        for server in adapted["apps"]["http"]["servers"].values()
        for route in server.get("routes", [])
        if any(
            fixture.HOST in match.get("host", []) for match in route.get("match", [])
        )
    ]
    assert len(selected) == 1
    servers = {
        "ingress": {
            "listen": ["127.0.0.1:18080"],
            "automatic_https": {"disable": True},
            "routes": selected,
        }
    }
    for name, port, enabled in (("primary", 18082, primary), ("backup", 18081, backup)):
        if enabled:
            servers[name] = {
                "listen": [f"127.0.0.1:{port}"],
                "routes": (
                    [
                        {
                            "match": [{"path": ["/transport-failure"]}],
                            "handle": [{"handler": "static_response", "abort": True}],
                        }
                    ]
                    if name == "primary"
                    else []
                )
                + [
                    {
                        "match": [{"path": ["/application-error"]}],
                        "handle": [{"handler": "static_response", "status_code": 500}],
                    },
                    {
                        "match": [
                            {"header": {"Authorization": ["Bearer " + fixture.TOKEN]}}
                        ],
                        "handle": [
                            {
                                "handler": "static_response",
                                "status_code": 200,
                                "headers": {"X-Fixture-Upstream": [name]},
                                "body": "synthetic Grafana",
                            }
                        ],
                    },
                    {"handle": [{"handler": "static_response", "status_code": 401}]},
                ],
            }
    return {"admin": {"disabled": True}, "apps": {"http": {"servers": servers}}}


def main():
    runtime = fixture.ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    for primary, backup in ((True, True), (False, True), (False, False)):
        name = "caddy-grafana-check-" + uuid.uuid4().hex[:12]
        with tempfile.TemporaryDirectory(
            prefix="grafana-check-", dir=runtime
        ) as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(configuration(primary, backup)))
            try:
                fixture.docker(
                    "run",
                    "-d",
                    "--name",
                    name,
                    "--network",
                    "none",
                    "-v",
                    str(config) + ":/fixture.json:ro",
                    fixture.IMAGE,
                    "caddy",
                    "run",
                    "--config",
                    "/fixture.json",
                )
                for _ in range(30):
                    if (
                        b"serving initial configuration"
                        in fixture.docker("logs", name).stderr
                    ):
                        break
                    time.sleep(0.1)
                for method in ("GET", "POST"):
                    status, headers = fixture.request(
                        name, method, "/api/health", timeout=8
                    )
                    assert status in ({200} if primary or backup else {502, 503}), (
                        primary,
                        backup,
                        status,
                    )
                    if status == 200:
                        assert headers["x-fixture-upstream"] == (
                            "primary" if primary else "backup"
                        )
                if primary or backup:
                    assert (
                        fixture.request(name, "GET", "/api/health", token=None)[0]
                        == 401
                    )
                    assert fixture.request(name, "POST", "/application-error")[0] == 500
                if primary:
                    # The primary accepted the POST before closing its connection.
                    # Replaying it against the healthy backup would return 200.
                    assert (
                        fixture.request(name, "POST", "/transport-failure", timeout=8)[
                            0
                        ]
                        == 502
                    )
                    status, headers = fixture.request(
                        name, "GET", "/api/health", timeout=8
                    )
                    assert status == 200 and headers["x-fixture-upstream"] == "backup"
            finally:
                fixture.docker("rm", "-f", "-v", name, check=False)
    print(
        "Grafana ingress: primary, dial-failure backup, auth and HTTP 500 semantics verified"
    )


if __name__ == "__main__":
    main()
