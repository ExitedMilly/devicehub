# DeviceHub Audio Infrastructure — Пошаговое руководство

## Что мы делаем в этом шаге

Поднимаем минимальный рабочий стек: **1 эмулятор + аудио pipeline + DeviceHub**.
Результат: браузер подключается к WebSocket и получает Opus-аудиопоток из эмулятора.

```
Emulator (Docker)
  └→ QEMU audio output
      └→ PulseAudio shared daemon (pulse-hub)
          └→ null-sink "emu_audio_1"
              └→ .monitor source
                  └→ FFmpeg (PCM → Opus)
                      └→ audio-capture-manager
                          └→ WebSocket
                              └→ Browser (Web Audio API)
```

## Структура новых файлов

```
~/caller/devicehub/
├── docker-compose-prod.yaml          # (существующий, не трогаем)
├── docker-compose-audio.yaml         # НОВЫЙ — overlay для аудио
└── audio-infra/
    ├── pulse-hub/
    │   ├── Dockerfile                # PulseAudio daemon
    │   └── entrypoint.sh            # Создаёт null-sinks при старте
    └── audio-capture-manager/
        ├── Dockerfile                # FFmpeg + Node.js
        ├── package.json
        ├── manager.js               # Ядро: FFmpeg lifecycle + WebSocket
        └── healthcheck.sh
```

## Шаг 0: Подготовка

DeviceHub уже запущен. Убедитесь:
```bash
docker ps --format '{{.Names}}' | grep devicehub-provider
# Должен показать: devicehub-provider
```

## Шаг 1: Копирование файлов

Автоматический вариант — запустить скрипт:
```bash
cd ~/caller
chmod +x setup-audio.sh
./setup-audio.sh
```

Ручной вариант — скопировать файлы и продолжить пошагово:
```bash
# Скопируйте директорию audio-infra/ в ~/caller/devicehub/
# Скопируйте docker-compose-audio.yaml в ~/caller/devicehub/
```

## Шаг 2: Сборка образов

```bash
cd ~/caller/devicehub

# PulseAudio hub
docker build -t pulse-hub:local ./audio-infra/pulse-hub/

# Audio capture manager
docker build -t audio-capture-mgr:local ./audio-infra/audio-capture-manager/
```

**Что происходит:**
- `pulse-hub` — минимальный Ubuntu 22.04 с PulseAudio. При старте создаёт
  null-sink для каждого эмулятора и слушает на unix socket.
- `audio-capture-mgr` — Node.js + FFmpeg. HTTP API для управления capture-процессами,
  WebSocket для раздачи Opus-аудио в браузеры.

## Шаг 3: Запуск

```bash
cd ~/caller/devicehub

docker compose \
    -f docker-compose-prod.yaml \
    -f docker-compose-audio.yaml \
    --env-file scripts/variables.env \
    up -d pulse-hub audio-capture-mgr emulator-1
```

**Docker compose overlay** — ключевой приём. Мы не модифицируем docker-compose-prod.yaml.
Второй файл добавляет новые сервисы в ту же сеть `devicehub`. Это значит:
- Все существующие сервисы DeviceHub продолжают работать без изменений
- Новые сервисы видят друг друга и DeviceHub по hostname
- Один `docker compose down` остановит всё

Первый запуск `emulator-1` может занять 5-10 минут (pull ~4GB образа).

## Шаг 4: Проверка PulseAudio hub

```bash
# Проверить что PA daemon жив
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock info

# Проверить что null-sinks созданы
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sinks
# Должно показать: emu_audio_1, emu_audio_2, ... emu_audio_20
```

**Что проверяем:** PA daemon работает, 20 null-sink-ов создано.
Каждый null-sink — это виртуальный аудиовыход. Эмулятор будет направлять
звук в свой sink через PULSE_SINK=emu_audio_1, а FFmpeg будет читать из
emu_audio_1.monitor.

## Шаг 5: Проверка audio-capture-manager

```bash
# Health check
curl http://localhost:7600/api/health
# {"status":"ok","instances":0}

# Статус (пока пусто — мы ещё не запустили capture)
curl http://localhost:7600/api/capture/status
# {}
```

## Шаг 6: Дождаться загрузки эмулятора

```bash
# Проверить через noVNC — откройте http://localhost:6080 в браузере

# Или через adb:
docker exec emulator-1 adb shell getprop sys.boot_completed
# Должно вернуть: 1
```

Загрузка эмулятора занимает 1-3 минуты.

## Шаг 7: Проверить что эмулятор подключился к PulseAudio

```bash
# Проверить sink-inputs на pulse-hub
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sink-inputs
```

**Важный момент:** QEMU может не создать sink-input до тех пор, пока Android реально
не начнёт проигрывать звук. Если список пуст — это нормально. Попробуйте открыть
YouTube в эмуляторе через noVNC и включить видео.

