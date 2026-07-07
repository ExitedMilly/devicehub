#!/usr/bin/env python3
"""
generate.py — validate instances.yaml + instances.local.env, produce
bring-up artifacts.

Usage:
    ./generate.py             # validate + generate artifacts
    ./generate.py --check     # validate only, no writes
"""

import sys
import os
import argparse
import subprocess
import re
import json
import base64
import binascii
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed.", file=sys.stderr)
    print("Install via: sudo apt install python3-yaml", file=sys.stderr)
    sys.exit(1)

try:
    from jinja2 import Environment, FileSystemLoader, StrictUndefined
except ImportError:
    print("ERROR: Jinja2 not installed.", file=sys.stderr)
    print("Install via: sudo apt install python3-jinja2", file=sys.stderr)
    sys.exit(1)

GENERATED_DIR_NAME = 'generated'
TEMPLATES_DIR_NAME = 'templates'

# Containers with these suffixes are legacy multi-mode and must never be
# touched by orphan cleanup. emulator-1 = legacy single emulator.
LEGACY_SUFFIXES = {'1'}

# Patterns for matching our own naming conventions
CONTAINER_NAME_PATTERN = re.compile(r'^(emulator|audio-capture-mgr)-(.+)$')
SCRIPT_NAME_PATTERN = re.compile(r'^(up|down)-(.+)\.sh$')


@dataclass
class Defaults:
    pulse_volume: str
    docker_network: str
    capture_image: str
    emulator_image: str
    emulator_device: str


@dataclass
class Instance:
    name: str
    serial: str
    pulse_sink: str
    pulse_source: str
    v4l2_device: str
    manager_port: int
    adb_port: int
    vnc_port: int
    webrtc_udp_min: int
    webrtc_udp_max: int
    # Optional per-instance operator identity (MCC/MNC + name). Empty = stock
    # operator. op_roaming is reserved (no-op): roaming needs a modem_simulator
    # binary patch, not achievable via file injection.
    op_mcc: str = ''
    op_mnc: str = ''
    op_name: str = ''
    op_name_short: str = ''
    op_roaming: bool = False
    # Optional per-instance Wi-Fi AP via netsim (needs the op-v2 / 36.6 image).
    # Empty = stock open network (AndroidWifi). Password (8+ chars) => WPA2/CCMP.
    wifi_ssid: Optional[str] = None
    wifi_password: Optional[str] = None
    # Optional per-instance BT signal strength (RSSI dBm) via netsim, set at
    # launch. "<dbm>" defaults to the BLE PhyKind (e.g. "-65" => "ble:-65"), or
    # give an explicit PhyKind "ble:-65" / "bt_classic:-70". Needs the op-v2 image.
    bt_rssi: Optional[str] = None
    # Optional per-instance fake BLE beacons (custom Bluetooth devices visible in
    # the emulator's BLE scan). netsim's --config file CANNOT define custom
    # beacons (its schema is only bluetooth/wifi/capture), so these are injected
    # after boot via netsimd's frontend API (POST /v1/devices, from inside the
    # emulator container). Each item: name (required), and optional mac,
    # manufacturer_data (hex), service_uuid, service_data (hex),
    # tx_power (ultra-low|low|medium|high | <dbm>), interval
    # (low-power|balanced|low-latency | <ms>), include_device_name (default true),
    # scannable (default true). Empty/omitted => no beacons (no-op).
    ble_beacons: Optional[list] = None
    # Optional per-instance phone number (digits only). Applied via the emulator
    # console after boot; empty leaves the emulator default.
    phone_number: Optional[str] = None
    # Optional per-instance emulator image override (defaults to defaults.emulator_image).
    emulator_image: Optional[str] = None


@dataclass
class Config:
    defaults: Defaults
    instances: list
    env: dict


# ============================================================
# BLE beacons (netsim frontend CreateDevice payloads)
# ============================================================

