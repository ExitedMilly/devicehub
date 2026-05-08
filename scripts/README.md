# DeviceHub multi-instance scripts

Workflow for bringing up N capture-mgr + emulator pairs from a
declarative `instances.yaml`.

## One-time setup (host)

1. Install dependencies:
   ```
   sudo apt install python3-yaml python3-jinja2
   ```

2. Create your local environment file:
   ```
   cp scripts/instances.local.env.example scripts/instances.local.env
   $EDITOR scripts/instances.local.env       # adjust BACKUPS_DIR
   ```

3. Add bind-mount to nginx for the generated map fragment.
   In `docker-compose-prod.yaml`, find `devicehub-nginx` service and add to volumes:
   ```yaml
   volumes:
     - ./scripts/nginx.conf:/etc/nginx/nginx.conf:ro
     - ./scripts/generated/devicehub-instances.conf:/etc/nginx/conf.d/devicehub-instances.conf:ro  # ADD THIS
   ```
   Then `docker compose up -d devicehub-nginx`.

## Workflow

```
# 1. Edit topology
$EDITOR scripts/instances.yaml

# 2. Generate scripts and nginx config
./scripts/generate.py

# 3. Bring up all instances
./scripts/generated/up-all.sh

# 4. Reload nginx to pick up new routing
docker exec devicehub-nginx nginx -s reload

# 5. (later) Tear down
./scripts/generated/down-all.sh
```

## Per-instance commands

For debugging, individual instances can be brought up/down:
```
./scripts/generated/up-test2.sh
./scripts/generated/down-test2.sh
```

## File layout

| File | Purpose | In git? |
|---|---|---|
| `instances.yaml` | Topology declaration: N instances, ports, sinks, devices | yes |
| `instances.local.env` | Host-specific paths (BACKUPS_DIR, etc.) | **no** (gitignored) |
| `instances.local.env.example` | Template for instances.local.env | yes |
| `generate.py` | Validator + artifact generator | yes |
| `templates/` | Jinja2 templates for generated scripts and nginx config | yes |
| `generated/` | Output of generate.py — bash scripts and nginx fragment | **no** (gitignored) |

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

- PR 3: smoke test with real instances
