#!/usr/bin/env python3
"""Masks the sdk_gphone emulator identity by rewriting build.prop under a real
Redmi Note 12 4G (codename `tapas`) profile, in place, via debugfs — the same
GPT->super->logical-partition surgery bake-ril.py uses (no AOSP rebuild, so GMS/
Play stays intact: op-v4 is a Google GMS PREBUILT; the /aosp tree only builds the
AOSP sdk_phone target with no Play).

Edited (all NON-AVB ext4 partitions — fstab gives only /system avb=vbmeta):
  product     /etc/build.prop                 (source-order winner: fixes bare
                                               ro.product.* + holds characteristics;
                                               we also add the bare ro.build.fingerprint
                                               to override init's derive-if-unset)
  vendor      /build.prop                      (per-partition vendor.* + board)
  vendor      /odm/etc/build.prop              (/odm symlinks into vendor)
  vendor      /vendor_dlkm/etc/build.prop      (/vendor_dlkm symlinks into vendor)
  system_ext  /etc/build.prop

Left untouched (residual tells — see recon memory):
  /system/build.prop           AVB-protected: bare ro.build.{id,tags,type,flavor,
                               product,version.incremental,description}, security_patch
                               (also keeps ro.debuggable=1 so `adb root` still works —
                               the Cell-tower operblock needs it).
  system_dlkm build.prop       EROFS (debugfs can't edit) -> ro.product.system_dlkm.*.
  boot ramdisk                 ro.product.bootimage.* / ro.bootimage.build.*.

Consistency: every value is from the SAME real device (Redmi Note 12 4G tapas_global,
Android 13, MIUI 14 Global MIXM).
"""
import os
import re
import struct
import subprocess
import sys

SECTOR = 512
GEOMETRY_MAGIC = 0x616C4467
HEADER_MAGIC = 0x414C5030
IMG = "/opt/android/system-images/android-33/google_apis/x86_64/system.img"  # overridable via argv[1]

# --- Redmi Note 12 4G (tapas_global) target identity ---------------------------
FP = "Redmi/tapas_global/tapas:13/TKQ1.221114.001/V14.0.12.0.TMTMIXM:user/release-keys"
R = {
    "brand": "Redmi", "manufacturer": "Xiaomi", "device": "tapas",
    "name": "tapas_global", "model": "23021RAAEG", "board": "SM6225",
    "id": "TKQ1.221114.001", "incremental": "V14.0.12.0.TMTMIXM",
    "tags": "release-keys", "type": "user",
    "soc_manufacturer": "QTI", "soc_model": "SM6225",
}


def part_map(part):
    """The identical per-partition prop set: ro.product.<part>.* + ro.<part>.build.*."""
    return {
        "ro.product.%s.brand" % part: R["brand"],
        "ro.product.%s.device" % part: R["device"],
        "ro.product.%s.manufacturer" % part: R["manufacturer"],
        "ro.product.%s.model" % part: R["model"],
        "ro.product.%s.name" % part: R["name"],
        "ro.%s.build.fingerprint" % part: FP,
        "ro.%s.build.id" % part: R["id"],
        "ro.%s.build.tags" % part: R["tags"],
        "ro.%s.build.type" % part: R["type"],
        "ro.%s.build.version.incremental" % part: R["incremental"],
    }


_product_map = part_map("product")
_product_map["ro.build.characteristics"] = "default"      # was "emulator"
_vendor_map = part_map("vendor")
_vendor_map["ro.product.board"] = R["board"]              # was goldfish_x86_64

# super-partition name -> list of (path-inside-fs, replace_map, append-if-absent lines)
PARTITIONS = [
    ("product", [
        ("etc/build.prop", _product_map, [
            "ro.build.fingerprint=" + FP,                # bare: override init derive-if-unset
        ]),
    ]),
    ("vendor", [
        ("build.prop", _vendor_map, [
            "ro.soc.manufacturer=" + R["soc_manufacturer"],
            "ro.soc.model=" + R["soc_model"],
        ]),
        ("odm/etc/build.prop", part_map("odm"), []),
        ("vendor_dlkm/etc/build.prop", part_map("vendor_dlkm"), []),
    ]),
    ("system_ext", [
        ("etc/build.prop", part_map("system_ext"), []),
    ]),
]

WORK = "/tmp/prop-extent.img"
BP_OLD = "/tmp/prop-old.txt"
BP_NEW = "/tmp/prop-new.txt"
CTX = "/tmp/prop-ctx.bin"


def die(msg):
    sys.exit("[bake-prop] %s" % msg)


def find_gpt_partition(fh, name):
    fh.seek(SECTOR)
    hdr = fh.read(92)
    if hdr[:8] != b"EFI PART":
        die("no GPT header in %s" % IMG)
    entries_lba = struct.unpack_from("<Q", hdr, 72)[0]
    count = struct.unpack_from("<I", hdr, 80)[0]
    size = struct.unpack_from("<I", hdr, 84)[0]
    fh.seek(entries_lba * SECTOR)
    for _ in range(count):
        e = fh.read(size)
        if e[:16] == b"\x00" * 16:
            continue
        if e[56:128].decode("utf-16-le").rstrip("\x00") == name:
            return struct.unpack_from("<Q", e, 32)[0]
    die("no %r partition in the GPT" % name)