# netsim.model.Chip.BleBeacon.AdvertiseSettings enums.
_TX_POWER_LEVELS = {
    'ultra-low': 'ULTRA_LOW', 'low': 'LOW', 'medium': 'MEDIUM', 'high': 'HIGH',
}
_ADVERTISE_MODES = {
    'low-power': 'LOW_POWER', 'balanced': 'BALANCED', 'low-latency': 'LOW_LATENCY',
}
_MAC_RE = re.compile(r'^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$')


def _hex_to_b64(value: str) -> str:
    """Hex string (e.g. '00ff01') -> base64 (proto3-JSON encoding for bytes)."""
    return base64.b64encode(binascii.unhexlify(value)).decode('ascii')


def beacon_to_payload(beacon: dict) -> str:
    """Build a netsim frontend CreateDeviceRequest JSON (root 'device') for one
    BLE beacon. Assumes the beacon dict already passed validate_beacon()."""
    settings = {'scannable': bool(beacon.get('scannable', True)), 'timeout': 0}

    interval = beacon.get('interval')
    if interval is not None:
        key = str(interval).strip().lower()
        if key in _ADVERTISE_MODES:
            settings['advertiseMode'] = _ADVERTISE_MODES[key]
        else:
            settings['milliseconds'] = int(interval)
    else:
        settings['advertiseMode'] = 'LOW_LATENCY'

    tx_power = beacon.get('tx_power')
    if tx_power is not None:
        key = str(tx_power).strip().lower()
        if key in _TX_POWER_LEVELS:
            settings['txPowerLevel'] = _TX_POWER_LEVELS[key]
        else:
            settings['dbm'] = int(tx_power)

    adv_data = {'includeDeviceName': bool(beacon.get('include_device_name', True))}
    if beacon.get('manufacturer_data'):
        adv_data['manufacturerData'] = _hex_to_b64(str(beacon['manufacturer_data']))
    if beacon.get('service_uuid'):
        service = {'uuid': str(beacon['service_uuid'])}
        if beacon.get('service_data'):
            service['data'] = _hex_to_b64(str(beacon['service_data']))
        adv_data['services'] = [service]

    ble_beacon = {'settings': settings, 'advData': adv_data}
    # MAC only honoured at the BleBeaconCreate level (chip.address is ignored).
    if beacon.get('mac'):
        ble_beacon['address'] = str(beacon['mac']).lower()

    device = {
        'name': str(beacon['name']),
        'chips': [{'kind': 'BLUETOOTH_BEACON', 'bleBeacon': ble_beacon}],
    }
    return json.dumps({'device': device}, separators=(',', ':'))


def validate_beacon(inst_name: str, index: int, beacon) -> list:
    """Return list of validation errors for one ble_beacons entry."""
    errs = []
    tag = f"{inst_name}: ble_beacons[{index}]"
    if not isinstance(beacon, dict):
        return [f"{tag} must be a mapping"]
    name = beacon.get('name')
    if not name or not str(name).strip():
        errs.append(f"{tag}: 'name' is required")
    mac = beacon.get('mac')
    if mac is not None and not _MAC_RE.match(str(mac)):
        errs.append(f"{tag}: mac '{mac}' must be a MAC address XX:XX:XX:XX:XX:XX")
    for hexfield in ('manufacturer_data', 'service_data'):
        val = beacon.get(hexfield)
        if val is not None and str(val) != '':
            try:
                binascii.unhexlify(str(val))
            except (binascii.Error, ValueError):
                errs.append(f"{tag}: {hexfield} '{val}' must be an even-length hex string")
    if beacon.get('service_data') and not beacon.get('service_uuid'):
        errs.append(f"{tag}: service_data requires service_uuid")
    tx_power = beacon.get('tx_power')
    if tx_power is not None:
        key = str(tx_power).strip().lower()
        if key not in _TX_POWER_LEVELS:
            try:
                dbm = int(tx_power)
                if not (-127 <= dbm <= 127):
                    errs.append(f"{tag}: tx_power dBm ({dbm}) must be within [-127, 127]")
            except (TypeError, ValueError):
                errs.append(f"{tag}: tx_power must be one of "
                            f"{', '.join(_TX_POWER_LEVELS)} or an integer dBm")
    interval = beacon.get('interval')
    if interval is not None:
        key = str(interval).strip().lower()
        if key not in _ADVERTISE_MODES:
            try:
                ms = int(interval)
                if ms <= 0:
                    errs.append(f"{tag}: interval ms ({ms}) must be a positive integer")
            except (TypeError, ValueError):
                errs.append(f"{tag}: interval must be one of "
                            f"{', '.join(_ADVERTISE_MODES)} or an integer (ms)")
    return errs


