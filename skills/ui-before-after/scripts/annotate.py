"""Before/after composites with numbered callouts.

Usage: python3 -I annotate.py spec.json

spec.json:
{
  "viewport": [1728, 1000],                 # CSS px of the captures; boxes use these coordinates
  "out_dir": "/abs/scratchpad/recap",
  "labels": {"before": "PRIMA", "after": "DOPO"},
  "panels": [
    {
      "name": "01-chat",
      "before": "/abs/before/chat.png",     # retina captures are fine: resized to the viewport
      "after": "/abs/after/chat.png",
      "before_marks": [{"n": 1, "box": [x1, y1, x2, y2], "label": "short problem", "label_at": [x, y]}],
      "after_marks":  [{"n": 1, "box": [x1, y1, x2, y2], "label": "short fix", "label_at": [x, y]}],
      "legend": [[1, "One sentence: what changed and why, with the number (34px → 22px)."]]
    }
  ]
}
A mark with an empty label draws only the box and its number. Boxes larger than ~120k px² get an outline only,
so the content under them stays readable; small boxes also get a light tint.
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

spec = json.load(open(sys.argv[1]))
W, H = spec.get("viewport", [1728, 1000])
OUT = spec["out_dir"]
LABELS = spec.get("labels", {"before": "PRIMA", "after": "DOPO"})
RED = (220, 38, 38)
GREEN = (22, 163, 74)
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
f_title = ImageFont.truetype(BOLD, 34)
f_note = ImageFont.truetype(BOLD, 19)
f_num = ImageFont.truetype(BOLD, 20)
f_legend = ImageFont.truetype(REG, 21)
f_legend_b = ImageFont.truetype(BOLD, 21)


def load(path):
    return Image.open(path).convert("RGB").resize((W, H), Image.LANCZOS)


def mark(img, marks, color):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for m in marks:
        x1, y1, x2, y2 = m["box"]
        if (x2 - x1) * (y2 - y1) < 120_000:
            od.rectangle(m["box"], fill=color + (28,))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    d = ImageDraw.Draw(img)
    for m in marks:
        box = m["box"]
        d.rectangle(box, outline=color, width=4)
        r, (cx, cy) = 17, box[:2]
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color, outline="white", width=3)
        d.text((cx, cy), str(m["n"]), font=f_num, fill="white", anchor="mm")
        if m.get("label"):
            lx, ly = m["label_at"]
            tw = d.textlength(m["label"], font=f_note)
            d.rounded_rectangle((lx - 10, ly - 7, lx + tw + 10, ly + 28), radius=8, fill=color)
            d.text((lx, ly), m["label"], font=f_note, fill="white")
    return img


for p in spec["panels"]:
    b = mark(load(p["before"]), p.get("before_marks", []), RED)
    a = mark(load(p["after"]), p.get("after_marks", []), GREEN)
    pad, head = 40, 50
    legend = p.get("legend", [])
    out = Image.new("RGB", (W * 2 + pad * 3, H + head + pad * 2 + 44 + 34 * len(legend)), (250, 249, 246))
    d = ImageDraw.Draw(out)
    d.text((pad, pad - 6), LABELS["before"], font=f_title, fill=RED)
    d.text((pad * 2 + W, pad - 6), LABELS["after"], font=f_title, fill=GREEN)
    top = pad + head
    for x, im in ((pad, b), (pad * 2 + W, a)):
        out.paste(im, (x, top))
        d.rectangle((x, top, x + W, top + H), outline=(200, 200, 200), width=2)
    y = top + H + 30
    for n, text in legend:
        d.text((pad, y), f"{n}.", font=f_legend_b, fill=(30, 30, 30))
        d.text((pad + 34, y), text, font=f_legend, fill=(30, 30, 30))
        y += 34
    out.save(f"{OUT}/{p['name']}.png", optimize=True)
    print(f"{OUT}/{p['name']}.png")
