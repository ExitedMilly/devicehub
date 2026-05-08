#!/usr/bin/env python3
"""
generate.py — validate instances.yaml + instances.local.env, produce
bring-up artifacts.

Currently implemented (PR 1): parse + validate, no artifact generation.
Planned (PR 2): write up-all.sh, down-all.sh, nginx.conf.

Usage:
    ./generate.py             # validate (PR 1) / generate (PR 2+)
    ./generate.py --check     # validate only, no writes (PR 2+)
"""

import sys
import os
import argparse
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed.", file=sys.stderr)
    print("Install via: sudo apt install python3-yaml", file=sys.stderr)
    sys.exit(1)


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


@dataclass
class Config:
    defaults: Defaults
    instances: list
    env: dict


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

    return errors


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Validate and (in PR 2+) generate per-instance scripts."
    )
    parser.add_argument(
        '--check', action='store_true',
        help='Validate only, do not write artifacts (PR 2+ behavior).'
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

    # PR 2 will add: generate up-all.sh / down-all.sh / nginx.conf
    print()
    print("(generation not implemented yet — see PR 2)")


if __name__ == '__main__':
    main()