def find_logical_partition(fh, super_off, name):
    fh.seek(super_off + 4096)
    if struct.unpack_from("<I", fh.read(4), 0)[0] != GEOMETRY_MAGIC:
        die("no LpMetadataGeometry at super+4096")
    meta_off = super_off + 4096 * 3
    fh.seek(meta_off)
    hdr = fh.read(256)
    if struct.unpack_from("<I", hdr, 0)[0] != HEADER_MAGIC:
        die("no LpMetadataHeader at super+12288")
    header_size = struct.unpack_from("<I", hdr, 8)[0]

    def desc(i):
        return struct.unpack_from("<III", hdr, 80 + i * 12)

    p_off, p_num, p_sz = desc(0)
    e_off, e_num, e_sz = desc(1)
    tables = meta_off + header_size
    fh.seek(tables + e_off)
    extents = []
    for _ in range(e_num):
        raw = fh.read(e_sz)
        num_sectors, _tt, target_data, _ts = struct.unpack_from("<QIQI", raw, 0)
        extents.append((num_sectors, target_data))
    fh.seek(tables + p_off)
    for _ in range(p_num):
        raw = fh.read(p_sz)
        pname = raw[:36].split(b"\x00")[0].decode()
        _a, first_ext, num_ext, _g = struct.unpack_from("<IIII", raw, 36)
        if pname != name:
            continue
        if num_ext != 1:
            die("%s spans %d extents; in-place patching assumes one" % (name, num_ext))
        num_sectors, target_data = extents[first_ext]
        return super_off + target_data * SECTOR, num_sectors * SECTOR
    die("no %r partition inside super" % name)


def debugfs(cmd, image, check=True):
    r = subprocess.run(["debugfs", "-w", "-R", cmd, image],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = r.stdout.decode(errors="replace")
    if check and r.returncode != 0:
        die("debugfs %r failed: %s" % (cmd, out))
    return out


def extract(fh, off, length, dst):
    with open(dst, "wb") as out:
        fh.seek(off)
        left = length
        while left:
            chunk = fh.read(min(1 << 20, left))
            if not chunk:
                die("short read extracting extent")
            out.write(chunk)
            left -= len(chunk)


def edit_props(text, replace_map, append_lines):
    lines = text.split("\n")
    present = set()
    changed = []
    for i, line in enumerate(lines):
        m = re.match(r"^([a-zA-Z0-9._]+)=", line)
        if not m:
            continue
        key = m.group(1)
        present.add(key)
        if key in replace_map:
            newline = key + "=" + replace_map[key]
            if newline != line:
                lines[i] = newline
                changed.append(key)
    for key in replace_map:
        if key not in present:
            print("[bake-prop]     note: %s absent (skipped)" % key)
    for add in append_lines:
        key = add.split("=", 1)[0]
        if key not in present:
            if lines and lines[-1] == "":
                lines.insert(len(lines) - 1, add)
            else:
                lines.append(add)
            changed.append(key + " (added)")
    return "\n".join(lines), changed


def edit_file(target, inpath, replace_map, append_lines):
    """Edit one build.prop inside the already-extracted WORK filesystem, preserving
    mode/uid/gid and its own SELinux context."""
    for f in (CTX, BP_OLD, BP_NEW):
        if os.path.exists(f):
            os.unlink(f)
    debugfs("ea_get -f %s %s security.selinux" % (CTX, target), WORK)
    if not os.path.exists(CTX) or os.path.getsize(CTX) == 0:
        die("could not read security.selinux of %s" % target)
    debugfs("dump %s %s" % (target, BP_OLD), WORK)
    if not os.path.exists(BP_OLD):
        die("could not dump %s" % target)
    with open(BP_OLD, "r") as fh:
        old = fh.read()
    new, changed = edit_props(old, replace_map, append_lines)
    with open(BP_NEW, "w") as fh:
        fh.write(new)
    print("[bake-prop]   %s: %d keys changed" % (target, len(changed)))
    debugfs("rm %s" % target, WORK)
    debugfs("write %s %s" % (BP_NEW, inpath), WORK)
    debugfs("sif %s mode 0100644" % target, WORK)
    debugfs("sif %s uid 0" % target, WORK)
    debugfs("sif %s gid 0" % target, WORK)
    debugfs("ea_set -f %s %s security.selinux" % (CTX, target), WORK)


def patch_partition(name, files):
    with open(IMG, "rb") as fh:
        super_lba = find_gpt_partition(fh, "super")
        off, length = find_logical_partition(fh, super_lba * SECTOR, name)
        extract(fh, off, length, WORK)
    with open(WORK, "rb") as fh:
        fh.seek(1080)
        if fh.read(2) != b"\x53\xef":
            die("%s: no ext4 superblock -- base image changed" % name)
    print("[bake-prop] %s partition (%d files):" % (name, len(files)))
    for inpath, rep, add in files:
        # /odm and /vendor_dlkm are symlinks INTO vendor; their real path inside the
        # vendor fs is exactly inpath (odm/etc/build.prop, vendor_dlkm/etc/build.prop).
        edit_file("/" + inpath, inpath, rep, add)

    r = subprocess.run(["e2fsck", "-fn", WORK], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        die("%s: e2fsck rejected patched fs:\n%s" % (name, r.stdout.decode(errors="replace")))
    if os.path.getsize(WORK) != length:
        die("%s: extent size changed (%d != %d)" % (name, os.path.getsize(WORK), length))
    with open(WORK, "rb") as src, open(IMG, "r+b") as dst:
        dst.seek(off)
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)


def main():
    global IMG
    if len(sys.argv) == 2:
        IMG = sys.argv[1]
    if not os.path.exists(IMG):
        die("system.img not found: %s" % IMG)
    print("[bake-prop] masking as Redmi Note 12 4G (tapas_global) in %s" % IMG)
    for name, files in PARTITIONS:
        patch_partition(name, files)
    for f in (WORK, BP_OLD, BP_NEW, CTX):
        if os.path.exists(f):
            os.unlink(f)
    print("[bake-prop] done — /system untouched (AVB); adb root preserved")


main()