# ============================================================
# Loaders
# ============================================================

def load_yaml(path: Path) -> dict:
    """Load and parse instances.yaml."""
    if not path.exists():
        raise FileNotFoundError(f"{path} not found")
    with path.open() as f:
        return yaml.safe_load(f)


def load_env(path: Path) -> dict:
    """Parse instances.local.env (KEY=value lines, # comments)."""
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. "
            f"Copy {path.with_suffix('.env.example').name} → "
            f"{path.name} and adjust paths."
        )
    env = {}
    for line_num, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise ValueError(f"{path}:{line_num}: invalid line (missing =): {line}")
        key, _, value = line.partition('=')
        key = key.strip()
        # Strip surrounding quotes if present
        value = value.strip().strip('"').strip("'")
        # Expand ${HOME}, ${USER}, etc.
        value = os.path.expandvars(value)
        env[key] = value
    return env


def parse_config(yaml_data: dict, env: dict) -> Config:
    """Convert raw yaml dict into typed Config dataclass."""
    if 'defaults' not in yaml_data:
        raise ValueError("instances.yaml: missing 'defaults' section")
    if 'instances' not in yaml_data:
        raise ValueError("instances.yaml: missing 'instances' section")

    defaults = Defaults(**yaml_data['defaults'])
    instances = [Instance(**i) for i in yaml_data['instances']]
    return Config(defaults=defaults, instances=instances, env=env)


# ============================================================
# Validation
# ============================================================

