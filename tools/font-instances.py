#!/usr/bin/env python3
"""Make static Inter TTFs from the site's variable woff2, for rendering og.png.

The site itself only ships the variable woff2. resvg needs plain TTFs, so this
writes them to tools/.cache/ (not committed). Needs: pip install fonttools brotli
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src" / "assets" / "fonts" / "inter-5.3.0-latin-wght.woff2"
OUT = HERE / ".cache"
WEIGHTS = {"SemiBold": 600, "Bold": 700}

OUT.mkdir(exist_ok=True)
for style, weight in WEIGHTS.items():
    font = TTFont(SRC)
    font.flavor = None
    static = instancer.instantiateVariableFont(font, {"wght": weight}, updateFontNames=True)
    static["OS/2"].usWeightClass = weight
    path = OUT / f"Inter-{style}.ttf"
    static.save(path)
    print(f"wrote {path.relative_to(HERE.parent)}")
