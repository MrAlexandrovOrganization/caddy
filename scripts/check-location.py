"""Exercise actual mobile ingress routes with a synthetic upstream, network none."""

import json
import os
import select
import shlex
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCKER = shlex.split(os.environ.get("DOCKER", "docker"))
IMAGE = os.environ["CADDY_IMAGE"]
HOST = "location.example.com"
TOKEN = "synthetic-location-check-token"


def docker(*args, data=None, check=True):
    return subprocess.run(
        [*DOCKER, *args],
        input=data,
        capture_output=True,
        check=check,
        timeout=30,
    )


def configuration():
    adapted = json.loads(
        docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--env-file",
            str(ROOT / "caddy.env.example"),
            "-e",
            "LOCATION_UPSTREAM=127.0.0.1:18081",
            "-v",
            str(ROOT / "Caddyfile") + ":/etc/caddy/Caddyfile:ro",
            IMAGE,
            "caddy",
            "adapt",
            "--config",
            "/etc/caddy/Caddyfile",
        ).stdout
    )
    # Preserve the compiled Location handlers and log filters. Only listeners,
    # TLS/ACME and unrelated sites are replaced for the isolated HTTP fixture.
    servers = adapted["apps"]["http"]["servers"]
    selected = [
        (server, route)
        for server in servers.values()
        for route in server.get("routes", [])
        if any(HOST in match.get("host", []) for match in route.get("match", []))
    ]
    if len(selected) != 1:
        raise AssertionError("Expected exactly one mobile ingress site")
    server, route = selected[0]
    return {
        "admin": {"disabled": True},
        "logging": adapted["logging"],
        "apps": {
            "http": {
                "servers": {
                    "ingress": {
                        "listen": ["127.0.0.1:18080"],
                        "automatic_https": {"disable": True},
                        "routes": [route],
                        "logs": {
                            "logger_names": {HOST: server["logs"]["logger_names"][HOST]}
                        },
                    },
                    "upstream": {
                        "listen": ["127.0.0.1:18081"],
                        "routes": [
                            {
                                "match": [
                                    {"header": {"Authorization": ["Bearer " + TOKEN]}}
                                ],
                                "handle": [
                                    {
                                        "handler": "static_response",
                                        "status_code": 200,
                                        "body": "synthetic-ack",
                                        "headers": {
                                            "X-Fixture-Path": ["{http.request.uri}"]
                                        },
                                    }
                                ],
                            },
                            {
                                "handle": [
                                    {"handler": "static_response", "status_code": 401}
                                ]
                            },
                        ],
                    },
                }
            }
        },
    }


def request(container, method, path, token=TOKEN, body=b""):
    headers = [
        f"{method} {path} HTTP/1.1",
        f"Host: {HOST}",
        "Connection: close",
        f"Content-Length: {len(body)}",
    ]
    if token is not None:
        headers.append("Authorization: Bearer " + token)
    wire = "\r\n".join(headers).encode() + b"\r\n\r\n" + body
    # Keep stdin open until the server closes the HTTP response. Closing it at
    # once makes BusyBox nc cancel in-flight proxy requests before their reply.
    command = [*DOCKER, "exec", "-i", container, "nc", "-w", "2", "127.0.0.1", "18080"]
    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE
    ) as proc:
        try:
            try:
                proc.stdin.write(wire)
                proc.stdin.flush()
            except BrokenPipeError:
                pass  # An oversized body can be rejected before it is sent in full.
            response = b""
            deadline = time.monotonic() + 10
            while True:
                if not select.select(
                    [proc.stdout], [], [], max(0, deadline - time.monotonic())
                )[0]:
                    raise TimeoutError("HTTP fixture response timed out")
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                response += chunk
                if b"\r\n\r\n" in response:
                    head, payload = response.split(b"\r\n\r\n", 1)
                    lengths = [
                        int(line.split(b":", 1)[1])
                        for line in head.split(b"\r\n")[1:]
                        if line.lower().startswith(b"content-length:")
                    ]
                    if lengths and len(payload) >= lengths[0]:
                        break
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
            # nc can report EPIPE after a valid oversized-body rejection.
            proc.wait(timeout=5)
        finally:
            if proc.poll() is None:
                proc.kill()
    head = response.split(b"\r\n\r\n", 1)[0].decode()
    lines = head.split("\r\n")
    return int(lines[0].split()[1]), dict(
        (name.lower(), value.strip())
        for line in lines[1:]
        for name, value in [line.split(":", 1)]
    )


