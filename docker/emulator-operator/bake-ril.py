#!/usr/bin/env python3
"""Bakes a patched libcuttlefish-ril-2.so into the emulator's vendor partition.

Where /vendor actually lives (this is the whole difficulty):

    system.img  = a GPT disk image -> becomes vda in the guest
                    vda1 "vbmeta"
                    vda2 "super"  = an Android dynamic-partition container
                                      +-- system, system_ext, system_dlkm,
                                          product, VENDOR   <- our target

So /vendor is a logical partition nested inside super, nested inside system.img.
The sibling vendor.img in the same directory is a decoy: hardware-qemu.ini still
lists it as disk.vendorPartition.initPath and the emulator even creates an empty
vendor.img.qcow2 overlay for it, but the guest mounts /vendor from super
(/dev/block/mapper/vendor -> dm-4, backed by vda2). Patching vendor.img changes
nothing observable.

Rather than unpack and rebuild super with lpmake, we replace the file in place:
the new .so occupies the same filesystem, and the vendor extent keeps its exact
offset and length, so the surrounding super metadata stays valid untouched.
debugfs rewrites the ext4 without mounting it, which a docker build cannot do
(no loop devices, no CAP_SYS_ADMIN).

Safe for verified boot: fstab.ranchu gives /vendor no `avb=` flag -- only
/system carries `avb=vbmeta`, and we do not touch /system.
"""
import os
import re
import struct
import subprocess
import sys

SECTOR = 512
GEOMETRY_MAGIC = 0x616C4467
HEADER_MAGIC = 0x414C5030

IMG = "/opt/android/system-images/android-33/google_apis/x86_64/system.img"
TARGET = "/lib64/libcuttlefish-ril-2.so"          # path inside the vendor filesystem
SELINUX_CTX = b"u:object_r:vendor_file:s0\x00"    # NUL-terminated, as the stock xattr is
WORK = "/tmp/vendor-extent.img"
CTX_FILE = "/tmp/vendor-selinux-ctx"


def die(msg):
    sys.exit("[bake-ril] %s" % msg)


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
            return struct.unpack_from("<Q", e, 32)[0]      # first LBA
    die("no %r partition in the GPT" % name)


def find_logical_partition(fh, super_off, name):
    """Returns (byte offset in IMG, length) of a partition inside super."""
    fh.seek(super_off + 4096)                              # LpMetadataGeometry
    if struct.unpack_from("<I", fh.read(4), 0)[0] != GEOMETRY_MAGIC:
        die("no LpMetadataGeometry at super+4096")

    meta_off = super_off + 4096 * 3                        # after both geometry copies
    fh.seek(meta_off)
    hdr = fh.read(256)
    if struct.unpack_from("<I", hdr, 0)[0] != HEADER_MAGIC:
        die("no LpMetadataHeader at super+12288")
    header_size = struct.unpack_from("<I", hdr, 8)[0]

    # Table descriptors start at 80 (magic4 ver4 size4 checksum32 tables_size4
    # tables_checksum32); 80 + 4*12 == 128 == header_size.
    def desc(i):
        return struct.unpack_from("<III", hdr, 80 + i * 12)

    p_off, p_num, p_sz = desc(0)
    e_off, e_num, e_sz = desc(1)
    tables = meta_off + header_size

    fh.seek(tables + e_off)
    extents = []
    for _ in range(e_num):
        raw = fh.read(e_sz)
        num_sectors, _ttype, target_data, _tsrc = struct.unpack_from("<QIQI", raw, 0)
        extents.append((num_sectors, target_data))

    fh.seek(tables + p_off)
    for _ in range(p_num):
        raw = fh.read(p_sz)
        pname = raw[:36].split(b"\x00")[0].decode()
        _attrs, first_ext, num_ext, _group = struct.unpack_from("<IIII", raw, 36)
        if pname != name:
            continue
        if num_ext != 1:
            die("%s spans %d extents; in-place patching assumes one" % (name, num_ext))
        num_sectors, target_data = extents[first_ext]
        return super_off + target_data * SECTOR, num_sectors * SECTOR
    die("no %r partition inside super" % name)


def debugfs(cmd, image):
    r = subprocess.run(["debugfs", "-w", "-R", cmd, image],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        die("debugfs %r failed: %s" % (cmd, r.stdout.decode(errors="replace")))
    return r.stdout.decode(errors="replace")


def main():
    if len(sys.argv) != 2:
        die("usage: bake-ril.py /path/to/libcuttlefish-ril-2.so")
    new_so = sys.argv[1]
    want = os.path.getsize(new_so)

    with open(IMG, "rb") as fh:
        super_lba = find_gpt_partition(fh, "super")
        off, length = find_logical_partition(fh, super_lba * SECTOR, "vendor")
    print("[bake-ril] vendor extent: offset=%d length=%d (super at LBA %d)"
          % (off, length, super_lba))

    with open(IMG, "rb") as src, open(WORK, "wb") as dst:
        src.seek(off)
        left = length
        while left:
            chunk = src.read(min(1 << 20, left))
            if not chunk:
                die("short read while extracting the vendor extent")
            dst.write(chunk)
            left -= len(chunk)

    # Refuse to write anything unless this really is the vendor filesystem.
    with open(WORK, "rb") as fh:
        fh.seek(1080)
        if fh.read(2) != b"\x53\xef":
            die("no ext4 superblock in the vendor extent -- base image changed")
        fh.seek(1024 + 120)
        label = fh.read(16).split(b"\x00")[0].decode(errors="replace")
    if label != "vendor":
        die("extent holds filesystem %r, expected 'vendor'" % label)

    print("[bake-ril] replacing %s (%d bytes)" % (TARGET, want))
    with open(CTX_FILE, "wb") as fh:
        fh.write(SELINUX_CTX)
    debugfs("rm %s" % TARGET, WORK)
    debugfs("write %s %s" % (new_so, TARGET.lstrip("/")), WORK)
    debugfs("sif %s mode 0100644" % TARGET, WORK)
    debugfs("sif %s uid 0" % TARGET, WORK)
    debugfs("sif %s gid 0" % TARGET, WORK)
    debugfs("ea_set -f %s %s security.selinux" % (CTX_FILE, TARGET), WORK)

    print("[bake-ril] verifying")
    r = subprocess.run(["e2fsck", "-fn", WORK], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        die("e2fsck rejected the patched filesystem:\n%s" % r.stdout.decode(errors="replace"))

    stat = debugfs("stat %s" % TARGET, WORK)
    m = re.search(r"Size:\s*(\d+)", stat)
    if not m:
        die("cannot read back the file size")
    got = int(m.group(1))
    if got != want:
        die("size mismatch after write: %d != %d" % (got, want))
    if "vendor_file" not in debugfs("ea_get %s security.selinux" % TARGET, WORK):
        die("SELinux label missing after write")

    if os.path.getsize(WORK) != length:
        die("patched extent changed size (%d != %d)" % (os.path.getsize(WORK), length))

    print("[bake-ril] writing the extent back into super")
    with open(WORK, "rb") as src, open(IMG, "r+b") as dst:
        dst.seek(off)
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)

    os.unlink(WORK)
    os.unlink(CTX_FILE)
    print("[bake-ril] done: %d bytes, root:root 0644, u:object_r:vendor_file:s0" % want)


main()
