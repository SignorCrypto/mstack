#!/usr/bin/env python3
"""Print the service tier a Codex run used, e.g. `priority` (Fast) or `default`.

Usage: tier.py <thread-id>   (the id from the launcher's "Thread ready (...)" line)

Reads the session files (~/.codex/sessions), falling back to ~/.codex/logs_2.sqlite.
Child threads (a review's reviewer) are found through the session files, whose
`session_id` is the parent thread id.
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))


def thread_ids(parent):
    ids = {parent}
    for f in (CODEX_HOME / "sessions").glob(f"*/*/*/*.jsonl"):
        if f.stat().st_size == 0:
            continue
        with f.open() as fh:
            meta = json.loads(fh.readline()).get("payload", {})
        if meta.get("session_id") == parent or meta.get("parent_thread_id") == parent:
            ids.add(meta.get("id"))
    return sorted(i for i in ids if i)


def session_tiers(tid):
    # The launcher's own app-server exits with the call and may not flush logs_2.sqlite,
    # but the session file always records the thread settings.
    tiers = set()
    for f in (CODEX_HOME / "sessions").glob(f"*/*/*/*-{tid}.jsonl"):
        tiers.update(re.findall(r'"service_tier":"([a-z]+)"', f.read_text()))
    return tiers


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    db = sqlite3.connect(f"file:{CODEX_HOME / 'logs_2.sqlite'}?mode=ro", uri=True)
    result = {}
    for tid in thread_ids(sys.argv[1]):
        tiers = session_tiers(tid)
        if not tiers:
            rows = db.execute(
                "select distinct substr(feedback_log_body, instr(feedback_log_body, '\"service_tier\":\"') + 16, 12) "
                "from logs where thread_id = ? and feedback_log_body like '%\"service_tier\":\"%'", (tid,))
            tiers = {r[0].split('"')[0] for r in rows}
        result[tid] = sorted(tiers)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
