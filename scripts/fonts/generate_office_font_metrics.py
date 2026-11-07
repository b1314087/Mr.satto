#!/usr/bin/env python3
"""
Officeでよく使われるフォントの「文字の幅」と「1行の高さ」の表(src/lib/fonts/office-font-metrics-data.ts)を作る。

Microsoftのフォント(Calibri・Arial・Times New Roman・MS ゴシック等)そのものは同梱できないため、
それらと「文字の幅・高さが同じになるように作られた、自由に使えるフォント」(メトリック互換フォント)から数値だけを取り出す。
  Carlito          → Calibri と同じ幅(SIL OFL)
  Caladea          → Cambria と同じ幅(SIL OFL)
  Liberation Sans  → Arial と同じ幅(SIL OFL)
  Liberation Serif → Times New Roman と同じ幅(SIL OFL)
  Liberation Mono  → Courier New と同じ幅(SIL OFL)
  IPAゴシック       → MS ゴシック/MS 明朝 と同じ幅(英数字は全角の半分、日本語は全角)(IPAフォントライセンス)
  IPA Pゴシック     → MS Pゴシック/MS P明朝 に近い幅(英数字はプロポーショナル)
取り出すのは数値(文字の送り幅・アセント・ディセント・行間)だけで、字形は含めない。

使い方: python3 scripts/fonts/generate_office_font_metrics.py   (fontTools と上のフォントが必要)
"""
import os
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "fonts", "office-font-metrics-data.ts")

SOURCES = [
    ("carlito", "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf", "Calibri と同じ幅(Carlito)"),
    ("caladea", "/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf", "Cambria と同じ幅(Caladea)"),
    ("liberationSans", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Arial と同じ幅(Liberation Sans)"),
    ("liberationSerif", "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf", "Times New Roman と同じ幅(Liberation Serif)"),
    ("liberationMono", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "Courier New と同じ幅(Liberation Mono)"),
    ("ipaGothic", "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "MS ゴシック/MS 明朝 と同じ幅(IPAゴシック)"),
    ("ipaPGothic", "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf", "MS Pゴシック/MS P明朝 に近い幅(IPA Pゴシック)"),
]
# 文字の幅を持つ範囲：ASCII(0x20〜0x7E)とラテン1補助(0xA0〜0xFF)
CODES = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))


def main():
    lines = [
        "// このファイルは scripts/fonts/generate_office_font_metrics.py が作る(手で編集しない)。",
        "// 数値は、Officeのフォントとメトリック互換の自由なフォントから取り出した、文字の送り幅とアセント・ディセント・行間(1em=1000)。",
        "",
        "export interface FontMetricsData {",
        "  /** 説明 */",
        "  note: string;",
        "  /** アセント・ディセント(正の数)・行間(hhea)。Wordの「1行」の高さ ＝ (アセント＋ディセント＋行間) × 文字の大きさ */",
        "  ascent: number;",
        "  descent: number;",
        "  lineGap: number;",
        "  /** 文字コード 0x20〜0x7E・0xA0〜0xFF の送り幅(この順に並ぶ。無い文字は -1) */",
        "  widths: number[];",
        "  /** 上の範囲の外の文字のうち、全角(日本語)の送り幅。null は持たない(英字用のフォント) */",
        "  fullWidth: number | null;",
        "  /** 半角カタカナ(U+FF61〜U+FF9F)の送り幅。null は持たない */",
        "  halfWidthKana: number | null;",
        "}",
        "",
        "export const FONT_METRICS_DATA: Record<string, FontMetricsData> = {",
    ]
    for key, path, note in SOURCES:
        f = TTFont(path)
        upm = f["head"].unitsPerEm
        h = f["hhea"]
        cmap = f.getBestCmap()
        hmtx = f["hmtx"]
        def w(code):
            g = cmap.get(code)
            return round(hmtx[g][0] * 1000 / upm) if g else -1
        widths = [w(c) for c in CODES]
        full = w(0x3042)  # あ
        kana = w(0xFF71)  # ｱ
        lines.append(f"  {key}: {{")
        lines.append(f"    note: {note!r},".replace("'", '"'))
        lines.append(f"    ascent: {round(h.ascent * 1000 / upm)},")
        lines.append(f"    descent: {round(-h.descent * 1000 / upm)},")
        lines.append(f"    lineGap: {round(h.lineGap * 1000 / upm)},")
        lines.append(f"    widths: [{', '.join(map(str, widths))}],")
        lines.append(f"    fullWidth: {full if full > 0 else 'null'},")
        lines.append(f"    halfWidthKana: {kana if kana > 0 else 'null'},")
        lines.append("  },")
    lines.append("};")
    lines.append("")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fp:
        fp.write("\n".join(lines))
    print("書き出し:", os.path.relpath(OUT))


if __name__ == "__main__":
    main()
