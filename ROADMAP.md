# DEVICEHUB ROADMAP — переход на multi-tenant (20 инстансов)

## Контекст

Текущее состояние (ULTIMATE_CONTEXT_DEVICEHUB_2): на одной машине работает полная функциональность для одного эмулятора — audio, mic input/state, camera, GPS, pose, backup, device selection. Архитектурно `audio-capture-mgr` — один процесс, который держит state всех serial'ов в памяти; `camera-writer` — один shared writer на одно `/dev/video0`.

Цель: развернуть на серверном железе (120 vCPU, 240GB RAM, NVMe, 2TB+) **20 одновременных пользователей**, каждый со своим эмулятором, через общую сеть (предположительно LAN, SSL-вопрос отложен).

Решённые проектные вопросы (зафиксированы):
- Capture-процесс **на каждый инстанс** свой (не один shared) — это решает камеру и большинство остальных проблем.
- Все хардкоды переезжают в ENV.
- v4l2loopback per-instance — единственный способ для камеры (gRPC `injectVideo` в эмуляторе **не существует**, проверено по proto-файлу AOSP main).
- Авто-bring-up системы — отдельная задача, делается на финальном этапе.
- Видео из файла в виртуальную камеру — **прямой HTTP-путь**, минуя браузер (для скорости).

---

## Легенда приоритетов

- **P0** — блокеры до прода. Без этого 20 пользователей не запустить.
- **P1** — нужно для нормальной эксплуатации, но можно делать параллельно или сразу после P0.
- **P2** — полезно, не критично для запуска.
- **P3** — отложенное / опциональное / условное.

Внутри тира нумерация показывает рекомендуемый порядок.

---

# P0 — БЛОКЕРЫ ДО ПРОДА

## P0.1 — Cleanup на текущем коде

### Цель
Привести кодовую базу `audio-capture-mgr` в состояние, готовое к тиражированию: модули по доменам, без хардкодов, со структурным логированием, без legacy. Делается **на работающей 1-инстансной системе**, маленькими PR'ами, каждый с проверкой что ничего не сломалось.

### Зачем именно сейчас
Архитектурный рефактор на per-instance (P0.2+) тянет за собой эти изменения по факту. Лучше сделать их отдельно на стабильной базе, чем смешать с большим архитектурным diff'ом и потом не знать, какой именно из тысячи изменений сломал mic-state в среду.

### Подзадачи

#### P0.1.1 — Удалить legacy `/mic/{serial}` endpoint
- Убедиться что фронтенд нигде не зовёт старый `/mic/` путь (только `/mic-rtc/`)
- Удалить WebSocket handler `/mic/{serial}` в `manager.js`
- Удалить связанный FFmpeg-decode код (декодирование WebM/Opus в PCM)
- Acceptance: микрофон в браузере по-прежнему работает на тестовом эмуляторе через WebRTC путь
- Effort: ~1-2 часа
- Это самая безопасная задача и хороший warmup перед более крупными.

#### P0.1.2 — Модуляризация `manager.js`
Один файл сейчас держит: HTTP сервер, WS сервер, маршруты для gps/pose/walk/mic-state/backup, capture-логику, WebRTC peer management, gRPC клиент, и так далее. Разбить на модули **без изменения логики**:

```
audio-infra/audio-capture-manager/
├── index.js              ← entry point: wire-up всего
├── config.js             ← чтение ENV, дефолты, валидация
├── http/
│   ├── server.js         ← Express/raw HTTP
│   ├── routes-gps.js
│   ├── routes-pose.js
│   ├── routes-walk.js
│   ├── routes-backup.js
│   ├── routes-video.js   ← (создать пустой, под P1.1)
│   └── routes-health.js
├── ws/
│   ├── server.js
│   ├── audio-output.js   ← /audio/{serial}
│   ├── camera-rtc.js     ← /camera/{serial} signaling
│   ├── mic-rtc.js        ← /mic-rtc/{serial} signaling
│   ├── mic-state.js      ← /mic-state/{serial} push
│   └── camera-state.js   ← /camera-state/{serial} push
├── capture/
│   ├── audio-capture.js  ← FFmpeg PA monitor → Opus/WebM
│   ├── camera-writer.js  ← persistent v4l2 writer (уже есть)
│   ├── pulse-monitor.js  ← PAMonitor для авто-маршрутизации QEMU
│   └── grpc-client.js    ← gRPC connection management
├── domain/
│   ├── gps.js            ← keepalive logic
│   ├── pose.js
│   ├── walk-simulator.js (уже есть)
│   ├── pose-scenario.js  (уже есть)
│   └── backup-logical.js (уже есть)
├── adb/
│   └── dumpsys-parser.js ← парсинг RecordActivityMonitor + CameraClients
└── log.js                ← структурное логирование (P0.1.4)
```

