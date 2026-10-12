DOCKER_COMPOSE = docker compose
DOCKER ?= docker
include versions.mk

up: runtime-config-check
	$(DOCKER_COMPOSE) up -d

down:
	$(DOCKER_COMPOSE) down

logs:
	$(DOCKER_COMPOSE) logs -f

reload:
	$(DOCKER_COMPOSE) exec caddy caddy reload --config /etc/caddy/Caddyfile

.PHONY: up down logs reload runtime-config-check check format

format:
	$(DOCKER) run --rm --network none -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile" caddy:$(CADDY_VERSION) caddy fmt --overwrite /etc/caddy/Caddyfile

runtime-config-check:
	@test -s caddy.env || { echo 'Create caddy.env from caddy.env.example'; exit 1; }
	@test -s headscale/config.yaml || { echo 'Create headscale/config.yaml from its example'; exit 1; }
	$(DOCKER_COMPOSE) config --quiet

check: config-check

.PHONY: versions config-check
versions:
	@$(foreach v,$(VERSION_VARS),printf '%s=%s\n' '$(v)' '$($(v))';)
config-check:
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE) --env-file /dev/null config --quiet
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --tmpfs /var/lib/headscale -v "$(CURDIR)/headscale/config.example.yaml:/etc/headscale/config.yaml:ro" headscale/headscale:$(HEADSCALE_VERSION) configtest
