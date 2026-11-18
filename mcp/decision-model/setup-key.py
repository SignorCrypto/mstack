#!/usr/bin/env python3
"""Store a decision-model provider key in the OS secret store.

Usage: python3 setup-key.py [KEY_NAME]   (default AI_GATEWAY_API_KEY)

macOS: the Keychain. Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`
(package libsecret-tools or libsecret). The key is read with hidden input and handed to the store over
stdin, so it never lands in shell history, process arguments, or chat. An existing entry is replaced.
Without a store (e.g. a headless server), use a key command or the environment: see the README.
"""
import getpass
import re
import shutil
import subprocess
import sys

SERVICE = "decision-model"  # must match KEYCHAIN_SERVICE in src/secrets.mjs
name = sys.argv[1] if len(sys.argv) > 1 else "AI_GATEWAY_API_KEY"
if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
    sys.exit(f"Invalid key name: {name}")


def lookup():
    if sys.platform == "darwin":
        cmd = ["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"]
    else:
        cmd = ["secret-tool", "lookup", "service", SERVICE, "account", name]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def store(key):
    if sys.platform == "darwin":
        escaped = key.replace("\\", "\\\\").replace('"', '\\"')
        r = subprocess.run(["/usr/bin/security", "-i"], text=True, capture_output=True,
                           input=f'add-generic-password -U -s "{SERVICE}" -a "{name}" -w "{escaped}"\n')
        # Interactive `security` can exit 0 even when the subcommand fails.
        return not (r.returncode or "SecKeychain" in r.stderr or "error" in r.stderr.lower())
    r = subprocess.run(["secret-tool", "store", "--label", f"{SERVICE} {name}", "service", SERVICE, "account", name],
                       input=key, text=True, capture_output=True)
    return r.returncode == 0


if sys.platform == "darwin":
    where = "the macOS Keychain"
elif sys.platform.startswith("linux") and shutil.which("secret-tool"):
    where = "the Secret Service"
else:
    sys.exit(f"No secret store here (macOS Keychain, or secret-tool on Linux). Use a key command or set {name} "
             "in the MCP server environment: see the decision-model README.")

key = getpass.getpass(f"{name} (hidden input): ").strip()
if not key or any(ord(c) < 32 for c in key):
    sys.exit("Empty or invalid key; nothing changed.")
if not store(key) or lookup() != key:
    sys.exit(f"Could not save or verify the key in {where} (is it unlocked?). No key shown.")
print(f"{name} saved in {where}. It applies on the next call.")
