"""Erzeugt die App-Icons (PNG) für Homescreen und Manifest.

Aufruf: python3 scripts/make_icons.py   (braucht Pillow)
Motiv: schwarzer Grund, grüner Restzeit-Ring, „AL“.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 1024
img = Image.new("RGB", (S, S), (0, 0, 0))
d = ImageDraw.Draw(img)
pad, w = 150, 70
box = [pad, pad, S - pad, S - pad]
d.arc(box, 0, 360, fill=(44, 44, 46), width=w)
d.arc(box, -90, 180, fill=(48, 209, 88), width=w)

font = None
for cand in [
    "/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]:
    if Path(cand).exists():
        font = ImageFont.truetype(cand, 300)
        break
text = "AL"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((S - tw) / 2 - bbox[0], (S - th) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255))

for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
print("Icons geschrieben nach", OUT)
