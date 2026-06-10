# play-clip

Remote client for DeviceHub **P1.1 file injection**. Reads a local `.mp4`,
decodes it with FFmpeg, and streams it into a target emulator:

- video → raw **YUV420P 640×480 @25fps** → WebSocket `/file-video/{serial}` → virtual camera
- audio → raw **PCM s16le 48000 Hz mono** → WebSocket `/file-audio/{serial}` → emulator microphone

The clip plays **once**. When it finishes (or you Ctrl-C), the client closes both
sockets and the server automatically returns the camera to black and the mic to
silence.

This is a **self-contained client tool**. It runs on a remote machine, *not*
inside the capture-manager container, and depends only on `ws`.

## Requirements

- **Node.js 16+** on the machine running this tool.
- **ffmpeg** on `PATH` (used for decoding/scaling/resampling).
- Network reachability to the DeviceHub server.

## Install

```bash
cd tools/play-clip
npm install        # pulls only `ws`
```

## Auth token

The tool needs a DeviceHub JWT when the server has `AUTH_REQUIRED=1`. It is read
**in this order** (never from a CLI arg, to avoid leaking via `ps`/shell history):

1. `~/.devicehub_token` — trimmed file contents
2. `$DEVICEHUB_TOKEN` — environment variable

```bash
echo "<your-jwt>" > ~/.devicehub_token
chmod 600 ~/.devicehub_token
```

The token is sent two ways:
- HTTP preflight: `Authorization: Bearer <jwt>`
- WebSockets: subprotocol `access_token.<jwt>` (how the server's `verifyWsAuth` extracts it)

If no token is found, the preflight is skipped and the WebSocket handshake is
relied on to gate access — on an auth-required server the sockets close with
`4001` and a clear error is printed.

## Usage

```bash
node play-clip.js <video.mp4> <serial> [options]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `<video.mp4>` | — | Local video file (must exist). |
| `<serial>` | — | Emulator serial, e.g. `emulator-test1:5555`. |
| `--server <host>` | `$DEVICEHUB_SERVER` or `localhost` | Server host. |
| `--port <n>` | `443` | `443` → `https`/`wss` (through nginx). Any other port → `http`/`ws` (direct to container). |
| `--insecure` | off | Allow self-signed TLS (`rejectUnauthorized=false`). DeviceHub uses a self-signed cert, so this is commonly needed over `wss`. |
| `-h`, `--help` | — | Show help. |

### Examples

Production (remote, through nginx, self-signed cert):

```bash
node play-clip.js clip.mp4 emulator-test1:5555 --server 10.0.0.5 --insecure
```

Local end-to-end (direct to the capture-manager container on `:7601`):

```bash
node play-clip.js clip.mp4 emulator-test1:5555 --server localhost --port 7601
```

## Behavior & flow

1. **Preflight** `GET /api/file-inject/{serial}` (direct, non-443) or
   `/manager-api/file-inject/{serial}` (nginx, `:443`):
   - `200` → proceed (logs the reported `{width,height,fps,sampleRate}`)
   - `401` → token invalid/expired
   - `403` → serial not allowed / not owned
   - `409` → camera busy (WebRTC session active)
   - anything else / connection error → clear error, exit non-zero
2. **Open both WebSockets** (`/file-video`, `/file-audio`) and wait for **both**
   to be open before any FFmpeg starts. If either is rejected during the
   handshake (`4001/4002/4003/4409/4410/…`), the run aborts, no FFmpeg is spawned.
3. **Stream**: two FFmpeg processes pipe their stdout to the matching socket.
   Minimal client-side backpressure: if a socket's `bufferedAmount` exceeds 16 MB
   the source FFmpeg is paused and resumed once it drains below 8 MB. (The server
   already drops/handles overflow; this only bounds client memory.)
4. **Completion**: when **both** FFmpeg processes exit, both sockets close
   cleanly and the process exits `0`.
5. **No audio stream**: if the audio FFmpeg exits non-zero (e.g. the file has no
   audio), it is treated pragmatically as "no audio" — a warning is logged and
   the run continues **video-only**, completing when the video FFmpeg exits.
6. **Signals**: `SIGINT`/`SIGTERM` kill both FFmpeg, close both sockets, and exit.
   Cleanup is idempotent (no double-kill / double-close / orphans).

### Exit codes

- `0` — clip played and sockets closed cleanly.
- non-zero — any abort: bad args, missing file, preflight rejection, WS
  rejection, mid-stream socket close, or interrupted by a signal.

## nginx note

The WebSocket paths are sent in their **direct container form**
(`/file-video/{serial}`, `/file-audio/{serial}`). The preflight path is mapped to
`/manager-api/...` when `--port 443` is used. Full nginx route mapping is the
subject of **PR 5**; for direct local testing on `:7601` the paths above are exact.

## What is tested vs. needs real-emulator e2e

Covered without an emulator (see the repo's validation run):
- `node -c` syntax check.
- `npm install` pulling only `ws`.
- A mock WS server (accepts the `access_token.*` subprotocol, counts received
  bytes) + a synthetic 2 s mp4, asserting: preflight `200` handling, both sockets
  open, byte counts `> 0` on both, clean completion, exit `0`.

Still requires a **real DeviceHub server + emulator** to verify end-to-end:
- frames actually rendering on the emulator's virtual camera,
- PCM actually audible on the emulator microphone,
- live `403`/`409`/`4001`/`4409`/`4410` rejections from the real server,
- behavior through the real nginx (PR 5).
