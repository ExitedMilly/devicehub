#!/usr/bin/env python3
"""Removes budtmo's /etc/passwd self-destruct from emulator.py.

Stock change_permission() runs two commands:

    cmds = (f"sudo chown 1300:1301 {kvm_path}",
            "sudo sed -i '1d' /etc/passwd")

The chown is what gives androidusr access to /dev/kvm. The sed then deletes line
1 of /etc/passwd -- the root entry -- deliberately breaking sudo behind itself.

That works exactly once per container filesystem. Docker recreates /dev/kvm as
root:kvm(993) on every container start, so the chown is needed on every start;
but after the first start sudo is dead ("sudo: unknown user root"), the chown
fails, qemu never launches, and every dependent service (d_screen, d_wm,
vnc_server, appium) cascades into FATAL. In other words a stock container cannot
survive `docker restart` or a host reboot without someone hand-restoring the
root line -- which is how emulator-test3 died after a reboot on 2026-07-15.

Keep the chown, drop the sed. The tuple has to be closed on the first line, so
this is a replacement rather than a line deletion: dropping the second line alone
would leave an unterminated tuple and a SyntaxError.
"""
import ast
import sys

F = "/home/androidusr/docker-android/cli/src/device/emulator.py"

OLD = '''            cmds = (f"sudo chown 1300:1301 {kvm_path}",
                    "sudo sed -i '1d' /etc/passwd")'''
NEW = '''            cmds = (f"sudo chown 1300:1301 {kvm_path}",)'''

with open(F) as fh:
    src = fh.read()

if OLD not in src:
    if "/etc/passwd" not in src:
        print("[disarm] self-destruct already absent, nothing to do")
        sys.exit(0)
    sys.exit("[disarm] emulator.py does not match the expected snippet -- "
             "base image changed, refusing to guess")

src = src.replace(OLD, NEW)

# Never leave behind a file that would not import.
ast.parse(src)

if "/etc/passwd" in src:
    sys.exit("[disarm] /etc/passwd still referenced after the patch")
if "sudo chown 1300:1301" not in src:
    sys.exit("[disarm] the /dev/kvm chown went missing -- it is still required")

with open(F, "w") as fh:
    fh.write(src)

print("[disarm] /etc/passwd self-destruct removed; /dev/kvm chown kept")
