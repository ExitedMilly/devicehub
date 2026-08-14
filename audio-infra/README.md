# DeviceHub Audio Streaming

Live audio из Android-эмуляторов в Docker через веб-интерфейс DeviceHub.

## Что это

Расширение DeviceHub, добавляющее real-time аудио от эмуляторов в браузер. Пользователь открывает устройство в DeviceHub — и слышит звук. Без дополнительных действий, кнопок или настроек.

## Архитектура

```
Android Emulator (Docker)
  └→ QEMU audio output
      └→ PulseAudio shared daemon (pulse-hub)
          └→ null-sink "emu_audio_N" (изолированный на каждый эмулятор)
              └→ .monitor source
                  └→ FFmpeg (PCM → Opus/WebM)
                      └→ audio-capture-manager (WebSocket)
                          └→ nginx (wss:// proxy)
                              └→ Browser (MediaSource Extensions)
```

Auto-discovery: при появлении нового эмулятора PA monitor автоматически обнаруживает QEMU sink-input, направляет аудио в правильный null-sink и запускает FFmpeg capture. При отключении эмулятора — автоматически останавливает.

## Быстрый старт

### Требования

- Работающий DeviceHub (`docker-compose-prod.yaml`)
- Linux с KVM (`/dev/kvm`)
- Docker и docker compose

### Запуск

```bash
cd ~/caller/devicehub

# 1. Собрать аудио-образы
docker build -t pulse-hub:local ./audio-infra/pulse-hub/
docker build -t audio-capture-mgr:local ./audio-infra/audio-capture-manager/

# 2. Собрать DeviceHub с аудио UI
docker build -t vkcom/devicehub .

# 3. Запустить pulse-hub (отдельно, без healthcheck зависимости)
docker volume create devicehub_pulse-sock

docker run -d --name pulse-hub \
    --network devicehub_devicehub \
    -v devicehub_pulse-sock:/run/pulse \
    -e MAX_EMU_SINKS=20 \
    --no-healthcheck \
    --restart=unless-stopped \
    pulse-hub:local

# Подождать 15 секунд
sleep 15

# 4. Запустить audio-capture-manager
docker run -d --name audio-capture-mgr \
    --network devicehub_devicehub \
    -v devicehub_pulse-sock:/run/pulse:ro \
    -e MANAGER_PORT=7600 \
    -e PA_SERVER=unix:/run/pulse/shared.sock \
    -p 7600:7600 \
    --restart=unless-stopped \
    audio-capture-mgr:local

# 5. Запустить эмулятор
docker run -d --name emulator-1 \
    --hostname emulator-1 \
    --device /dev/kvm \
    --network devicehub_devicehub \
    -v devicehub_pulse-sock:/run/pulse \
    -p 6080:6080 \
    -p 5555:5555 \
    -e EMULATOR_DEVICE="Samsung Galaxy S10" \
    -e WEB_VNC=true \
    -e PULSE_SERVER=unix:/run/pulse/shared.sock \
    -e PULSE_SINK=emu_audio_1 \
    --restart=unless-stopped \
    budtmo/docker-android:emulator_13.0

# 6. Перезапустить DeviceHub сервисы с новым образом
docker compose \
    -f docker-compose-prod.yaml \
    --env-file scripts/variables.env \
    up -d --force-recreate \
    devicehub-app devicehub-websocket devicehub-provider devicehub-auth devicehub-api devicehub-nginx

# 7. Подключить эмулятор к ADB
docker exec adbd adb connect emulator-1:5555
```

После этого откройте DeviceHub в браузере, выберите эмулятор — звук работает автоматически.

### Добавление эмуляторов

Для каждого нового эмулятора:

```bash
# N = номер эмулятора (2, 3, 4...)
docker run -d --name emulator-N \
    --hostname emulator-N \
    --device /dev/kvm \
    --network devicehub_devicehub \
    -v devicehub_pulse-sock:/run/pulse \
    -p $((6080+N-1)):6080 \
    -p $((5555+N-1)):5555 \
    -e EMULATOR_DEVICE="Samsung Galaxy S10" \
    -e WEB_VNC=true \
    -e PULSE_SERVER=unix:/run/pulse/shared.sock \
    -e PULSE_SINK=emu_audio_N \
    --restart=unless-stopped \
    budtmo/docker-android:emulator_13.0

docker exec adbd adb connect emulator-N:5555
```

Audio capture запустится автоматически через PA monitor.

## Компоненты

### pulse-hub
Shared PulseAudio daemon с 20 null-sinks для изоляции аудио каждого эмулятора. Null-sinks создаются при старте (`emu_audio_1` ... `emu_audio_20`).

### audio-capture-manager
Node.js сервис на порту 7600:
- **PA Monitor**: каждые 3 секунды опрашивает PulseAudio, обнаруживает QEMU подключения, автоматически направляет и запускает capture
- **FFmpeg**: кодирует PCM → Opus в WebM контейнере
- **WebSocket**: раздаёт WebM/Opus поток, буферизирует init segment для новых клиентов
- **HTTP API**: `/api/health`, `/api/capture/status`, `/api/capture/<serial>/start`, `/api/capture/<serial>/stop`
- **Auto-restart**: при DTS ошибках (после sleep/suspend) автоматически перезапускает FFmpeg

### nginx
Location `/audio/` проксирует WebSocket через SSL на audio-capture-manager.

### DeviceHub UI
- `device-audio-store.ts` — MobX store для аудио (WebSocket + MediaSource Extensions)
- `use-audio-streaming.hook.ts` — React hook, привязывает store к lifecycle
- `audio-toggle-button.tsx` — кнопка mute/unmute в top bar

## API

```bash
# Health check
curl http://localhost:7600/api/health

# Статус всех capture
curl http://localhost:7600/api/capture/status

# Ручной запуск (обычно не нужен — auto-discovery делает это)
curl -X POST http://localhost:7600/api/capture/emulator-1:5555/start \
    -H "Content-Type: application/json" \
    -d '{"sinkIndex": 1}'

# Ручная остановка
curl -X POST http://localhost:7600/api/capture/emulator-1:5555/stop
```

## Troubleshooting

### Нет звука
```bash
# Проверить что PA daemon жив
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sinks

# Проверить что QEMU подключён к PA
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sink-inputs

# Проверить capture status
curl http://localhost:7600/api/capture/status

# Проверить логи
docker logs audio-capture-mgr 2>&1 | tail -20
```

### Non-monotonous DTS ошибки
Возникают после sleep/suspend хоста. Manager автоматически перезапускает FFmpeg после 50 ошибок. Для немедленного фикса — перезагрузить страницу в браузере.

### Эмулятор не обнаруживается
```bash
# Проверить hostname эмулятора
docker exec emulator-1 hostname
# Должен быть: emulator-1 (не container ID)

# Проверить что PULSE_SERVER пробрасывается
docker exec emulator-1 env | grep PULSE
```

## Структура файлов

```
audio-infra/
├── pulse-hub/
│   ├── Dockerfile
│   └── entrypoint.sh
├── audio-capture-manager/
│   ├── Dockerfile
│   ├── package.json
│   ├── manager.js
│   └── healthcheck.sh
└── test/
    └── audio-test.html

docker-compose-audio.yaml
scripts/nginx.conf (модифицирован)

ui/src/
├── store/device-audio-store.ts
├── lib/hooks/use-audio-streaming.hook.ts
├── components/ui/device/device-top-bar/audio-toggle-button.tsx
└── config/inversify/ (модифицированы container-ids.ts, create-device-container.ts)
```
