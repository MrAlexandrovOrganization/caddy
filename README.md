# Caddy + Headscale

HTTPS reverse proxy для Headscale, OpenCode, Grafana и subscription-publisher.
OpenCode и Grafana доступны только из VPN: Caddy проверяет адрес TCP-клиента,
а не `X-Forwarded-For`. Headscale и origin подписок доступны публично.
Авторизация приложений сохраняется.

## Конфигурация конкретной машины

Требуются Docker Engine, Docker Compose v2+ и Make. Версии образов закреплены
в `makefiles/versions.mk`; `make versions` показывает их. Используйте команды через Make.
Для SSH delivery нужен Python 3.9+ со стандартной библиотекой.
`make install` загружает закреплённые runtime и Ruff images; `make format`
форматирует Caddyfile и Python с безопасными исправлениями импортов/линтера.

Перед первым запуском:

```sh
cp caddy.env.example caddy.env
cp headscale/config.example.yaml headscale/config.yaml
chmod 600 caddy.env headscale/config.yaml
# Заполнить оба файла значениями своего окружения.
make check
make up
```

`caddy.env` передаётся внутрь контейнера Caddy через `env_file`. Сам Caddy
подставляет `{$VARIABLE}` при чтении Caddyfile. Compose `.env` не заменяет
этот файл. Домены указываются без схемы, порта и пути.

| Переменная | Назначение |
|---|---|
| `HEADSCALE_DOMAIN` | Основной HTTPS-домен Headscale |
| `HEADSCALE_LEGACY_DOMAIN` | Совместимый вход Headscale на HTTPS-порту 8443 |
| `OPENCODE_DOMAIN` | VPN-only HTTPS для OpenCode |
| `GRAFANA_DOMAIN` | VPN-only HTTPS для Grafana |
| `SUBSCRIPTIONS_DOMAIN` | Публичный HTTPS origin подписок |
| `TRANSCRIBER_WORKERS_DOMAIN` | Public TLS/gRPC endpoint for worker-only RPCs |
| `OPENCODE_ACCESS_POLICY`, `GRAFANA_ACCESS_POLICY` | `vpn_only` (default), or explicit `public_access` to preserve an existing deployment policy |
| `VPN_IPV4_CIDR`, `VPN_IPV6_CIDR` | Разрешённые VPN-подсети, совпадающие с prefixes Headscale |

В `headscale/config.yaml` задаются `server_url`, MagicDNS `base_domain`,
DNS-серверы, VPN-префиксы и `extra_records` с фактическим VPN-IP сервера.
Имена OpenCode/Grafana должны совпадать с `caddy.env`. Headscale получает
готовый YAML: shell-подстановки в нём не выполняются. Пример содержит только
демонстрационные домены, стандартные VPN-подсети и публичные DNS-серверы.
Loopback, wildcard-адреса, служебные DNS aliases и стандартные порты в общих
файлах — часть топологии, а не адреса конкретной машины.

Git игнорирует `caddy.env`, `.env*` и `headscale/config.yaml`. Сертификаты,
ключи и база Headscale живут в Docker volumes; не выгружайте их в репозиторий.
Прежние эксплуатационные заметки остаются в игнорируемом `README.local.md`.
Удаление адресов из текущих файлов не удаляет их из истории Git.

## Управление

- `make check` / `make config-check`: Compose, Caddy validate и Headscale
  configtest с примерами, без загрузки боевой конфигурации. Контейнеры проверки
  изолированы от сети и production volumes. Для загрузки образов нужен интернет.
- `make format`: штатное форматирование Caddyfile.
- `make up`: проверка наличия локальных конфигов, Compose validation и запуск.
  При изменении `caddy.env` нужна эта команда: `reload` не обновляет environment.
- `make reload`: перечитать только Caddyfile работающего контейнера.
- `make logs`: логи; `make down`: остановить стек и удалить его Compose-сети.
  Данные volumes сохраняются. Подключённые приложения могут помешать удалению сетей.
  Для остановки одного прокси используйте `docker compose stop caddy`.

Порты хоста: 80 (ACME), 443 (HTTPS), 8443 (совместимый вход Headscale).
Перед запуском убедитесь, что они свободны. Публичный DNS должен указывать на
сервер для выдачи сертификатов; VPN DNS для закрытых сервисов — на его VPN-IP.
Headscale API доступен внутри сети по `headscale:8080`, admin API Caddy — только
на loopback внутри контейнера.

### Сети

| Сеть | Назначение / upstream |
|---|---|
| `caddy-net` | Headscale и исходящий доступ Caddy/ACME |
| `caddy-opencode-net` | `opencode-ingress:4096` |
| `caddy-grafana-net` | `grafana-ingress:3000` |
| `caddy-publisher-net` | `publisher-ingress:8080` |
| `caddy-transcriber-net` | `transcriber-worker-api:50056`, worker-only gRPC via h2c |
| `caddy-metrics-net` | Prometheus → `caddy-metrics:9180/metrics` |

Все сети, кроме `caddy-net`, внутренние; ими владеет Compose этого проекта.
Приложения подключают их как external. При первом развёртывании запускайте
этот стек раньше потребителей. Метрики привязаны только к metrics-интерфейсу,
порт 9180 не опубликован на хосте.

### Логи и метрики