- Никакая логика не меняется — чистый перенос
- После каждого модуля ручной smoke test всех фич
- Acceptance: все фичи работают идентично; стек поднимается; нет регрессий в логах
- Effort: ~1-2 дня
- Ловушки: импортные зависимости. Лучше делать инкрементально (один модуль за раз), а не одним большим коммитом.

#### P0.1.3 — Выкорчевать хардкоды в ENV

Текущие хардкоды, которые надо переменными:

| Хардкод | ENV | Дефолт |
|---|---|---|
| `emulator-1:5555` (ADB) | `EMULATOR_ADB_HOST` + `EMULATOR_ADB_PORT` | `emulator-1` + `5555` |
| `8554` (gRPC) | `EMULATOR_GRPC_HOST` + `EMULATOR_GRPC_PORT` | (то же) + `8554` |
| `/dev/video0` | `CAMERA_V4L2_DEVICE` | уже есть |
| `emu_audio_1` | `PULSE_SINK` | уже есть |
| `emu_mic_1` | `PULSE_SOURCE` | уже есть |
| `emulator-1:5555` как serial | `INSTANCE_SERIAL` | (соберётся из ADB host:port) |
| Backup dir | `BACKUP_DIR` | уже есть |
| HTTP port | `MANAGER_PORT` | уже есть |

- Дефолты сохранить, чтобы текущая команда `docker run` не сломалась
- Все эти значения читаются один раз в `config.js` при старте, остальной код берёт из `config.X`
- Acceptance: запуск с дефолтами идентичен текущему; запуск с другими значениями работает (тестируется в P0.2 на тестовом инстансе)
- Effort: ~3-4 часа

#### P0.1.4 — Структурное логирование

- Подключить `pino` (или аналог)
- Каждый лог-event имеет поле `serial`, `module`, `level`, `msg`, и опциональные структурные поля
- Заменить все `console.log` / `console.error` на `log.info` / `log.error`
- Acceptance: лог-вывод парсится как JSON; в каждой записи есть `serial`
- Effort: ~2-3 часа
- Ловушки: не залогировать что-нибудь чувствительное (например, raw audio буферы или большие PCM-блобы). Запрос — заранее пройтись и заменить такие места на размер/метаинформацию.

### Общий acceptance для P0.1
- Все 4 подзадачи закрыты
- На текущем стенде с одним эмулятором ВСЕ фичи работают идентично, никакой регрессии
- Контейнер `audio-capture-mgr` собирается, поднимается, работает
- Логи структурированные, читаемые, парсятся

### Effort: ~3-4 рабочих дня

---

## P0.2 — Прототип per-instance на 1 инстанс

### Цель
Построить **один полный slice** новой архитектуры рядом со старым стеком. Один эмулятор + один capture + свой `/dev/videoN` + свои pulse sink/source + правильно сконфигурированные ENV. Доказать что все фичи работают в новой схеме до того, как тиражировать.

### Зачем именно сейчас
До этого момента всё было по чертежам. Прототип проверяет в реальности: что unique pulse-имена работают через shared `pulse-hub`, что WebRTC peer не путается с уже работающим, что мы ничего не пропустили в ENV, что v4l2 устройство видится корректно эмулятором.

### Подзадачи

#### P0.2.1 — Расширить v4l2loopback
- `sudo modprobe -r v4l2loopback`
- `sudo modprobe v4l2loopback devices=20 video_nr=20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39 exclusive_caps=0`
- Проверить `ls /dev/video*`
- Зафиксировать как systemd-unit или modprobe.d-конфиг чтобы переживало ребут

#### P0.2.2 — Запуск тестового capture на /dev/video20

```bash
docker run -d \
  --name audio-capture-mgr-test1 \
  --network devicehub_devicehub \
  --group-add video \
  -e MANAGER_PORT=7601 \
  -e PA_SERVER=unix:/run/pulse/shared.sock \
  -e PULSE_SINK=emu_audio_test1 \
  -e PULSE_SOURCE=emu_mic_test1 \
  -e EMULATOR_ADB_HOST=emulator-test1 \
  -e EMULATOR_ADB_PORT=5555 \
  -e EMULATOR_GRPC_HOST=emulator-test1 \
  -e EMULATOR_GRPC_PORT=8554 \
  -e INSTANCE_SERIAL=emulator-test1:5555 \
  -e CAMERA_V4L2_DEVICE=/dev/video0 \
  -e BACKUP_DIR=/backups \
  -v devicehub_pulse-sock:/run/pulse \
  -v ~/caller/devicehub-backups:/backups \
  --device /dev/video20:/dev/video0 \
  -p 7601:7601 \
  -p 40020-40030:40020-40030/udp \
  --restart unless-stopped \
  audio-capture-mgr
```