def main():
    name = "caddy-location-check-" + uuid.uuid4().hex[:12]
    point = "a0000000-0000-4000-8000-000000000001"
    ingestion = ["/mobile/locations/" + point, "/mobile/measurements/" + point]
    updates = ["/mobile/app-update", "/mobile/app-update/" + "a" * 64 + ".apk"]
    accepted = (
        [("PUT", p) for p in ingestion]
        + [("GET", p) for p in updates]
        + [("POST", "/mobile/batches")]
    )
    count = 0
    # Keep bind mounts under the checkout, also shared by local Docker VMs.
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="location-check-", dir=runtime
    ) as directory:
        config = Path(directory) / "config.json"
        config.write_text(json.dumps(configuration()))
        try:
            docker(
                "run",
                "-d",
                "--name",
                name,
                "--network",
                "none",
                "-v",
                str(config) + ":/fixture.json:ro",
                IMAGE,
                "caddy",
                "run",
                "--config",
                "/fixture.json",
            )
            for _ in range(50):
                try:
                    if request(name, "GET", "/")[0] == 404:
                        break
                except (ValueError, IndexError, subprocess.CalledProcessError):
                    time.sleep(0.1)
            else:
                raise AssertionError("Fixture did not start")

            for method, path in accepted:
                for token, expected in [
                    (TOKEN, 200),
                    (None, 401),
                    ("wrong-synthetic", 401),
                ]:
                    status, headers = request(name, method, path, token)
                    assert status == expected, (method, path, status, expected)
                    assert headers.get("cache-control") == "no-store"
                    if expected == 200:
                        assert headers.get("x-fixture-path") == path, (
                            status,
                            headers,
                            path,
                        )
                    count += 1
                for wrong_method in [
                    m
                    for m in ["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD"]
                    if m != method
                ]:
                    assert request(name, wrong_method, path)[0] == 404
                    count += 1

            for verb, prefix, limit in [
                ("PUT", ingestion[0], 4096),
                ("PUT", ingestion[1], 65536),
                ("POST", "/mobile/batches", 262144),
            ]:
                for size, expected in [(limit, 200), (limit + 1, 413)]:
                    assert request(name, verb, prefix, body=b"x" * size)[0] == expected
                    count += 1

            for path in [
                "/",
                "/locations",
                "/healthz",
                "/readyz",
                "/metrics",
                "/mobile/app-update/",
                "/mobile/app-update/current.json",
                "/mobile/app-update/" + "a" * 64 + "Xapk",
                "/mobile/app-update/" + "A" * 64 + ".apk",
                "/mobile/locations/" + point.upper(),
                "/mobile/measurements/" + point + "/extra",
                "/mobile/measurements/not-a-uuid",
                "/mobile/batches/",
                "/mobile/batches/extra",
            ]:
                for method in ["GET", "PUT", "POST"]:
                    assert request(name, method, path)[0] == 404, (method, path)
                    count += 1
            logs = docker("logs", name)
            assert TOKEN.encode() not in logs.stdout + logs.stderr
            print(
                f"Location ingress: {count} HTTP checks passed; bearer omitted from logs"
            )
        except Exception:
            logs = docker("logs", name, check=False)
            print((logs.stdout + logs.stderr).decode(errors="replace"))
            raise
        finally:
            docker("rm", "-f", "-v", name, check=False)


if __name__ == "__main__":
    main()
