"""Explicit VM-only acceptance check; never invoked by ordinary config-check.

Sends an invalid subscription request with synthetic credentials and queries
the local Loki and Prometheus APIs. It never creates a real publication.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_json(url):
    with opener.open(url, timeout=8) as r:
        return json.load(r)


start = time.time_ns()
marker = "synthetic-caddy-observability-not-a-secret"
url = (
    "https://"
    + os.environ["SUBSCRIPTIONS_DOMAIN"]
    + "/s/"
    + "Z" * 43
    + "/v2rayng?probe="
    + marker
)
req = urllib.request.Request(
    url,
    headers={
        "Authorization": "Bearer " + marker,
        "Cookie": "probe=" + marker,
        "Referer": "https://example.invalid/" + marker,
    },
)
try:
    with opener.open(req, timeout=10) as r:
        code = r.status
except urllib.error.HTTPError as e:
    code = e.code
print("Synthetic invalid subscription response:", code)
assert code == 400

records = []
for attempt in range(15):
    q = urllib.parse.urlencode(
        {
            "query": '{container="caddy"} | json | site="subscriptions"',
            "start": str(start),
            "end": str(time.time_ns()),
            "limit": 100,
        }
    )
    d = get_json("http://127.0.0.1:3100/loki/api/v1/query_range?" + q)
    records = [
        (s["stream"], json.loads(v[1]), v[1])
        for s in d.get("data", {}).get("result", [])
        for v in s.get("values", [])
    ]
    if records:
        break
    time.sleep(2)
assert records, "Synthetic access event did not reach Loki"
assert all(marker not in line and "Z" * 43 not in line for _, _, line in records)
assert all(
    not any(k in body for k in ["request", "resp_headers", "user_id"])
    for _, body, _ in records
)
assert all(
    body.get("service") == "caddy" and isinstance(body.get("ts"), (int, float))
    for _, body, _ in records
)
assert any(body.get("status") == 400 for _, body, _ in records)
print("Caddy → Docker → Alloy → Loki: verified; request/token/header omission verified")
print(
    "Loki indexed log levels:",
    sorted({labels.get("level") for labels, _, _ in records}),
)

up = []
for attempt in range(10):
    q = urllib.parse.urlencode({"query": 'up{job="caddy"}'})
    d = get_json("http://127.0.0.1:9090/api/v1/query?" + q)
    up = d.get("data", {}).get("result", [])
    if up and all(r["value"][1] == "1" for r in up):
        break
    time.sleep(3)
assert up and all(r["value"][1] == "1" for r in up), "Caddy scrape not up"
q = urllib.parse.urlencode(
    {"query": 'count by (__name__) ({job="caddy",__name__=~"caddy_http_.+"})'}
)
d = get_json("http://127.0.0.1:9090/api/v1/query?" + q)
names = sorted(r["metric"]["__name__"] for r in d["data"]["result"])
assert "caddy_http_requests_total" in names
assert any("duration" in name for name in names)
print('Prometheus up{job="caddy"}: 1')
print("Collected HTTP metric families:", names)