#### P0.2.3 — Запуск тестового эмулятора
```bash
docker run -d \
  --name emulator-test1 \
  --hostname emulator-test1 \
  --network devicehub_devicehub \
  --device /dev/kvm \
  --device /dev/video20:/dev/video0 \
  --group-add video \
  -e EMULATOR_DEVICE="Samsung Galaxy S10" \
  -e WEB_VNC=true \
  -e PULSE_SERVER=unix:/run/pulse/shared.sock \
  -e PULSE_SINK=emu_audio_test1 \
  -e PULSE_SOURCE=emu_mic_test1 \
  -e QEMU_AUDIO_DRV=pa \
  -e "EMULATOR_ADDITIONAL_ARGS=-allow-host-audio -grpc 8554 -camera-front webcam0" \
  -v devicehub_pulse-sock:/run/pulse \
  -p 6081:6080 \
  -p 5557:5555 \
  --restart unless-stopped \
  budtmo/docker-android:emulator_13.0
```

(Порядок: сначала capture с writer'ом → потом эмулятор. Это критично для камеры.)

#### P0.2.4 — nginx маршрут для тестового slice'а
Добавить в `nginx.conf` маршруты:
- `/manager-api-test1/*` → `audio-capture-mgr-test1:7601`
- `/audio-test1/{serial}` → WS на тот же
- `/camera-test1/{serial}` → WS
- `/mic-rtc-test1/{serial}` → WS
- и т.д.

(Это grunt work, но в P0.5 это будет переделано в общую серверу маршрутизацию по serial — пока главное проверить что путь работает.)

#### P0.2.5 — End-to-end smoke test всех фич на тестовом slice

Проверить **в новом slice'е** что работает:
- [ ] audio output: эмулятор → браузер
- [ ] mic input: браузер → эмулятор
- [ ] mic-state: жёлтый/зелёный/серый кнопки корректно меняются
- [ ] camera input: браузер webcam → видно в Camera-app эмулятора
- [ ] camera-state: индикатор активной камеры
- [ ] device selection: смена камеры/мика/динамика
- [ ] GPS: координаты
- [ ] pose: ориентация
- [ ] backup: создать + восстановить
- [ ] **Старый стек продолжает работать** одновременно (это сразу проверка multi-tenant в малом)

### Acceptance для P0.2
- Все 10 пунктов smoke-теста зелёные
- Старый стек работает рядом, ничего не сломалось
- Никаких pulse / v4l2 / порт-конфликтов

### Effort: ~2-3 дня

### Ловушки
- pulse sink/source имена должны быть уникальны — `MAX_EMU_SINKS=20` в pulse-hub уже учтён, но проверить что новые имена реально создаются
- gRPC port 8554 идёт **внутри docker network** через имя контейнера, не через хостовые порты — поэтому одинаковый port внутри разных контейнеров не конфликтует
- WebRTC UDP диапазон **должен** быть разный у каждого capture — иначе host-port-binding будет конфликтовать
- `/dev/videoN` хоста маппится в контейнер как `/dev/video0` — внутри контейнера всегда video0, снаружи разные

---

## P0.3 — v4l2loopback и camera-writer per-instance

### Цель
Закрыть архитектурный блокер из ULTIMATE_CONTEXT 9.9. Каждый инстанс держит свой `/dev/videoN`, свой writer-процесс, свой WebRTC video track — никаких shared resources на уровне камеры.

### Зачем именно сейчас
По факту это уже частично сделано в P0.2 (на 1 инстансе), но нужно убедиться что:
1. На N инстансах нет race condition при стартовом порядке
2. Нет proceeds где writer падает и забирает `/dev/videoN` с собой
3. Recovery при крэше capture корректно освобождает device

### Подзадачи

#### P0.3.1 — Lifecycle camera-writer'а
- Writer должен переоткрывать `/dev/videoN` если оно вдруг недоступно (например, эмулятор перезапустили)
- Writer должен корректно отдавать device при завершении (трогать close)
- Healthcheck: писатель пишет тестовый I420 frame каждую секунду как fallback (чтобы эмулятор всегда видел "что-то", даже если WebRTC отключён)

#### P0.3.2 — Тестовая нагрузка на 5 инстансах
- modprobe с `devices=20`
- Поднять 5 capture + 5 эмуляторов параллельно
- На все 5 включить камеру одновременно из 5 браузерных вкладок
- Acceptance: все 5 работают параллельно, нет дрейфа FPS, нет крэшей

#### P0.3.3 — Документировать host-setup
- Скрипт `scripts/host-setup.sh` который:
  - проверяет `/dev/kvm`
  - загружает v4l2loopback с правильными параметрами
  - проверяет что pulse-сокет доступен
  - проверяет докер-сеть
  - выводит статус в человекочитаемом виде

### Acceptance
- 5 параллельных инстансов с включенными камерами стабильно работают
- Перезапуск любого capture не аффектит соседей
- host-setup.sh идемпотентен

### Effort: ~1 день

---

## P0.4 — Шаблонизация compose на N инстансов

### Цель
Заменить ручной `docker run` на декларативную конфигурацию: один YAML описывает желаемые инстансы, генератор рендерит compose-файл, `docker compose up` всё поднимает.

### Зачем именно сейчас
Без этого 20 инстансов превращаются в 40 ручных `docker run` команд с риском человеческого фактора в каждой.

### Подзадачи

#### P0.4.1 — Формат `instances.yaml`

```yaml
# instances.yaml — описание инстансов
shared:
  pulse_hub: true
  devicehub_stack: true
  v4l2_base: 20  # /dev/video20 .. /dev/video(20+N-1)

instances:
  - id: 1
    serial: "emulator-1:5555"
    emulator_image: "budtmo/docker-android:emulator_13.0"
    device_profile: "Samsung Galaxy S10"
    # auto-derived:
    # pulse_sink = emu_audio_1
    # pulse_source = emu_mic_1
    # v4l2_device = /dev/video20
    # manager_port = 7600 (host) → 7600 (container)
    # vnc_port = 6080 (host) → 6080 (container)
    # adb_port = 5555 (host) → 5555 (container)
  - id: 2
    serial: "emulator-2:5555"
    # ... etc
```

#### P0.4.2 — Генератор `scripts/generate-compose.js`
- Читает `instances.yaml`
- Рендерит `docker-compose.generated.yaml` с N сервисами `emulator-N` и N сервисами `audio-capture-mgr-N`
- Делает корректное распределение портов (избегая конфликтов)
- Делает корректное распределение `/dev/videoN`
- Учитывает зависимости (`depends_on: pulse-hub`)

#### P0.4.3 — Compose orchestration
- `docker compose -f docker-compose-prod.yaml -f docker-compose.generated.yaml up -d`
- Регенерация при изменении `instances.yaml`: `make regen && docker compose up -d`

### Acceptance
- `instances.yaml` с N=10 → `compose up -d` поднимает 10 инстансов
- Все 10 проходят smoke test из P0.2.5
- Изменение `instances.yaml` (добавили инстанс 11) → регенерация → новый инстанс поднимается, старые не дёргаются

### Effort: ~1-2 дня

### Ловушки
- Compose не любит динамическое количество сервисов "на лету" — приходится регенерировать. Это нормально, но имей в виду что `up --scale` тут не подойдёт (у каждого инстанса слишком много уникальных полей).
- v4l2 mapping на хостовый device — нельзя через volumes, только через `devices:`. Проверить что compose это правильно рендерит.

---

## P0.5 — Per-serial routing в nginx

### Цель
Один URL-namespace для всех инстансов. Маршрутизация по `serial` в URL → нужный capture-контейнер.

### Зачем именно сейчас
В P0.2 мы временно сделали `/manager-api-test1/`, `/audio-test1/` и т.д. — это не масштабируется. Финальная схема: `/manager-api/{endpoint}/{serial}/...` → определяется upstream.

### Подзадачи

#### P0.5.1 — Маппинг `serial → upstream`

Поскольку serial детерминированный (`emulator-N:5555`), upstream детерминирован тоже (`audio-capture-mgr-N:7600`). Несколько вариантов реализации:

**Вариант A: nginx `map` directive + regex extract**
```nginx
map $arg_serial $capture_upstream {
    default                     "audio-capture-mgr-1:7600";
    "~^emulator-(\d+):5555$"    "audio-capture-mgr-$1:7600";
}
```
Чистый nginx, работает. Но переезжает на serial из URL path, не arg — нужно правильно вытащить.

**Вариант B: openresty / lua-скрипт**
Динамический lookup (например, через redis с маппингом). Гибче, но добавляет компонент.

**Вариант C: Traefik вместо nginx**
Docker-label-based routing из коробки. Каждый capture-контейнер регистрируется лейблом `traefik.http.routers.capture-N.rule=PathPrefix(/manager-api) && QueryRegexp(serial, ^emulator-N:5555$)`. Гибко, но переезд с nginx — отдельная работа.

Я бы попробовал Вариант A, и если не взлетит для всех endpoint'ов — Traefik.

#### P0.5.2 — Маршруты, которые надо мигрировать
- HTTP: `/manager-api/{api}/{serial}/...` → `audio-capture-mgr-N:7600`
- WS audio: `/audio/{serial}` → `audio-capture-mgr-N:7600`
- WS camera signaling: `/camera/{serial}` → `audio-capture-mgr-N:7600`
- WS mic-rtc: `/mic-rtc/{serial}` → ...
- WS mic-state: `/mic-state/{serial}` → ...
- WS camera-state: `/camera-state/{serial}` → ...

Все они уже принимают `serial` как параметр URL, осталось только смаршрутить.

#### P0.5.3 — Стандартный DeviceHub-стек не трогаем
nginx остаётся точкой входа для DeviceHub-app, api, websocket — там роутинг по path (`/api/*`, `/socket.io/*`) идёт на стандартные сервисы. Только `/manager-api/*` и `/audio|camera|mic*` маршруты переключаются на capture-инстансы.

### Acceptance
- 10 инстансов в `instances.yaml`
- Из браузера юзер выбирает любой эмулятор → все его фичи работают через стандартный URL без специфики инстанса
- Нет ручной регистрации upstream'ов в nginx — генерация автоматическая

### Effort: ~2-3 дня

### Ловушки
- WebSocket требует `proxy_http_version 1.1` + `Upgrade`/`Connection` header — это уже есть в текущем nginx, но проверить
- Долгие WS соединения (`proxy_read_timeout 3600s`) надо сохранить для camera/mic/audio
- Если переходить на Traefik — сертификаты вынести из nginx тоже
- Если backup делается долго (60+ секунд), и nginx таймаутит — увеличить `proxy_request_buffering off` для upload-эндпоинтов (это особенно важно для P1.1 где грузятся видео-файлы)

---

## P0.6 — Авторизация в media API

### Цель
Закрыть дыру multi-tenant: сейчас любой пользователь может дёрнуть `/api/backup/{чужой_serial}/restore` и испортить чужой инстанс. Нужна проверка владения.

### Зачем именно сейчас
До прода это **обязательно**. Без проверки авторизации multi-tenant не multi-tenant, а "20 человек на одном эмуляторе с гонками".

### Подзадачи

#### P0.6.1 — Найти концепт владения в DeviceHub
DeviceHub upstream имеет понятие `Device.using.email` (кто сейчас использует устройство). Нужно посмотреть, как это представлено в auth flow и пробросе в downstream-сервисы.

#### P0.6.2 — Передавать identity в `audio-capture-mgr`
Один из вариантов:
- nginx после auth добавляет в проксируемый запрос header `X-User: <email>` или `X-Auth-Token: <jwt>`
- `audio-capture-mgr` middleware проверяет: для запроса с `serial=X` user должен быть текущим использователем устройства X
- Список "кто использует X" нужно где-то держать — либо запрашивать у DeviceHub-api, либо иметь in-memory кэш с TTL обновлением

#### P0.6.3 — Применить middleware ко всем endpoint'ам
- `/api/gps/{serial}` (POST/DELETE)
- `/api/pose/{serial}` (POST)
- `/api/walk/{serial}/*`
- `/api/backup/{serial}` (POST)
- `/api/backup/{serial}/restore` (POST)
- `/api/backup/{serial}/status` (GET) — можно мягче
- `/api/video/{serial}/play` (POST) — будущее, P1.1
- WS: signaling endpoints тоже должны проверять (но через query param token или handshake)

#### P0.6.4 — Audit log
Все попытки доступа (успешные и нет) логируются с user+serial+endpoint. Для разбора инцидентов и отладки.

### Acceptance
- Пользователь A не использует эмулятор-7, дёргает `/api/gps/emulator-7:5555` → 403 Forbidden
- Пользователь A использует эмулятор-3, дёргает `/api/gps/emulator-3:5555` → работает
- Логи фиксируют попытки

### Effort: ~2-3 дня

### Ловушки
- WS handshake авторизация — токен в query string (как самый простой) или в первом сообщении? Проверить что фронт корректно его передаёт
- Что делать если пользователь отдал устройство во время операции (например, во время backup)? Минимум — операция доводится до конца, новые операции от старого пользователя отвергаются.

---

## P0.7 — Авто-bring-up

### Цель
Скрипт/сервис, который сам поднимает весь стек в правильном порядке, с healthcheck'ами и таймаутами. Закрывает критичную проблему "camera writer должен подняться ДО эмулятора" автоматически.

### Зачем именно сейчас
Без этого ты в 3 часа ночи будешь руками разбираться, почему 5 эмуляторов из 20 не видят камеру.

### Подзадачи

#### P0.7.1 — Этапы bring-up
1. **Pre-flight**: проверка `/dev/kvm`, KVM virt включена (`kvm-ok`), v4l2loopback модуль загружен с нужным `devices=`, docker daemon up, права доступа
2. **Network**: `docker network create devicehub_devicehub` (если нет)
3. **Pulse-hub**: поднять, дождаться что сокет `/run/pulse/shared.sock` появился
4. **DeviceHub-стек**: `docker compose -f docker-compose-prod.yaml up -d`, дождаться healthchecks (mongo, api, ws, app, nginx, provider, auth, storage)
5. **Per-instance, в цикле для каждого инстанса**:
   1. Capture-N контейнер up
   2. Дождаться что capture HTTP отвечает на `/api/health`
   3. Дождаться что camera-writer открыл `/dev/videoN` и пишет тестовые frames (проверка `v4l2-ctl --device=/dev/videoN -V`)
   4. Поднять emulator-N
   5. Дождаться что ADB-emulator-N reachable (`adb -s emulator-N:5555 shell echo ok`)
   6. Дождаться что эмулятор boot completed (`adb shell getprop sys.boot_completed`)
6. **Post-bring-up**: `docker restart devicehub-provider` чтобы он подхватил новые эмуляторы
7. **Sanity check**: для каждого инстанса дёрнуть `/api/gps/{serial}` (заведомо безопасный read-only health endpoint) и проверить что отвечает

#### P0.7.2 — Реализация
Bash или Node.js скрипт. Bash проще, Node даёт лучше структурный код для retry-логики и healthcheck-параллелизма. Я бы делал Node, потому что это всё равно проект на Node.

```
scripts/bring-up.js
scripts/teardown.js
scripts/restart-instance.js  ← teardown+bring-up одного инстанса (например, для recovery)
```

#### P0.7.3 — Идемпотентность
- Запуск bring-up на уже работающем стеке должен быть **no-op** или довести до желаемого состояния (не падать)
- Запуск teardown на пустом — тоже no-op
- Вытекает: каждый шаг должен проверять "а оно уже сделано?"

#### P0.7.4 — Логирование
- Каждый шаг с временной меткой
- При фейле — какой именно health-check не прошёл, какой контейнер виноват
- Финальный отчёт: N инстансов готовы за T времени

### Acceptance
- Чистый сервер: `./scripts/bring-up.js` поднимает 20 инстансов без вмешательства за разумное время
- Smoke-test в браузере: 20 устройств видны в DeviceHub UI, на каждом работают все фичи
- `./scripts/teardown.js` гасит всё чисто
- Запуск bring-up второй раз подряд — no-op

### Effort: ~2-3 дня

### Ловушки
- Эмулятор boot занимает 60-180 секунд первого запуска. Таймауты должны учитывать.
- Параллельный старт 20 эмуляторов одновременно может перегрузить хост — лучше batch'ами по 4-5 с задержкой
- `docker restart devicehub-provider` НЕ должен прибивать ничего критичного — проверить порядок

---

# P1 — НУЖНО, ПАРАЛЛЕЛЬНО ИЛИ СРАЗУ ПОСЛЕ P0

## P1.1 — Видео из файла напрямую в виртуальную камеру (bypass browser)

### Цель
Дать пользователю путь: **файл на его машине → виртуальная камера выбранного инстанса**, без открытия браузера и без WebRTC.

### Архитектура (новая, не через браузер)

```
User's machine                                         Server
┌────────────────────┐                  ┌──────────────────────────────┐
│ video.mp4          │                  │ nginx                        │
│                    │ HTTP POST        │   /manager-api/video/{ser}/  │
│ curl / CLI / app   │ ───────────────► │   play (multipart or stream) │
│                    │                  │                              │
│                    │                  │   ↓ routed by serial         │
└────────────────────┘                  │                              │
                                        │ audio-capture-mgr-N          │
                                        │   POST /api/video/.../play   │
                                        │     ↓                        │
                                        │   spawn FFmpeg               │
                                        │   ffmpeg -re -i pipe:0       │
                                        │     -f rawvideo              │
                                        │     -pix_fmt yuv420p         │
                                        │     -s WxH -                 │
                                        │     ↓ YUV420P frames         │
                                        │   camera-writer.js           │
                                        │     switches source:         │
                                        │     WebRTC → file            │
                                        │     ↓                        │
                                        │   /dev/videoN                │
                                        │     ↓                        │
                                        │   emulator-N camera          │
                                        └──────────────────────────────┘
```

### Ключевые принципы
- **Single owner of /dev/videoN**: camera-writer держит device, источник кадров — пluggable. WebRTC и file-playback не могут писать одновременно.
- **Streaming, не upload-then-play**: bytes идут от клиента к FFmpeg напрямую через pipe, FFmpeg начинает декодить как только пришли первые кадры. Никакого "сначала загрузить, потом играть".
- **Браузер вообще не нужен**: API доступен через любой HTTP-клиент.

### Подзадачи

#### P1.1.1 — Pluggable source в camera-writer
Рефактор `camera-writer.js` так, чтобы у него был **активный источник кадров**:

```javascript
class CameraWriter {
  constructor(devicePath) { ... }
  setSource(source) { /* graceful switch */ }
  // sources implement: start(), stop(), event 'frame' (Buffer YUV420P)
}
```

Источники:
- `WebRTCSource` — текущий (RTCVideoSink → frame events)
- `FileStreamSource` — новый: spawns FFmpeg, читает stdout
- `IdleSource` — fallback: пишет статичный "no signal" frame чтобы эмулятор всегда видел что-то

При смене источника — graceful: дождаться flush последнего frame'а, потом start нового.

#### P1.1.2 — HTTP API endpoints

```
POST /api/video/{serial}/play
  Content-Type: application/octet-stream  (for streaming raw bytes)
  body: raw video file bytes
  Query: ?loop=true&fps=30
  Returns: {playId, status: "playing"}

POST /api/video/{serial}/stop
  Returns: {status: "stopped"}

GET /api/video/{serial}/status
  Returns: {state: "playing"|"idle", playId?, currentSource: "webrtc"|"file"|"idle", elapsedSec?}
```

Поведение:
- POST `/play` пока другое видео играет — заменяет текущее
- POST `/play` пока WebRTC активен — отбирает source у WebRTC, WebRTC peer получает уведомление что track "приостановлен внешним источником" (UI показывает плашку)
- При завершении видео (если не loop) — source возвращается к WebRTC если он подключён, иначе к Idle
- `loop=true` — FFmpeg перезапускается на end (`-stream_loop -1` если файл целиком, иначе ручная ре-инициализация)

#### P1.1.3 — Клиентские примеры

**curl streaming**:
```bash
curl -X POST \
  --data-binary @video.mp4 \
  "https://devhub.local/manager-api/video/emulator-7:5555/play?loop=true"
```

**curl multipart (если ngx требует)**:
```bash
curl -X POST \
  -F "file=@video.mp4" \
  -F "loop=true" \
  "https://devhub.local/manager-api/video/emulator-7:5555/play"
```

**Маленький CLI (опционально)**:
```bash
devhub-stream --instance emulator-7 --loop video.mp4
```
(Просто обёртка над curl с авторизацией и удобной опцией выбора инстанса. Можно отложить.)

#### P1.1.4 — UI индикация (опциональная мелочь)
В UI рядом с camera-toggle показывать состояние:
- WebRTC активен → обычная камера (зелёная)
- File-playback активен → значок "плёнки" с именем/play-id, кнопка Stop
- Idle → серая

#### P1.1.5 — Resource accounting
- 20 одновременных FFmpeg-процессов с декодом видео = заметная CPU нагрузка
- На 120 vCPU нормально, но логировать использование на инстанс

### Acceptance
- `curl --data-binary @file.mp4 ...` начинает играть видео в эмуляторе через 1-2 секунды
- Tested на mp4, h264, webm, mov, av1
- Авто-loop работает
- Stop работает
- Возврат к WebRTC после file-playback работает
- 5 инстансов одновременно играют разные видео — нет регрессий

### Effort: ~2-3 дня
### Зависит от: P0.1 (модулярный код), P0.5 (роутинг по serial), P0.6 (авторизация)
### Можно начинать (только UI часть) уже на текущем коде, но основная работа — после P0.

### Ловушки
- nginx по умолчанию буферизирует request body → большие POST уходят в /tmp на nginx → задержка. Включить `proxy_request_buffering off` для `/manager-api/video/`
- FFmpeg `-re` (real-time pacing) важен — иначе он отдаёт кадры со скоростью CPU, а не fps видео
- Pixel format / разрешение должны совпадать с тем, что ожидает camera-writer (YUV420P, фикс. размер). FFmpeg делает scale/format conversion прозрачно.
- Если файл в формате с переменным fps — мы внутренне нормализуем к фикс fps (30)
- При `loop=true` плавный re-loop требует FFmpeg `-stream_loop -1`. Без него будет видимая пауза.

---

## P1.2 — Pulse-hub нагрузочный тест

### Цель
Убедиться что shared `pulse-hub` с `MAX_EMU_SINKS=20` реально держит 20 параллельных Opus-encoder + 20 PA source-output без деградации.

### Подзадачи
- Симулировать 20 эмуляторов (либо реально поднять, либо моки которые шумят в свои sink'и)
- Снять метрики CPU/memory pulse-hub процесса
- Проверить latency и потери

### Acceptance
- Все 20 audio-стримов идут в браузер без glitches
- pulse-hub потребляет приемлемые ресурсы (< 1 GB RAM, < 4 cores)

### Effort: ~0.5-1 день
### Когда: сразу после P0.4

---

## P1.3 — Backup queue / rate-limit

### Цель
Чтобы 20 пользователей одновременно не уронили дисковое I/O своими backup'ами.

### Подзадачи
- Centralized semaphore через файловую блокировку на shared backup-storage (или через redis если уже есть)
- Max parallel backups = 3-5
- Очередь ожидания с прогрессом для пользователя ("ваш backup в очереди, 2 впереди")

### Effort: ~0.5-1 день
### Когда: сразу после P0.6

---

# P2 — ПОЛЕЗНО, НЕ КРИТИЧНО

## P2.1 — Dropdown clipping fix в device selector
Известный мелкий UI bug. Effort: ~1-2 часа.

## P2.2 — Централизованные логи
Loki / journald / отдельный log-aggregator с тегами `serial`, `user`, `module`. Без этого отлаживать 20 параллельных пользователей будет больно.
Effort: ~1 день.

## P2.3 — Healthchecks и базовый monitoring
Минимум — статус контейнеров в одном dashboard'е. Метрики: per-instance uptime, последний backup, активные WebRTC, FPS камеры, memory эмулятора. Prometheus + Grafana — стандарт.
Effort: ~1-2 дня.

## P2.4 — Эксперимент с `streamScreenshot` как замена minicap
gRPC у каждого эмулятора свой → ложится в multi-instance естественно. Может дать лучший latency / качество screen feed. Делать **только** если текущий screen feed не устраивает.
Effort: ~1-2 дня.

## P2.5 — `useradd -u 1000` в Dockerfile audio-capture-manager
Уберёт необходимость `chmod 777` на backup-каталоге.
Effort: ~30 минут.

---

# P3 — ОТЛОЖЕННОЕ / ОПЦИОНАЛЬНОЕ

## P3.1 — TURN-сервер (coturn)
Нужен только если пользователи будут подключаться из разных сетей через интернет. В LAN не нужен.

## P3.2 — Real SSL (Let's Encrypt + домен)
То же условие: для интернета нужен, для LAN — self-signed достаточно.

## P3.3 — Видео из файла, headless mode (Путь Б из обсуждения)
Server-side: upload файла → хранение на сервере → playback с возможностью переиграть на разных инстансах без ре-аплоада. Делать **только если** P1.1 окажется недостаточным (например, нужно регрессионно проиграть один файл на 20 инстансах для тестирования).

## P3.4 — k8s/Nomad оркестратор
Если compose-генератор + bring-up скрипт перестанут справляться. На одной ноде с фиксированным пулом 20 — compose реально хватит.

## P3.5 — Multi-host scaling
v4l2loopback и pulse-hub — host-scoped ресурсы. Расти за пределы одного сервера — отдельная архитектурная работа. Если 240GB / 120 потоков мало — тогда и подумаем.

---

# С ЧЕГО НАЧИНАЕМ

## Шаг 1: P0.1.1 — удалить legacy `/mic/{serial}`

Самая безопасная и маленькая задача из cleanup. Хороший warmup чтобы убедиться что процесс рефакторинга работает: меняем, тестируем, коммитим.

Конкретные шаги:
1. `grep -rn "/mic/" ui/src/` — убедиться что фронт нигде не зовёт старый путь
2. Найти WS handler `/mic/{serial}` в `manager.js`
3. Удалить его + связанный FFmpeg-decode + любые helper-функции которые больше не используются
4. Пересобрать `audio-capture-mgr`, протестировать что mic работает через WebRTC путь
5. Commit: `chore: remove legacy /mic/{serial} websocket endpoint`

После этого — P0.1.2 (модуляризация manager.js), это уже основной кусок работы.

## Параллельный трек
Если устанешь от рефактора — переключайся на P1.1 (видео из файла). Только UI часть (P1.1.4) можно делать прямо сейчас на любом коде, серверная часть (P1.1.1, P1.1.2) ждёт когда P0.1 закроется.

---

# ИТОГОВЫЙ ОБЪЁМ РАБОТ

| Этап | Effort | Кумулятивно |
|------|--------|-------------|
| P0.1 (cleanup) | 3-4 дня | 4 дня |
| P0.2 (прототип 1 инстанс) | 2-3 дня | 7 дней |
| P0.3 (v4l2 per-instance) | 1 день | 8 дней |
| P0.4 (compose шаблон) | 1-2 дня | 10 дней |
| P0.5 (nginx routing) | 2-3 дня | 13 дней |
| P0.6 (авторизация) | 2-3 дня | 16 дней |
| P0.7 (bring-up) | 2-3 дня | 19 дней |
| **P0 итого** | | **~3 рабочих недели** |
| P1.1 (видео из файла) | 2-3 дня | 22 дня |
| P1.2 (pulse load test) | 0.5-1 день | 23 дня |
| P1.3 (backup queue) | 0.5-1 день | 24 дня |
| **P0 + P1 итого** | | **~5 рабочих недель** |

Это оценка на одного человека без перерывов. С учётом отладки, тестирования, и того что это побочный проект — реально умножать на 1.5-2.

---

*Документ живой, обновляется по мере прогресса. Сверять с ULTIMATE_CONTEXT_DEVICEHUB_2 — там фундамент, тут план движения.*
