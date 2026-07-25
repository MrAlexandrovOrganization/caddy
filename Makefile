DOCKER_COMPOSE = docker compose

up:
	$(DOCKER_COMPOSE) up -d

down:
	$(DOCKER_COMPOSE) down

logs:
	$(DOCKER_COMPOSE) logs -f

reload:
	$(DOCKER_COMPOSE) exec caddy caddy reload --config /etc/caddy/Caddyfile

.PHONY: up down logs reload