def validate(config: Config) -> list:
    """Return list of validation errors (empty list = OK)."""
    errors = []

    # 1. instances.local.env must contain BACKUPS_DIR
    if 'BACKUPS_DIR' not in config.env:
        errors.append(
            "instances.local.env: BACKUPS_DIR is required. "
            "See instances.local.env.example."
        )

    # 2. At least one instance
    if not config.instances:
        errors.append("instances.yaml: at least one instance is required")
        return errors  # cannot continue without instances

    # 3. Unique names
    names = [i.name for i in config.instances]
    duplicates = [n for n in set(names) if names.count(n) > 1]
    if duplicates:
        errors.append(f"Duplicate instance names: {sorted(duplicates)}")

    # 4. Unique serials
    serials = [i.serial for i in config.instances]
    duplicates = [s for s in set(serials) if serials.count(s) > 1]
    if duplicates:
        errors.append(f"Duplicate serials: {sorted(duplicates)}")

    # 5. Unique ports (manager, adb, vnc) — within each category
    for port_field in ('manager_port', 'adb_port', 'vnc_port'):
        ports = [getattr(i, port_field) for i in config.instances]
        duplicates = [p for p in set(ports) if ports.count(p) > 1]
        if duplicates:
            offenders = [
                f"{i.name}({getattr(i, port_field)})"
                for i in config.instances
                if getattr(i, port_field) in duplicates
            ]
            errors.append(
                f"Duplicate {port_field}: {sorted(duplicates)} "
                f"in instances {offenders}"
            )

    # 6. Unique v4l2_device, pulse_sink, pulse_source
    for resource_field in ('v4l2_device', 'pulse_sink', 'pulse_source'):
        values = [getattr(i, resource_field) for i in config.instances]
        duplicates = [v for v in set(values) if values.count(v) > 1]
        if duplicates:
            errors.append(
                f"Duplicate {resource_field}: {sorted(duplicates)}"
            )

    # 7. WebRTC UDP ranges must be non-overlapping
    ranges = [(i.name, i.webrtc_udp_min, i.webrtc_udp_max) for i in config.instances]
    for i in range(len(ranges)):
        for j in range(i + 1, len(ranges)):
            n1, lo1, hi1 = ranges[i]
            n2, lo2, hi2 = ranges[j]
            if not (hi1 < lo2 or hi2 < lo1):
                errors.append(
                    f"WebRTC UDP ranges overlap: {n1}({lo1}-{hi1}) and "
                    f"{n2}({lo2}-{hi2})"
                )

    # 8. Per-instance sanity
    for inst in config.instances:
        # 8.1. webrtc_udp_max > webrtc_udp_min
        if inst.webrtc_udp_max <= inst.webrtc_udp_min:
            errors.append(
                f"{inst.name}: webrtc_udp_max ({inst.webrtc_udp_max}) "
                f"must be > webrtc_udp_min ({inst.webrtc_udp_min})"
            )

        # 8.2. serial format: hostname:port (must contain ':')
        if ':' not in inst.serial:
            errors.append(
                f"{inst.name}: serial '{inst.serial}' must be hostname:port"
            )

        # 8.3. v4l2_device must look like /dev/videoN
        if not inst.v4l2_device.startswith('/dev/video'):
            errors.append(
                f"{inst.name}: v4l2_device '{inst.v4l2_device}' "
                f"must start with /dev/video"
            )

        # 8.4. name must be docker-compatible (alphanumeric, dash, underscore)
        if not all(c.isalnum() or c in '-_' for c in inst.name):
            errors.append(
                f"{inst.name}: name must contain only alphanumeric, "
                f"dash, or underscore (used in docker container names)"
            )

        # 8.5. Ports in valid range (1-65535, prefer >1024 for non-root)
        for port_field in ('manager_port', 'adb_port', 'vnc_port',
                           'webrtc_udp_min', 'webrtc_udp_max'):
            port = getattr(inst, port_field)
            if not (1 <= port <= 65535):
                errors.append(
                    f"{inst.name}: {port_field} ({port}) "
                    f"out of range 1-65535"
                )
            elif port < 1024:
                errors.append(
                    f"{inst.name}: {port_field} ({port}) is privileged "
                    f"(<1024); use port >= 1024 for non-root"
                )

        # 8.6. bt_rssi format: [PhyKind:]RSSI where RSSI is an i8 (-128..127).
        if inst.bt_rssi is not None and str(inst.bt_rssi).strip() != '':
            raw = str(inst.bt_rssi).strip()
            m = re.match(r'^(?:(ble|bt_classic):)?(-?\d+)$', raw, re.IGNORECASE)
            if not m:
                errors.append(
                    f"{inst.name}: bt_rssi '{inst.bt_rssi}' must be '<dbm>' or "
                    f"'<ble|bt_classic>:<dbm>' (e.g. '-65' or 'ble:-65')"
                )
            elif not (-128 <= int(m.group(2)) <= 127):
                errors.append(
                    f"{inst.name}: bt_rssi value ({m.group(2)}) "
                    f"must be between -128 and 127 (i8)"
                )

        # 8.7. ble_beacons: each entry must be a well-formed beacon spec.
        if inst.ble_beacons is not None:
            if not isinstance(inst.ble_beacons, list):
                errors.append(f"{inst.name}: ble_beacons must be a list")
            else:
                for bi, beacon in enumerate(inst.ble_beacons):
                    errors.extend(validate_beacon(inst.name, bi, beacon))

    return errors


# ============================================================
# Generation
# ============================================================

