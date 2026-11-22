#!/usr/bin/env python3
"""Generate or edit images with Codex's built-in `image_gen` tool.

The image model is picked by OpenAI server-side (the latest rolled out to Codex,
ChatGPT Images 2.5 since 2026-09-08); the tool takes no model argument.

Runs through the call-codex launcher (codex.sh, `codex exec`) with the current `sol`
model and a read-only sandbox, on the ChatGPT subscription.
The image file is located on disk under $CODEX_HOME/generated_images/<thread-id>/,
not taken from Codex's self-report, then copied to --out.

Usage:
  image.py --prompt-file p.md --out assets/hero.png
  image.py --prompt-file p.md --out icon.png --transparent
  image.py --prompt-file p.md --out hero-v2.png --ref /abs/hero.png [--ref ...]
  image.py --prompt-file p.md --out variant.png --n 3   # variant-1.png .. variant-3.png

Prints one JSON line: {"ok": true, "files": [...], "thread": "...", "codex_message": "..."}.
Exits non-zero with {"ok": false, "error": "..."} on failure. Never overwrites an
existing file unless --overwrite is given.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
IMAGES = CODEX_HOME / "generated_images"


def fail(msg, code=1):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(code)


def build_prompt(user_prompt, n, transparent, refs):
    lines = [
        "Use the built-in `image_gen` tool "
        f"to produce exactly {n} image{'s' if n > 1 else ''}"
        + (", one `image_gen` call per image, each a distinct variant of the request." if n > 1 else ", with one `image_gen` call."),
        f"Set `transparent_background` to {'true' if transparent else 'false'}.",
    ]
    if refs:
        lines.append(
            "Pass these files as `referenced_image_paths` (use `view_image` on them first if needed): "
            + json.dumps([str(r) for r in refs])
            + ". Treat them as described in the request below (edit target or reference)."
        )
    else:
        lines.append("Omit `referenced_image_paths` and `num_last_images_to_include`: this is a new image.")
    lines += [
        "Do not run shell commands and do not copy or move files: the caller collects the output.",
        'When done, reply with one line of JSON only: {"ok": true|false, "note": "<one short sentence>"}',
        "",
        "## Request",
        "",
        user_prompt.strip(),
    ]
    return "\n".join(lines) + "\n"


def out_paths(out, n):
    if n == 1:
        return [out]
    return [out.with_name(f"{out.stem}-{i}{out.suffix}") for i in range(1, n + 1)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prompt-file", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path, help="destination file (.png); with --n > 1, -1/-2/... suffixes")
    ap.add_argument("--n", type=int, default=1, help="number of variants, 1-4 (one built-in call each)")
    ap.add_argument("--transparent", action="store_true", help="ask for a transparent background")
    ap.add_argument("--ref", action="append", default=[], type=Path, help="reference / edit-target image (repeatable)")
    ap.add_argument("--model", help="Codex model id; default: current `sol` from models.py")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()

    if not 1 <= a.n <= 4:
        fail("--n must be between 1 and 4")
    if not a.prompt_file.is_file():
        fail(f"prompt file not found: {a.prompt_file}")
    refs = [r.expanduser().resolve() for r in a.ref]
    for r in refs:
        if not r.is_file():
            fail(f"reference image not found: {r}")
    out = a.out.expanduser().resolve()
    if out.suffix.lower() != ".png":
        fail("--out must end in .png (the built-in tool saves PNG)")
    dests = out_paths(out, a.n)
    if not a.overwrite:
        taken = [str(d) for d in dests if d.exists()]
        if taken:
            fail(f"destination exists (pass --overwrite or pick a versioned name): {taken}")

    model = a.model
    if not model:
        r = subprocess.run([sys.executable, str(SKILL / "models.py"), "sol"],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True)
        if r.returncode != 0:
            fail(f"cannot resolve sol model: {r.stderr.strip()}")
        model = r.stdout.strip()

    prompt = build_prompt(a.prompt_file.read_text(), a.n, a.transparent, refs)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(prompt)
        prompt_path = f.name
    try:
        # Images skip the launcher's Fast tier and effort defaults: config.toml's effort applies.
        r = subprocess.run(
            [str(SKILL / "codex.sh"), "--model", model, "--no-fast", "--effort", "config",
             "--prompt-file", prompt_path],
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
        )
    finally:
        os.unlink(prompt_path)
    # The launcher prints the final message, then one JSON summary line.
    lines = r.stdout.strip().splitlines()
    try:
        summary = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        summary = {}
    thread = summary.get("thread_id")
    if r.returncode != 0 or not thread:
        fail(f"codex task failed (exit {r.returncode}): {summary.get('error') or (r.stdout + r.stderr).strip()[-1500:]}")

    generated = sorted((IMAGES / thread).glob("*.png"), key=lambda p: p.stat().st_mtime) \
        if (IMAGES / thread).is_dir() else []
    message = lines[-2] if len(lines) > 1 else ""
    if len(generated) < a.n:
        fail(f"expected {a.n} image(s) in {IMAGES / thread}, found {len(generated)}; codex said: {message}")

    out.parent.mkdir(parents=True, exist_ok=True)
    for src, dst in zip(generated[-a.n:], dests):
        shutil.copy2(src, dst)
    print(json.dumps({"ok": True, "files": [str(d) for d in dests], "thread": thread,
                      "model": model, "codex_message": message}))


if __name__ == "__main__":
    main()
