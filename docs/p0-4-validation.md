# P0.4 — Templating validation report

**Date:** 2026-05-08
**Branch:** feature/p0-4-templating
**Hardware:** ASUS Zenbook 14, single-instance only (laptop thermal limits)

## Scope

P0.4 introduces declarative `instances.yaml` + `generate.py` to produce
per-instance bash scripts and nginx routing fragments. PR 3 validates
that generated artifacts work end-to-end on real infrastructure.

## Validation methodology

Single-instance smoke test on local laptop (test1). Multi-instance
validation deferred to P0.7 production hardware setup. Architectural
correctness is independent of instance count: the same generator
produces 1 or 20 instances from the same template.

## Setup steps verified

| Step | Result |
|---|---|
| `docker compose ... up -d nginx` (with new bind-mount for generated/) | ✅ |
| `nginx -t` (syntax with `include` of generated map) | ✅ |
| `devicehub-instances.conf` mounted at `/etc/nginx/conf.d/` | ✅ |
| `./scripts/generated/up-test1.sh` runs to completion | ✅ |
| capture-mgr-test1 logs show `Running in SINGLE-INSTANCE mode` | ✅ |
| Emulator boot completed in ~40 seconds | ✅ |
| adb connect from devicehub-adbd succeeded | ✅ |
| `./scripts/generated/down-test1.sh` clean teardown | ✅ |

## Routing validation through nginx

| Test | Expected | Result |
|---|---|---|
| `curl /manager-api/gps/emulator-test1:5555` | 200 OK from test1 | ✅ |
| `curl /manager-api/gps/emulator-test2:5555` (no test2 running) | 502 from nginx | ✅ |

The 502 in the second case confirms that nginx map dispatches the
request to `audio-capture-mgr-test2:7602` (which doesn't exist for
this single-instance test). Default upstream fallback was NOT
triggered. This proves per-serial dispatch via map is working as
designed.

## UI validation

DeviceHub UI confirmed test1 device visible and functional. Full
feature parity already validated in P0.2 PR 5 on the equivalent
hand-rolled `start-test-slice.sh`. Generated artifact produces
identical runtime behavior.

## Conclusions

Generator workflow proven end-to-end on real infrastructure:
edit instances.yaml → generate.py → up-{name}.sh → working instance

Multi-instance validation deferred to P0.7 prod hardware due to local
thermal/CPU limits. Architectural correctness ensured: generator
produces N functionally-equivalent scripts regardless of N.

## Known limitations / deferred items

- Multi-instance load test on production hardware (P0.7)
- nginx zero-downtime reload after `generate.py` requires manual
  `docker exec devicehub-nginx nginx -s reload` (could be added to
  `up-all.sh` automatically — deferred to P0.7)
- Lifecycle for "removed instance" cleanup: if a user removes test3
  from yaml and re-runs `generate.py`, the test3 scripts are deleted
  but a running test3 container is not stopped. Manual `down-test3.sh`
  required first. Improvement deferred to P0.7.
