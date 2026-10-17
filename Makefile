DOCKER ?= docker
DOCKER_COMPOSE = $(DOCKER) compose
include makefiles/versions.mk

up: runtime-config-check
	$(DOCKER_COMPOSE) up -d
	$(MAKE) reload

down:
	$(DOCKER_COMPOSE) down

logs:
	$(DOCKER_COMPOSE) logs -f

reload: sync-runtime-config
	$(DOCKER_COMPOSE) exec caddy caddy reload --config /etc/caddy/Caddyfile

.PHONY: up down logs reload runtime-config-check check format

format:
	$(DOCKER) run --rm --network none -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile" caddy:$(CADDY_VERSION) caddy fmt --overwrite /etc/caddy/Caddyfile

runtime-config-check: sync-runtime-config
	@test -s caddy.env || { echo 'Create caddy.env from caddy.env.example'; exit 1; }
	@test -s headscale/config.yaml || { echo 'Create headscale/config.yaml from its example'; exit 1; }
	$(DOCKER_COMPOSE) config --quiet

check: config-check
	python3 -m py_compile scripts/deploy-receiver.py scripts/remote-deploy.py

.PHONY: remote-deploy
remote-deploy:
	python3 scripts/remote-deploy.py

.PHONY: versions config-check
versions:
	@$(foreach v,$(VERSION_VARS),printf '%s=%s\n' '$(v)' '$($(v))';)
config-check:
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE) --env-file /dev/null -f docker-compose.yml config --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE) --env-file /dev/null -f docker-compose.yml -f compose.russia.yml config --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE) --env-file /dev/null -f docker-compose.yml -f compose.forwarder.yml config --quiet
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -e CADDY_LISTENER_OPTIONS=edge_listener -e OPENCODE_UPSTREAM=https://192.0.2.1 -e OPENCODE_PROXY_OPTIONS=tls_origin -e SUBSCRIPTIONS_UPSTREAM=https://192.0.2.1 -e SUBSCRIPTIONS_PROXY_OPTIONS=tls_origin -e WORKERS_PROXY_OPTIONS=tls_origin -e CLIP_WORKER_UPSTREAM=https://192.0.2.1 -e STASH_WORKER_UPSTREAM=https://192.0.2.1 -e TRANSCRIBER_WORKER_UPSTREAM=https://192.0.2.1 -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -e HEADSCALE_UPSTREAM=https://192.0.2.2 -e HEADSCALE_PROXY_OPTIONS=tls_origin -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --tmpfs /var/lib/headscale -v "$(CURDIR)/headscale/config.example.yaml:/etc/headscale/config.yaml:ro" headscale/headscale:$(HEADSCALE_VERSION) configtest

# Keep the mounted directory stable across Git's atomic file replacement.
.PHONY: sync-runtime-config
sync-runtime-config:
	mkdir -p .runtime/caddy
	cp Caddyfile .runtime/caddy/Caddyfile.next
	mv -f .runtime/caddy/Caddyfile.next .runtime/caddy/Caddyfile