def get_known_outputs(instances: list) -> list:
    """Files that generate.py owns and may delete/rewrite."""
    files = ['up-all.sh', 'down-all.sh', 'devicehub-instances.conf']
    for inst in instances:
        files.append(f'up-{inst.name}.sh')
        files.append(f'down-{inst.name}.sh')
        # Per-instance BLE beacon payloads (written only when beacons are set,
        # but always listed so stale files get cleaned when beacons are removed).
        files.append(f'beacons-{inst.name}.ndjson')
    return files


def cleanup_generated(generated_dir: Path, known_files: list) -> None:
    """Remove only files we know we generated. Leaves user files alone."""
    if not generated_dir.exists():
        return
    for fname in known_files:
        fpath = generated_dir / fname
        if fpath.exists():
            fpath.unlink()


def find_orphan_containers(yaml_names: set) -> list:
    """List docker containers matching our naming (emulator-X or
    audio-capture-mgr-X) where X is not in yaml_names and not legacy.

    Returns empty list if docker is unreachable (with warn to stderr).
    """
    try:
        result = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{.Names}}'],
            capture_output=True, text=True, timeout=10
        )
    except (subprocess.SubprocessError, FileNotFoundError) as e:
        print(f"WARN: docker ps failed ({e}); skipping container orphan check",
              file=sys.stderr)
        return []

    if result.returncode != 0:
        print(f"WARN: docker ps returned {result.returncode}; "
              f"skipping container orphan check", file=sys.stderr)
        return []

    orphans = []
    for name in result.stdout.strip().split('\n'):
        name = name.strip()
        if not name:
            continue
        match = CONTAINER_NAME_PATTERN.match(name)
        if not match:
            continue
        suffix = match.group(2)
        if suffix in LEGACY_SUFFIXES:
            continue
        if suffix in yaml_names:
            continue
        orphans.append(name)
    return sorted(orphans)


def find_orphan_scripts(generated_dir: Path, yaml_names: set) -> list:
    """List up-X.sh / down-X.sh files in generated/ where X is not in
    yaml_names. up-all.sh / down-all.sh are aggregators, never orphans.
    """
    if not generated_dir.exists():
        return []
    orphans = []
    for entry in generated_dir.iterdir():
        if not entry.is_file():
            continue
        match = SCRIPT_NAME_PATTERN.match(entry.name)
        if not match:
            continue
        suffix = match.group(2)
        if suffix == 'all':
            continue
        if suffix in yaml_names:
            continue
        orphans.append(entry.name)
    return sorted(orphans)


