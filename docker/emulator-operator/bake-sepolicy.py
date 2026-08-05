#!/usr/bin/env python3
"""Gives the RIL spoof properties their own SELinux type so the shell domain may set
them, in place, via debugfs — the same GPT->super->logical-partition surgery
bake-ril.py / bake-prop.py use.

WHY
  persist.vendor.orchid.ril.* has no property_contexts entry of its own, so it falls
  through to vendor_default_prop. Platform policy carries

      (neverallow (and (domain) (not (init vendor_init))) vendor_default_prop
                  (property_service (set)))

  so `su 0 setprop` is refused and only `adb root` can write it. But a root adbd stops
  minicap from starting at all, which kills the screen stream — the cell-tower operblock
  and the screen were mutually exclusive. A private type carries no such neverallow, so
  shell can set it and adbd stays in shell mode.

WHAT IS EDITED (vendor partition only; /vendor has no avb= flag in fstab.ranchu)
  /etc/selinux/vendor_property_contexts   + one prefix line binding the namespace
  /etc/selinux/vendor_sepolicy.cil        + the type, its attributes and the allow rules
  /etc/selinux/precompiled_sepolicy       DELETED -- see below

WHY DELETE precompiled_sepolicy
  init only recompiles when the precompiled blob looks stale, and staleness is decided by
  comparing sha256 of the PLATFORM inputs against
  precompiled_sepolicy.{plat,system_ext}_sepolicy_and_mapping.sha256. Those stamps do not
  cover vendor_sepolicy.cil, so editing vendor policy alone leaves the stamps matching and
  init would load the stale blob and silently ignore this change. Removing the blob makes
  init log "No precompiled sepolicy at ..." and compile from CIL with /system/bin/secilc
  (present in this image). Cleaner than corrupting a hash on purpose.

VALIDATION DONE OFFLINE BEFORE BAKING (secilc 3.5)
  The rule set below compiles with init's own flags (-m -M true -G -N -c 33) AND with
  neverallow checking ENABLED (no -N). The naive version -- type in vendor_property_type
  plus `allow shell_33_0 ... property_service set` -- fails three neverallows from
  system/sepolicy/private/property.te; two extra attribute memberships fix that:
    * vendor_public_property_type              -> coredomains may set it (property.te:57)
    * system_writes_vendor_properties_violators -> AOSP's own exemption bucket for a
      system-side domain writing a vendor property (property.te:324)
  Adding shell_33_0 to the violators attribute removes a COMPILE-TIME check only; it grants
  no access by itself. Runtime access still needs an explicit allow, and the only one added
  here targets orchid_ril_prop.
"""
import os
import struct
import subprocess
import sys

SECTOR = 512
GEOMETRY_MAGIC = 0x616C4467
HEADER_MAGIC = 0x414C5030
IMG = "/opt/android/system-images/android-33/google_apis/x86_64/system.img"  # overridable via argv[1]

PARTITION = "vendor"
PC_PATH = "etc/selinux/vendor_property_contexts"
CIL_PATH = "etc/selinux/vendor_sepolicy.cil"
PRECOMPILED = "/etc/selinux/precompiled_sepolicy"

# Prefix match (no `exact`), so the whole persist.vendor.orchid.ril.* namespace is covered.
PC_LINE = "persist.vendor.orchid.ril.    u:object_r:orchid_ril_prop:s0"

CIL_BLOCK = """
; ---- OrchID op-v6: dedicated label for the RIL cell-spoof properties ----
; Lets the shell domain set persist.vendor.orchid.ril.* so `su 0 setprop` works and adbd
; can stay in shell mode (a root adbd stops minicap and kills the screen stream).
; Verified offline with secilc 3.5, neverallow checking ENABLED.
(type orchid_ril_prop)
(roletype object_r orchid_ril_prop)
(typeattributeset property_type (orchid_ril_prop))
(typeattributeset vendor_property_type (orchid_ril_prop))
; vendor_public_property_type: without it, property.te:57 forbids a coredomain from
; setting a vendor property.
(typeattributeset vendor_public_property_type (orchid_ril_prop))
; AOSP's own exemption bucket for a system-side domain that writes vendor properties;
; without it property.te:324 rejects the rule at build time. Compile-time only -- it
; confers no access on its own.
(typeattributeset system_writes_vendor_properties_violators (shell_33_0))
(allow shell_33_0 orchid_ril_prop (property_service (set)))
; vendor_init sets them too, so persisted values are restored on boot.
(allow vendor_init_33_0 orchid_ril_prop (property_service (set)))
(allow vendor_init_33_0 orchid_ril_prop (file (read getattr map open)))
; The patched RIL reads them; property reads go through the property area (file class).
; Blanket read mirrors how the stock goldfish vendor_qemu_prop is declared.
(allow rild orchid_ril_prop (file (read getattr map open)))
(allow domain orchid_ril_prop (file (read getattr map open)))
"""

