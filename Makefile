DOCKER_COMPOSE_BASE = $(DOCKER) compose --project-directory "$(CURDIR)"
include makefiles/compose.mk
DOCKER ?= docker
DOCKER_COMPOSE = $(DOCKER) compose --project-directory "$(CURDIR)" $(COMPOSE_FLAGS)
HEADSCALE_CONFIG_FILE ?= ./headscale/config.yaml
export HEADSCALE_CONFIG_FILE
include makefiles/versions.mk

up: runtime-config-check
	$(DOCKER_COMPOSE) up -d --wait --wait-timeout 120
	$(MAKE) reload

down:
	$(DOCKER_COMPOSE) down

logs:
	$(DOCKER_COMPOSE) logs -f

reload: sync-runtime-config
	$(DOCKER_COMPOSE) exec caddy caddy reload --address 127.0.0.1:2019 --config /etc/caddy/Caddyfile

.PHONY: up down logs reload runtime-config-check check format

.PHONY: headscale-config-check headscale-recreate
headscale-config-check:
	$(DOCKER) run --rm --network none --tmpfs /var/lib/headscale -v "$(abspath $(HEADSCALE_CONFIG_FILE)):/etc/headscale/config.yaml:ro" headscale/headscale:$(HEADSCALE_VERSION) configtest

# Private config updates may replace the inode; recreate to refresh its bind.
headscale-recreate: headscale-config-check
	$(DOCKER_COMPOSE) up -d --no-deps --force-recreate headscale
	@for attempt in 1 2 3 4 5 6 7 8 9 10; do \
		$(DOCKER_COMPOSE) exec -T caddy wget -q -T 2 -O - http://headscale:8080/health && exit 0; \
		sleep 2; \
	done; exit 1

format:
	$(DOCKER) run --rm --network none -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile" caddy:$(CADDY_VERSION) caddy fmt --overwrite /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none -v "$(CURDIR)/scripts:/work" -w /work ghcr.io/astral-sh/ruff:$(RUFF_VERSION) check --select E4,E7,E9,F,I --fix --no-cache .
	$(DOCKER) run --rm --network none -v "$(CURDIR)/scripts:/work" -w /work ghcr.io/astral-sh/ruff:$(RUFF_VERSION) format --no-cache .

.PHONY: install
install:
	$(DOCKER) pull caddy:$(CADDY_VERSION)
	$(DOCKER) pull headscale/headscale:$(HEADSCALE_VERSION)
	$(DOCKER) pull ghcr.io/astral-sh/ruff:$(RUFF_VERSION)

runtime-config-check: sync-runtime-config
	@test -s caddy.env || { echo 'Create caddy.env from caddy.env.example'; exit 1; }
	@test -s headscale/config.yaml || { echo 'Create headscale/config.yaml from its example'; exit 1; }
	$(DOCKER_COMPOSE) config --quiet

check: config-check location-check grafana-check personality-check
	python3 -m py_compile scripts/deploy-receiver.py scripts/remote-deploy.py
	$(DOCKER) run --rm --network none -v "$(CURDIR)/scripts:/work:ro" -w /work ghcr.io/astral-sh/ruff:$(RUFF_VERSION) check --select E4,E7,E9,F,I --no-cache .
	$(DOCKER) run --rm --network none -v "$(CURDIR)/scripts:/work:ro" -w /work ghcr.io/astral-sh/ruff:$(RUFF_VERSION) format --check --no-cache .

.PHONY: location-check
location-check:
	DOCKER='$(DOCKER)' CADDY_IMAGE='caddy:$(CADDY_VERSION)' python3 -B scripts/check-location.py

.PHONY: remote-deploy
remote-deploy:
	python3 scripts/remote-deploy.py

.PHONY: versions config-check
versions:
	@$(foreach v,$(VERSION_VARS),printf '%s=%s\n' '$(v)' '$($(v))';)