Если sink-input появился, но привязан к `default_null` а не к `emu_audio_1` —
значит PULSE_SINK не подхватился. В этом случае:
```bash
# Внутри контейнера эмулятора проверить
docker exec emulator-1 env | grep PULSE
# Должно быть:
# PULSE_SERVER=unix:/run/pulse/shared.sock
# PULSE_SINK=emu_audio_1
```

## Шаг 8: Запустить capture для эмулятора

```bash
# Запустить FFmpeg capture
curl -X POST http://localhost:7600/api/capture/emulator-1:5555/start \
    -H "Content-Type: application/json" \
    -d '{"sinkIndex": 1}'

# Ответ:
# {
#   "status": "started",
#   "wsUrl": "ws://audio-capture-manager:7600/audio/emulator-1:5555",
#   ...
# }
```

**Что произошло:** audio-capture-manager запустил FFmpeg:
```
ffmpeg -f pulse -server unix:/run/pulse/shared.sock -i emu_audio_1.monitor \
    -ac 1 -ar 48000 -c:a libopus -application lowdelay -frame_duration 20 \
    -b:a 64000 -f ogg pipe:1
```
FFmpeg читает из monitor-source null-sink-а, кодирует в Opus, пишет в stdout.
Manager читает stdout и раздаёт по WebSocket.

## Шаг 9: Проверить аудиопоток

```bash
# Установить wscat если нет
npm install -g wscat

# Подключиться к аудио WebSocket
wscat -c ws://localhost:7600/audio/emulator-1:5555 --no-check
```

Если в эмуляторе играет звук — вы увидите бинарные данные в терминале.
Если звука нет — данные всё равно идут (тишина в Opus), но медленнее.

## Шаг 10: Проверить в браузере (минимальный HTML-плеер)

Сохраните как файл и откройте в браузере:

```html
<!DOCTYPE html>
<html>
<head><title>Audio Test</title></head>
<body>
<h2>DeviceHub Audio Test</h2>
<button id="play">▶ Play Audio</button>
<span id="status">Disconnected</span>
<script>
document.getElementById('play').onclick = async () => {
    const status = document.getElementById('status');
    status.textContent = 'Connecting...';

    const ws = new WebSocket('ws://localhost:7600/audio/emulator-1:5555');
    ws.binaryType = 'arraybuffer';

    // Collect OGG chunks and play via MediaSource
    // Simplified: for full implementation, use opus-decoder WASM
    const chunks = [];
    ws.onopen = () => { status.textContent = 'Connected, waiting for audio...'; };
    ws.onmessage = (e) => {
        chunks.push(new Uint8Array(e.data));
        status.textContent = `Receiving audio (${chunks.length} packets)`;
    };
    ws.onerror = (e) => { status.textContent = 'Error: ' + e; };
    ws.onclose = () => { status.textContent = 'Disconnected'; };
};
</script>
</body>
</html>
```

Этот плеер пока только показывает что данные приходят. Полноценный Opus playback
через Web Audio API — следующий шаг (когда audio pipeline подтверждён).

## Что дальше

После успешной проверки этого шага:

1. **Подключить эмулятор к DeviceHub** — настроить ADB endpoint чтобы
   DeviceHub provider увидел эмулятор как устройство
2. **Добавить audio plugin в DeviceHub** — lib/units/device/plugins/audio/
3. **Добавить WebSocket проксирование в nginx** — для audio WS через wss://
4. **Frontend hook** — ui/src/lib/hooks/use-audio-streaming.hook.ts
5. **UI кнопка** — mute/unmute/volume в device-screen компоненте

## Troubleshooting

### Emulator не подключается к PA
```bash
# Проверить что unix socket доступен внутри контейнера
docker exec emulator-1 ls -la /run/pulse/shared.sock
# Должен существовать и быть readable

# Проверить что QEMU использует PulseAudio backend
docker exec emulator-1 ps aux | grep qemu
# В аргументах должен быть -audiodev pa,...
```

### FFmpeg не может подключиться к monitor source
```bash
# Проверить что source существует
docker exec pulse-hub pactl --server=unix:/run/pulse/shared.sock list short sources
# Должен быть: emu_audio_1.monitor

# Проверить FFmpeg руками
docker exec audio-capture-mgr ffmpeg -f pulse -server unix:/run/pulse/shared.sock \
    -i emu_audio_1.monitor -t 3 -ac 1 -ar 48000 -c:a libopus -f ogg /tmp/test.ogg
# Должен записать 3 секунды без ошибок
```

### audio-capture-manager не стартует
```bash
docker logs audio-capture-mgr
# Смотреть на ошибки подключения к PA или порт конфликты
```