def cleanup_orphans(
    orphan_containers: list,
    orphan_scripts: list,
    generated_dir: Path,
    assume_yes: bool,
) -> None:
    """Stop+rm orphan containers and delete orphan scripts. If --yes
    is set, no prompt. Otherwise interactive confirmation."""
    if not orphan_containers and not orphan_scripts:
        return

    print()
    print("Orphan resources found (not in current instances.yaml):")
    if orphan_containers:
        print("  Containers:")
        for name in orphan_containers:
            print(f"    - {name}")
    if orphan_scripts:
        print("  Scripts:")
        for name in orphan_scripts:
            print(f"    - generated/{name}")

    if not assume_yes:
        try:
            reply = input("\nClean these up? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            reply = ''
        if reply != 'y':
            print("Skipping cleanup; orphans remain.")
            return

    for name in orphan_containers:
        print(f"Stopping {name}...")
        subprocess.run(['docker', 'stop', name],
                       capture_output=True, timeout=30)
        subprocess.run(['docker', 'rm', name],
                       capture_output=True, timeout=10)

    for fname in orphan_scripts:
        (generated_dir / fname).unlink(missing_ok=True)
        print(f"Removed generated/{fname}")


def generate_artifacts(config: Config, scripts_dir: Path) -> None:
    """Render all templates and write to scripts/generated/."""
    templates_dir = scripts_dir / TEMPLATES_DIR_NAME
    generated_dir = scripts_dir / GENERATED_DIR_NAME

    cleanup_generated(generated_dir, get_known_outputs(config.instances))
    generated_dir.mkdir(exist_ok=True)

    jinja_env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )

    # Per-instance scripts
    up_tmpl = jinja_env.get_template('up-instance.sh.j2')
    down_tmpl = jinja_env.get_template('down-instance.sh.j2')

    for inst in config.instances:
        ctx = {'instance': inst, 'defaults': config.defaults, 'env': config.env}

        up_path = generated_dir / f'up-{inst.name}.sh'
        up_path.write_text(up_tmpl.render(**ctx))
        up_path.chmod(0o755)

        down_path = generated_dir / f'down-{inst.name}.sh'
        down_path.write_text(down_tmpl.render(**ctx))
        down_path.chmod(0o755)

        # Per-instance BLE beacon payloads (one CreateDeviceRequest JSON per line).
        # Injected into netsimd after boot by up-{name}.sh (POST /v1/devices).
        if inst.ble_beacons:
            ndjson = '\n'.join(beacon_to_payload(b) for b in inst.ble_beacons) + '\n'
            (generated_dir / f'beacons-{inst.name}.ndjson').write_text(ndjson)

    # Aggregator scripts
    for tmpl_name, out_name in [
        ('up-all.sh.j2', 'up-all.sh'),
        ('down-all.sh.j2', 'down-all.sh'),
    ]:
        tmpl = jinja_env.get_template(tmpl_name)
        out = generated_dir / out_name
        out.write_text(tmpl.render(instances=config.instances))
        out.chmod(0o755)

    # Nginx map fragment
    nginx_tmpl = jinja_env.get_template('nginx-map.conf.j2')
    out = generated_dir / 'devicehub-instances.conf'
    out.write_text(nginx_tmpl.render(instances=config.instances))

    known = get_known_outputs(config.instances)
    print(f"Generated {len(known)} files in {generated_dir}/:")
    for fname in known:
        print(f"  - {fname}")


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Validate instances.yaml and generate per-instance scripts."
    )
    parser.add_argument(
        '--check', action='store_true',
        help='Validate only, do not generate artifacts.'
    )
    parser.add_argument(
        '-y', '--yes', action='store_true',
        help='Auto-confirm orphan cleanup (non-interactive).'
    )
    parser.add_argument(
        '--no-cleanup', action='store_true',
        help='Skip orphan cleanup entirely. Orphan containers and '
             'scripts from removed instances are left alone.'
    )
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent
    yaml_path = repo_root / 'scripts' / 'instances.yaml'
    env_path = repo_root / 'scripts' / 'instances.local.env'

    try:
        yaml_data = load_yaml(yaml_path)
        env = load_env(env_path)
        config = parse_config(yaml_data, env)
    except (FileNotFoundError, ValueError, yaml.YAMLError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    errors = validate(config)

    if errors:
        print(f"Validation FAILED ({len(errors)} errors):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"OK: {len(config.instances)} instances valid.")
    for inst in config.instances:
        print(f"  - {inst.name} ({inst.serial}) → "
              f"port {inst.manager_port}, video {inst.v4l2_device}")

    if args.check:
        return

    scripts_dir = repo_root / 'scripts'
    generated_dir = scripts_dir / GENERATED_DIR_NAME

    # Orphan check & cleanup before generating new artifacts
    if not args.no_cleanup:
        yaml_names = {i.name for i in config.instances}
        orphan_containers = find_orphan_containers(yaml_names)
        orphan_scripts = find_orphan_scripts(generated_dir, yaml_names)
        cleanup_orphans(orphan_containers, orphan_scripts,
                        generated_dir, args.yes)

    try:
        generate_artifacts(config, scripts_dir)
    except Exception as e:
        print(f"ERROR during generation: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