Caddy пишет JSON в stdout. Access logs содержат `service=caddy`, фиксированный
`site`, status и duration; request, resp_headers и user_id удалены для защиты
URL подписок и заголовков. Error logger также удаляет request и resp_headers.
Не включайте debug/request logging без отдельной проверки маскирования.
Существующий Alloy может собирать stdout через Docker, Prometheus — `/metrics`.

Примеры запросов: Loki `{container="caddy"} | json | site="opencode"`,
Prometheus `up{job="caddy"}` и `rate(caddy_http_requests_total{job="caddy"}[5m])`.
`scripts/verify-observability.py` — отдельная runtime-проверка на VM: ей нужна
переменная окружения `SUBSCRIPTIONS_DOMAIN`, работающие Loki/Prometheus на
loopback и разрешение отправить синтетический запрос в publisher. В `check`
она не входит; не используйте реальные токены для проверки логирования.

### Headscale и exit node

В Tailscale выберите alternate server с URL из `server_url`. Регистрация:

```sh
docker exec headscale headscale nodes register --user '<user>' --key '<registration-key>'
docker exec headscale headscale nodes list
```

Ключи регистрации не сохраняйте в Git. `headscale/99-headscale-exit-node.conf`
содержит пример host sysctl для forwarding; Compose его не применяет.
Настройка exit node, Tailscale Serve, host-маршрутизация и другие VPN-сервисы
управляются отдельно. Проверка конфигурации не доказывает работу VPN-клиента.

## Доставка и переход с прежней конфигурации

CI запускает `make check` на PR, push main и workflow_dispatch. При
`DEPLOY_ENABLED=true` успешная проверка запускает `make remote-deploy` на Russia.
Отдельный ключ ограничен root-installed `scripts/deploy-receiver.py`; SSH host
key закреплён в `VM_KNOWN_HOSTS`. Receiver принимает только probe/deploy и полный
SHA, проверяет clean main, актуальную main и fast-forward, выполняет `make up`
и проверяет Headscale health. Receipt — `~/.local/state/caddy-deploy/current.json`.
Secrets: VM_HOST, VM_USER, VM_SSH_KEY, VM_KNOWN_HOSTS. Установка receiver явная,
не выполняется кодом из следующего push. VM_PROJECT_PATH больше не используется.

Перед первым деплоем этой версии необходимо на VM:

1. Сохранить защищённую резервную копию серверных изменений, конфигурации и
   данных. Локальные и серверные Git-изменения были сверены при подготовке,
   но серверная рабочая копия сама по себе не очищается коммитом на другой машине.
2. Создать приватный `caddy.env` по примеру с действующими адресами и подсетями.
3. Сохранить существующий `headscale/config.yaml`: он больше не публикуется.
   Если он staged как новый файл, снять только его с индекса через
   `git restore --staged -- headscale/config.yaml` (файл на диске сохраняется).
4. Согласовать остальные серверные изменения до `git pull`; не применять
   `reset --hard` или `git clean` к несохранённой рабочей копии.
5. После доставки проверить Headscale health, доступ OpenCode/Grafana через VPN,
   внешний отказ 403 (в том числе с поддельным XFF) и сертификаты.

Выбранное итоговое поведение — VPN-only для OpenCode/Grafana. На момент сверки
серверный Caddyfile разрешал к ним публичный доступ. Локальный коммит сам по себе
это поведение работающего сервера не меняет.

При откате восстановите согласованную пару исходников и приватных конфигов,
проверьте конфигурацию и выполните `make up`. Не удаляйте volumes с данными и
сертификатами. Резервные копии должны храниться вне Git с ограниченным доступом.

## Transcription workers

The worker hostname accepts only POST `/whisper.WorkerService/*` over TLS/HTTP2.
Caddy proxies h2c to the dedicated internal `caddy-transcriber-net` interface;
no backend worker port is published. Each worker authenticates inside the
application with its own bearer token, scoped to its worker ID and leases.
Submission/status RPCs are not exposed by this site. Access/error logs omit
request/response objects including Authorization headers.

Set `TRANSCRIBER_WORKERS_DOMAIN` in the private `caddy.env`. Run this stack first
to create its external network before enabling transcriber's TLS overlay.
Changes to container environment require `make up`, not only `make reload`.
Existing deployments with public OpenCode/Grafana may explicitly preserve that
policy using the two `*_ACCESS_POLICY=public_access` settings; examples continue
to require VPN. Never infer a change of access policy from deployment alone.

### Stash and CLIP workers

The existing worker hostname also routes only POST worker RPCs for
`/stash.processing.v1.WorkerService/*` to `stash:50058` and
`/embed.WorkerService/*` to `clip-embedder:50057` on caddy-transcriber-net.
Each backend authenticates independently using a separate per-worker token
registry. Consumer APIs remain private. No hostname, DNS, access policy or
certificate change is required. The request body limit is 20 MB for these RPCs.

Caddyfile remains the versioned source. make up/reload atomically prepares its
runtime copy under ignored .runtime/caddy and mounts that directory read-only.
This avoids stale single-file bind mounts after Git replaces a file. make up
reloads the proxy after Compose activation; future updates need no restart.
The first transition changes the mount and recreates only Caddy.

### Grafana на другом хосте

`GRAFANA_UPSTREAM` в приватном `caddy.env` переопределяет upstream Grafana.
После переноса центра на WSL используется его tailnet endpoint; политика доступа,
домен и сертификат сохраняются. Переменная применяется через `make up`.
Локальный Docker alias остаётся значением по умолчанию для совместимости.
