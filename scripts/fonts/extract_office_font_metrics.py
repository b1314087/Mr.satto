#!/usr/bin/env python3
"""
Officeのフォント(游ゴシック・游明朝・メイリオ・MS ゴシック/明朝・Century・Calibri・Aptos・HG フォント等)から、
レイアウトの計算に使う「数値だけ」を取り出して、scripts/fonts/office-measured-metrics.json に書く。

取り出すのは、文字の送り幅(英数字・ラテン1・日本語の記号/仮名)と、縦の寸法(hhea・OS/2 の win)だけ。
字形(文字の形)・フォントのファイルそのものは、取り出さない・同梱しない(PDFに描く字形は、同梱の Noto Sans JP)。

これらのフォントは自由に再配布できないので、リポジトリには数値だけを置く。フォントは、Microsoft Office for Mac に
入っているもの(Microsoft Word.app/Contents/Resources/DFonts)を、利用者のパソコンの中で読んだ。

使い方(Officeのフォントのあるパソコンで):
  python3 scripts/fonts/extract_office_font_metrics.py "/Applications/Microsoft Word.app/Contents/Resources/DFonts"
その後:
  python3 scripts/fonts/generate_office_font_metrics.py   (src/lib/fonts/office-font-metrics-data.ts を作る)
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "office-measured-metrics.json")

# (ファイル名, TTCの中の番号, 表の名前)。太字は、文字の幅が違うので別に持つ
FACES = [
    ("YuGothR.ttc", 0, "yuGothic"),
    ("YuGothB.ttc", 0, "yuGothicBold"),
    ("YuGothM.ttc", 0, "yuGothicMedium"),
    ("YuGothL.ttc", 0, "yuGothicLight"),
    ("YuGothM.ttc", 1, "yuGothicUI"),
    ("YuGothB.ttc", 1, "yuGothicUIBold"),
    ("yumin.ttf", 0, "yuMincho"),
    ("yumindb.ttf", 0, "yuMinchoDemibold"),
    ("meiryo.ttc", 0, "meiryo"),
    ("meiryob.ttc", 0, "meiryoBold"),
    ("meiryo.ttc", 2, "meiryoUI"),
    ("meiryob.ttc", 2, "meiryoUIBold"),
    ("msgothic.ttc", 0, "msGothic"),
    ("msgothic.ttc", 1, "msUIGothic"),
    ("msgothic.ttc", 2, "msPGothic"),
    ("msmincho.ttc", 0, "msMincho"),
    ("msmincho.ttc", 1, "msPMincho"),
    ("Century.ttf", 0, "century"),
    ("Calibri.ttf", 0, "calibri"),
    ("Calibrib.ttf", 0, "calibriBold"),
    ("Cambria.ttc", 0, "cambria"),
    ("Aptos.ttf", 0, "aptos"),
    ("Aptos-Bold.ttf", 0, "aptosBold"),
    ("HGRGE.ttc", 0, "hgGothicE"),
    ("HGRGE.ttc", 1, "hgpGothicE"),
    ("HGRGE.ttc", 2, "hgsGothicE"),
    ("HGRME.ttc", 0, "hgMinchoE"),
    ("HGRME.ttc", 1, "hgpMinchoE"),
    ("HGRME.ttc", 2, "hgsMinchoE"),
    ("HGRSGU.ttc", 0, "hgSoeiKakugothicUB"),
    ("HGRSGU.ttc", 1, "hgpSoeiKakugothicUB"),
    ("HGRSGU.ttc", 2, "hgsSoeiKakugothicUB"),
    ("HGRSMP.ttf", 0, "hgMaruGothicMPRO"),
]
# 英数字・ラテン1(この順に並べる)
LATIN = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
# 日本語の記号・仮名・全角英数・半角カナ・よく使う記号(全角と違う幅のものだけを持つ)
CJK = [0x4E00] + list(range(0x3000, 0x3100)) + list(range(0xFF01, 0xFFA0)) + [0x2014, 0x2015, 0x2018, 0x2019, 0x201C, 0x201D, 0x2025, 0x2026, 0x203B, 0x2190, 0x2191, 0x2192, 0x2193, 0x25A0, 0x25A1, 0x25B2, 0x25B3, 0x25CB, 0x25CF, 0x2605, 0x2606]


def compact(raw: dict, key: str) -> dict:
    """1つの書体の数値を、1em=1000 にそろえ、全角と同じ幅の日本語の文字を省いた形にする"""
    upm = raw["upm"]
    k = 1000 / upm
    # 全角の幅：漢字(一)の幅。漢字の無い書体は「あ」の幅(プロポーショナルの書体は、仮名が全角より狭い)
    full = raw["cjk"].get(0x4E00) or raw["cjk"].get("19968") or raw["cjk"].get(0x3042) or raw["cjk"].get("12354")
    full = round(full * k) if full else None
    half = raw["cjk"].get(0xFF71) or raw["cjk"].get("65393")
    half = round(half * k) if half else None
    exceptions = {}
    for cp_s, v in raw["cjk"].items():
        cp = int(cp_s)
        w = round(v * k)
        expect = half if 0xFF61 <= cp <= 0xFF9F else full
        if w != expect:
            exceptions[str(cp)] = w
    return {
        "key": key,
        "family": raw["family"],
        "familyJa": raw.get("familyJa"),
        "style": raw.get("sub"),
        "hhea": [round(raw["hhea"][0] * k), round(-raw["hhea"][1] * k), round(raw["hhea"][2] * k)],
        "win": [round(raw["win"][0] * k), round(raw["win"][1] * k)],
        "latin": [round(v * k) if v is not None else -1 for v in raw["latin"]],
        "fullWidth": full,
        "halfWidthKana": half,
        "cjk": exceptions,
    }


def read_face(path: str, index: int) -> dict:
    from fontTools.ttLib import TTCollection, TTFont

    f = TTCollection(path).fonts[index] if path.lower().endswith(".ttc") else TTFont(path)
    cmap = f.getBestCmap()
    hmtx = f["hmtx"].metrics

    def name(nid: int, lang: int):
        for rec in f["name"].names:
            if rec.nameID == nid and rec.platformID == 3 and rec.langID == lang:
                return rec.toUnicode()
        return None

    def w(cp: int):
        g = cmap.get(cp)
        return hmtx[g][0] if g in hmtx else None

    os2 = f["OS/2"]
    hh = f["hhea"]
    return {
        "family": name(1, 0x409),
        "familyJa": name(1, 0x411),
        "sub": name(2, 0x409),
        "upm": f["head"].unitsPerEm,
        "hhea": [hh.ascent, hh.descent, hh.lineGap],
        "win": [os2.usWinAscent, os2.usWinDescent],
        "latin": [w(c) for c in LATIN],
        "cjk": {c: w(c) for c in CJK if w(c) is not None},
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    folder = sys.argv[1]
    faces = [compact(read_face(os.path.join(folder, fn), idx), key) for fn, idx, key in FACES]
    with open(OUT, "w", encoding="utf-8") as fp:
        json.dump(faces, fp, ensure_ascii=False, indent=0)
    print("書き出し:", os.path.relpath(OUT), len(faces), "書体")


if __name__ == "__main__":
    main()
