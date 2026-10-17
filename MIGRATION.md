# Public ingress and Headscale: server → Russia

The same pinned Headscale version and its SQLite, Noise keys, policy, node IDs,
addresses and approved routes move together. Never run two advertised copies.
Take a final cold archive after stopping the original process, and verify
SQLite integrity and identity fingerprints before allowing writes on Russia.
Keep private backups outside both VMs. Do not print container Env or node JSON.

Russia keeps its existing vless-relay Caddy L4 owner of public TCP 80/443.
It forwards the original TLS stream for the migrated domain and subdomains
to `public-ingress:443`, with PROXY v2, over `vless-relay_vpn-ingress` only.
The upstream Caddy allows PROXY headers only from that network and has no
published 443; the old 8443 URL remains a direct TLS listener without PROXY.
HTTP-01 reaches the same certificate owner through port 80. Existing VPN,
subscription and Telemt SNI routes remain independent.

On Russia, ignored `.env` selects
`COMPOSE_FILE=docker-compose.yml:compose.russia.yml`.
Private `caddy.env` selects `CADDY_LISTENER_OPTIONS=edge_listener` and the actual
`INGRESS_PROXY_CIDR`. Headscale stays on the local caddy-net without published
API/metrics/admin ports. Its public bootstrap path does not depend on WSL or
the host's own Tailscale interface.

Until applications move, OPENCODE_UPSTREAM, SUBSCRIPTIONS_UPSTREAM and all
three worker upstreams point to `https://100.64.0.1`, with their corresponding
`*_PROXY_OPTIONS=tls_origin`. TLS verifies the original site hostname, and Host
is preserved. Existing public_access/vpn_only settings must be copied exactly;
the PROXY listener preserves client IP for the latter. Grafana already points
to WSL. Move remaining applications before the original TLS certificates expire.

On server, `.env` selects `compose.forwarder.yml` alongside the base file,
excluding its old Headscale from ordinary startup. Disable restart on that old
container as well. HEADSCALE_UPSTREAM points to Russia's **public** HTTPS IP,
HEADSCALE_PROXY_OPTIONS=tls_upgrade_origin. The HTTP/1.1 TLS hop preserves
the Tailscale Noise HTTP Upgrade; HTTP/2 on this hop rejects it with 502.
Use tls_upgrade_origin for OpenCode WebSocket connections too; gRPC worker
upstreams retain tls_origin with HTTP/2 support. This supports cached DNS and the legacy URL
without a dependency on the tailnet being available. Original volumes remain.

After destination health and TLS checks, switch the DuckDNS base A record;
check both 443 and 8443, public and tailnet DNS, all six SSH hosts, the Finland
SOCKS control path and actual VPN egress. Update the two existing MagicDNS
records for OpenCode/Grafana to Russia; do not change node VPN addresses.

Rollback before destination writes: restore previous ingress artifact/config,
point DNS back, stop Russia Headscale, then enable the original Headscale.
After destination writes, first stop it and move its **latest** consistent DB
and keys back. Do not restore an old preparation snapshot over newer records.
Revert the forwarder role/upstream and restart policy only after stopping the
other active controller. Preserve backup files and certificate stores.

## Verified migration, 17 October 2026

DuckDNS `mralexandrov` A now points to 193.187.93.245; both the primary 443
and legacy 8443 URL pass TLS validation and Headscale health. The original eight
node identities, addresses, approved routes and Noise key matched the cold
snapshot before start. Six host nodes and the Grafana sidecar reconnected;
the pre-existing offline phone was not used for testing.

SSH to all six native tailnet addresses was checked through Russia, with host
keys read over previously trusted connections. An isolated ephemeral Tailscale
client registered against the new controller and used Finland exit node
100.64.0.6: both api.ipify.org and ifconfig.me returned 193.84.2.141. The probe
node/container were deleted. Host routing and production exit preferences were
not changed. Real VLESS requests also confirmed Finnish egress, Russian domain
exceptions and the direct Finnish profile. Access from the actual phone was not
tested. No full VM/Windows reboot was performed.

Private backups are under `/home/maxim/backups/headscale-migration-20261017`
on server and Russia, plus an off-VM copy in the operator's local
`~/.local/state/headscale-migration-20261017`. They contain credentials; never
commit or print them. `server-final` is the cold controller snapshot, with SQLite
integrity, archive checksum and identity fingerprint. The original volumes
remain on server with its Headscale stopped and restart=no.