config-check:
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml config --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml -f compose/compose.russia.yml config --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml -f compose/compose.forwarder.yml config --quiet
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -e LOCATION_INGRESS=location_disabled -e LOCATION_DOMAIN= -e LOCATION_UPSTREAM= -e JELLYFIN_INGRESS=jellyfin_disabled -e JELLYFIN_DOMAIN= -e JELLYFIN_UPSTREAM= -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -e CADDY_LISTENER_OPTIONS=edge_listener -e OPENCODE_UPSTREAM=https://192.0.2.1 -e OPENCODE_PROXY_OPTIONS=tls_origin -e SUBSCRIPTIONS_UPSTREAM=https://192.0.2.1 -e SUBSCRIPTIONS_PROXY_OPTIONS=tls_origin -e WORKERS_PROXY_OPTIONS=tls_origin -e CLIP_WORKER_UPSTREAM=https://192.0.2.1 -e STASH_WORKER_UPSTREAM=https://192.0.2.1 -e TRANSCRIBER_WORKER_UPSTREAM=https://192.0.2.1 -e TRANSCRIBER_WORKER_PROXY_OPTIONS=tls_origin -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --add-host caddy-metrics:127.0.0.1 --env-file caddy.env.example -e HEADSCALE_UPSTREAM=https://192.0.2.2 -e HEADSCALE_PROXY_OPTIONS=tls_upgrade_origin -v "$(CURDIR)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:$(CADDY_VERSION) caddy validate --config /etc/caddy/Caddyfile
	$(DOCKER) run --rm --network none --tmpfs /var/lib/headscale -v "$(CURDIR)/headscale/config.example.yaml:/etc/headscale/config.yaml:ro" headscale/headscale:$(HEADSCALE_VERSION) configtest

# Keep the mounted directory stable across Git's atomic file replacement.
.PHONY: sync-runtime-config sync-personality-site personality-check personality-sync
sync-runtime-config: sync-personality-site
	mkdir -p .runtime/caddy
	cp Caddyfile .runtime/caddy/Caddyfile.next
	mv -f .runtime/caddy/Caddyfile.next .runtime/caddy/Caddyfile

sync-personality-site:
	@if test -f .runtime/caddy/personality.d/viewer.caddy; then \
		set -e; umask 077; \
		test -s .runtime/caddy/personality/profiles.json || { echo 'Missing private personality profiles.json'; exit 1; }; \
		for asset in index.html styles.css app.mjs model.mjs; do \
			cp "sites/personality/$$asset" ".runtime/caddy/personality/.$$asset.next"; \
			mv -f ".runtime/caddy/personality/.$$asset.next" ".runtime/caddy/personality/$$asset"; \
		done; \
	fi

personality-check:
	node --check sites/personality/app.mjs
	node --test sites/personality/model.test.mjs scripts/sync-personality.test.mjs

personality-sync:
	@flock -n -E 0 "$(CURDIR)/.runtime/personality-sync/sync.lock" \
		$(DOCKER) run --rm --pull=missing --read-only --cap-drop=ALL \
		--security-opt=no-new-privileges --memory=128m --user "$$(id -u):$$(id -g)" \
		--mount "type=bind,src=$(CURDIR)/scripts/sync-personality.mjs,dst=/app/scripts/sync-personality.mjs,readonly" \
		--mount "type=bind,src=$(CURDIR)/sites/personality/model.mjs,dst=/app/sites/personality/model.mjs,readonly" \
		--mount "type=bind,src=$(CURDIR)/.runtime/personality-sync,dst=/config,readonly" \
		--mount "type=bind,src=$(CURDIR)/.runtime/caddy/personality,dst=/snapshot" \
		$(PERSONALITY_SYNC_IMAGE) node /app/scripts/sync-personality.mjs /config /snapshot/profiles.json

.PHONY: compose
compose:
	$(DOCKER_COMPOSE) $(ARGS)

# Read-only validation of every tracked Compose combination, without runtime secrets.
.PHONY: compose-layout-check
compose-layout-check:
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml --profile '*' config --no-env-resolution --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml -f compose/compose.russia.yml --profile '*' config --no-env-resolution --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml -f compose/compose.forwarder.yml --profile '*' config --no-env-resolution --quiet
	CADDY_ENV_FILE=caddy.env.example HEADSCALE_CONFIG_FILE=./headscale/config.example.yaml $(DOCKER_COMPOSE_BASE) --env-file /dev/null -f compose/docker-compose.yml -f compose/compose.forwarder.yml -f compose/compose.russia.yml --profile '*' config --no-env-resolution --quiet

check: compose-layout-check

.PHONY: grafana-check
grafana-check:
	DOCKER='$(DOCKER)' CADDY_IMAGE='caddy:$(CADDY_VERSION)' python3 -B scripts/check-grafana.py

include makefiles/observability.mk
