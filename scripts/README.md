# DeviceHub multi-instance scripts

Workflow for bringing up N capture-mgr + emulator pairs from a
declarative `instances.yaml`.

## Setup

1. Install Python YAML parser (one-time):
   ```
   sudo apt install python3-yaml
   ```

2. Create your local environment file:
   ```
   cp scripts/instances.local.env.example scripts/instances.local.env
   $EDITOR scripts/instances.local.env       # adjust BACKUPS_DIR
   ```

3. Edit `scripts/instances.yaml` to describe your instances.

4. Validate the configuration:
   ```
   ./scripts/generate.py
   ```

## File layout

| File | Purpose | In git? |
|---|---|---|
| `instances.yaml` | Topology declaration: N instances, ports, sinks, devices | yes |
| `instances.local.env` | Host-specific paths (BACKUPS_DIR, etc.) | **no** (gitignored) |
| `instances.local.env.example` | Template for instances.local.env | yes |
| `generate.py` | Validator + (PR 2+) artifact generator | yes |

## Validation rules

`generate.py` checks:
- All instance names are unique
- All serials are unique
- Manager / ADB / VNC ports are unique within each category
- v4l2_device, pulse_sink, pulse_source are unique
- WebRTC UDP ranges do not overlap between instances
- webrtc_udp_max > webrtc_udp_min within each instance
- Serial follows hostname:port format
- v4l2_device starts with /dev/video
- Instance name uses only [a-zA-Z0-9_-] (docker-compatible)
- All ports are in valid non-privileged range (1024-65535)

## TODO (next PRs)

- PR 2: generate up-all.sh, down-all.sh, nginx.conf
- PR 3: smoke test with real instances
- PR 4: per-instance up-{name}.sh, down-{name}.sh
