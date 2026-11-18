#!/usr/bin/env python3
"""Live Codex model catalog, read from `codex debug models`.

Usage:
  models.py            list the selectable models, newest/most prominent first
  models.py <family>   print the current model id for a family (e.g. astra, sol, luna)
  models.py <model-id> print the id back if it exists in the catalog (validation)

Exits non-zero with a message on stderr when the catalog cannot be read or
the family / id is not found.
"""
import json
import subprocess
import sys


def catalog():
    try:
        out = subprocess.run(
            ["codex", "debug", "models"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        sys.exit(f"cannot run `codex debug models`: {e}")
    if out.returncode != 0:
        sys.exit(f"`codex debug models` failed: {out.stderr.strip()}")
    models = json.loads(out.stdout)["models"]
    listed = [m for m in models if m.get("visibility") == "list"]
    return sorted(listed, key=lambda m: m.get("priority", 99))


def efforts(m):
    levels = m.get("supported_reasoning_levels", [])
    return ",".join(l.get("effort", "?") if isinstance(l, dict) else str(l) for l in levels)


def main():
    models = catalog()
    if len(sys.argv) < 2:
        for m in models:
            print("%-14s ctx=%-8s effort=%-32s %s" % (
                m["slug"], m.get("context_window"), efforts(m), m.get("description", "")))
        return
    want = sys.argv[1].strip().lower()
    for m in models:
        if m["slug"] == want:
            print(m["slug"])
            return
    # Family alias: the first (highest-priority, i.e. newest) listed model of that family.
    for m in models:
        if m["slug"].endswith("-" + want):
            print(m["slug"])
            return
    sys.exit(f"no listed Codex model matches '{want}'; run models.py with no argument to see the catalog")


if __name__ == "__main__":
    main()