WORK = "/tmp/sepolicy-extent.img"
OLD = "/tmp/sepolicy-old.txt"
NEW = "/tmp/sepolicy-new.txt"
CTX = "/tmp/sepolicy-ctx.bin"


def die(msg):
    sys.exit("[bake-sepolicy] %s" % msg)


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


def append_to(inpath, addition, must_contain=None):
    """Append text to a file inside WORK, preserving mode/uid/gid and its SELinux label."""
    target = "/" + inpath
    for f in (CTX, OLD, NEW):
        if os.path.exists(f):
            os.unlink(f)
    debugfs("ea_get -f %s %s security.selinux" % (CTX, target), WORK)
    if not os.path.exists(CTX) or os.path.getsize(CTX) == 0:
        die("could not read security.selinux of %s" % target)
    debugfs("dump %s %s" % (target, OLD), WORK)
    if not os.path.exists(OLD):
        die("could not dump %s" % target)
    with open(OLD, "r") as fh:
        old = fh.read()
    if must_contain and must_contain not in old:
        die("%s does not look like the expected file (missing %r)" % (target, must_contain))
    if "orchid_ril_prop" in old:
        die("%s already carries orchid_ril_prop -- refusing to bake twice" % target)
    text = old
    if not text.endswith("\n"):
        text += "\n"
    text += addition if addition.endswith("\n") else addition + "\n"
    with open(NEW, "w") as fh:
        fh.write(text)
    debugfs("rm %s" % target, WORK)
    debugfs("write %s %s" % (NEW, inpath), WORK)
    debugfs("sif %s mode 0100644" % target, WORK)
    debugfs("sif %s uid 0" % target, WORK)
    debugfs("sif %s gid 0" % target, WORK)
    debugfs("ea_set -f %s %s security.selinux" % (CTX, target), WORK)
    print("[bake-sepolicy]   %s: +%d bytes" % (target, len(text) - len(old)))


def main():
    global IMG
    if len(sys.argv) == 2:
        IMG = sys.argv[1]
    if not os.path.exists(IMG):
        die("system.img not found: %s" % IMG)
    print("[bake-sepolicy] labelling persist.vendor.orchid.ril.* as orchid_ril_prop in %s" % IMG)

    with open(IMG, "rb") as fh:
        super_lba = find_gpt_partition(fh, "super")
        off, length = find_logical_partition(fh, super_lba * SECTOR, PARTITION)
        extract(fh, off, length, WORK)

    with open(WORK, "rb") as fh:
        fh.seek(1080)
        if fh.read(2) != b"\x53\xef":
            die("%s: no ext4 superblock -- base image changed" % PARTITION)

    print("[bake-sepolicy] %s partition:" % PARTITION)
    append_to(PC_PATH, PC_LINE, must_contain="u:object_r:vendor_qemu_prop:s0")
    append_to(CIL_PATH, CIL_BLOCK, must_contain="(type vendor_qemu_prop)")

    # Force init to recompile: the sha256 stamps only cover the platform inputs, so a
    # vendor-only edit would otherwise be masked by the stale precompiled blob.
    stat = debugfs("stat %s" % PRECOMPILED, WORK, check=False)
    if "File not found" in stat or not stat.strip():
        die("%s missing -- base image changed" % PRECOMPILED)
    debugfs("rm %s" % PRECOMPILED, WORK)
    gone = debugfs("stat %s" % PRECOMPILED, WORK, check=False)
    if "File not found" not in gone:
        die("failed to remove %s" % PRECOMPILED)
    print("[bake-sepolicy]   %s: removed (init will recompile with secilc)" % PRECOMPILED)

    r = subprocess.run(["e2fsck", "-fn", WORK], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        die("%s: e2fsck rejected patched fs:\n%s" % (PARTITION, r.stdout.decode(errors="replace")))
    if os.path.getsize(WORK) != length:
        die("%s: extent size changed (%d != %d)" % (PARTITION, os.path.getsize(WORK), length))

    with open(WORK, "rb") as src, open(IMG, "r+b") as dst:
        dst.seek(off)
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)

    for f in (WORK, OLD, NEW, CTX):
        if os.path.exists(f):
            os.unlink(f)
    print("[bake-sepolicy] done -- shell may now set persist.vendor.orchid.ril.* without adb root")


main()
