#!/usr/bin/env python3
"""
Officeでよく使われるフォントの「文字の幅」と「1行の高さ」の表(src/lib/fonts/office-font-metrics-data.ts)を作る。

数値の出どころは2つ(どちらも数値だけで、字形・フォントのファイルは含めない):
  1. 実際のOfficeのフォントから取り出した数値(scripts/fonts/office-measured-metrics.json。
     scripts/fonts/extract_office_font_metrics.py が、Microsoft Office for Mac のフォントから取り出す):
     游ゴシック(Regular/Medium/Light/Bold/UI)・游明朝(Regular/Demibold)・メイリオ(Regular/Bold/UI)・
     MS ゴシック/Pゴシック/UI Gothic・MS 明朝/P明朝・Century・Calibri(Regular/Bold)・Cambria・Aptos(Regular/Bold)・
     HG ゴシックE/明朝E/創英角ゴシックUB/丸ゴシックM-PRO(とP・S付きの書体)
  2. Office に入っていないフォント(Arial・Times New Roman・Courier New)は、それらと文字の幅・高さが同じになるように
     作られた自由なフォント(メトリック互換フォント)から取り出す:
       Liberation Sans → Arial、Liberation Serif → Times New Roman、Liberation Mono → Courier New(SIL OFL)
     IPAゴシック/IPA Pゴシック(IPAフォントライセンス)は、文書がIPAフォントを指定したときに使う。

使い方: python3 scripts/fonts/generate_office_font_metrics.py   (fontTools と、2. のフォントが必要)
"""
import json
import os
import unicodedata

from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "fonts", "office-font-metrics-data.ts")
MEASURED = os.path.join(HERE, "office-measured-metrics.json")

COMPATIBLE = [
    ("liberationSans", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Arial と同じ幅(Liberation Sans)", ["Arial", "Helvetica", "Liberation Sans"]),
    ("liberationSerif", "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf", "Times New Roman と同じ幅(Liberation Serif)", ["Times New Roman", "Times", "Liberation Serif"]),
    ("liberationMono", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "Courier New と同じ幅(Liberation Mono)", ["Courier New", "Courier", "Liberation Mono"]),
    ("ipaGothic", "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "IPAゴシック", ["IPAGothic", "IPAゴシック"]),
    ("ipaPGothic", "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf", "IPA Pゴシック", ["IPAPGothic", "IPA Pゴシック", "IPAPゴシック"]),
]
# 太字の書体(太字の文字の幅に使う)
BOLD = {"yuGothic": "yuGothicBold", "yuGothicUI": "yuGothicUIBold", "meiryo": "meiryoBold", "meiryoUI": "meiryoUIBold", "calibri": "calibriBold", "aptos": "aptosBold"}
# 書体の名前のほかに、文書で使われる名前(フォント名の別名)
EXTRA_ALIASES = {
    "calibri": ["Calibri Light", "Carlito"],
    "cambria": ["Caladea"],
    "yuGothic": ["游ゴシック体", "YuGothic", "游ゴシック Regular", "Yu Gothic Regular"],
    "yuGothicMedium": ["游ゴシック体 Medium", "YuGothic Medium"],
    "yuMincho": ["游明朝体", "YuMincho", "游明朝 Regular", "Yu Mincho Regular"],
    "yuMinchoDemibold": ["游明朝体 Demibold", "YuMincho Demibold"],
    "msGothic": ["MSゴシック"],
    "msMincho": ["MS明朝"],
    "msPGothic": ["MSPゴシック"],
    "msPMincho": ["MSP明朝"],
}
LATIN = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))


def norm(name: str) -> str:
    """フォント名をそろえる(全角・半角の英数字とカタカナ、大文字・小文字、空白の違いをなくす)。TypeScript側の normalize と同じ"""
    return " ".join(unicodedata.normalize("NFKC", name).strip().lower().split())


def main():
    data = {}
    aliases = {}
    for f in json.load(open(MEASURED, encoding="utf-8")):
        key = f["key"]
        data[key] = {
            "note": f"{f['familyJa'] or f['family']} {f['style'] or ''}(Officeのフォントから取り出した数値)".replace(" (", "("),
            "source": "measured",
            "ascent": f["hhea"][0],
            "descent": f["hhea"][1],
            "lineGap": f["hhea"][2],
            "winAscent": f["win"][0],
            "winDescent": f["win"][1],
            "widths": f["latin"],
            "fullWidth": f["fullWidth"],
            "halfWidthKana": f["halfWidthKana"],
            "cjk": f["cjk"],
            "bold": BOLD.get(key),
        }
        if not key.endswith("Bold") or key == "yuMinchoDemibold":
            for n in [f["family"], f["familyJa"], *EXTRA_ALIASES.get(key, [])]:
                if n:
                    aliases.setdefault(norm(n), key)
    for key, path, note, names in COMPATIBLE:
        font = TTFont(path)
        upm = font["head"].unitsPerEm
        k = 1000 / upm
        h = font["hhea"]
        os2 = font["OS/2"]
        cmap = font.getBestCmap()
        hmtx = font["hmtx"]

        def w(code):
            g = cmap.get(code)
            return round(hmtx[g][0] * k) if g else -1

        full = w(0x4E00) if w(0x4E00) > 0 else w(0x3042)
        kana = w(0xFF71)
        data[key] = {
            "note": f"{note}(メトリック互換フォントから取り出した数値)",
            "source": "compatible",
            "ascent": round(h.ascent * k),
            "descent": round(-h.descent * k),
            "lineGap": round(h.lineGap * k),
            "winAscent": round(os2.usWinAscent * k),
            "winDescent": round(os2.usWinDescent * k),
            "widths": [w(c) for c in LATIN],
            "fullWidth": full if full > 0 else None,
            "halfWidthKana": kana if kana > 0 else None,
            "cjk": {},
            "bold": None,
        }
        for n in names:
            aliases.setdefault(norm(n), key)

    lines = [
        "// このファイルは scripts/fonts/generate_office_font_metrics.py が作る(手で編集しない)。",
        "// 数値は、文字の送り幅と縦の寸法(1em=1000)だけ。字形・フォントのファイルは含めない。",
        "",
        "export interface FontMetricsData {",
        "  /** 説明(どのフォントの数値か) */",
        "  note: string;",
        "  /** measured=実際のOfficeのフォントから取り出した数値、compatible=メトリック互換の自由なフォントから取り出した数値 */",
        '  source: "measured" | "compatible";',
        "  /** hhea のアセント・ディセント(正の数)・行間 */",
        "  ascent: number;",
        "  descent: number;",
        "  lineGap: number;",
        "  /** OS/2 の usWinAscent・usWinDescent(Windowsの文字の描画(GDI)が、1行の高さに使う) */",
        "  winAscent: number;",
        "  winDescent: number;",
        "  /** 文字コード 0x20〜0x7E・0xA0〜0xFF の送り幅(この順に並ぶ。無い文字は -1) */",
        "  widths: number[];",
        "  /** 全角(漢字)の送り幅。null は持たない(英字用のフォント) */",
        "  fullWidth: number | null;",
        "  /** 半角カタカナ(U+FF61〜U+FF9F)の送り幅。null は持たない */",
        "  halfWidthKana: number | null;",
        "  /** 日本語の記号・仮名などで、全角(半角カナは halfWidthKana)と違う幅の文字(文字コード → 送り幅) */",
        "  cjk: Record<string, number>;",
        "  /** 太字の書体の表の名前(太字の文字の幅に使う)。無ければ null */",
        "  bold: string | null;",
        "}",
        "",
        "export const FONT_METRICS_DATA: Record<string, FontMetricsData> = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";",
        "",
        "/** フォント名(normalize したもの) → 表の名前 */",
        "export const FONT_ALIASES: Record<string, string> = " + json.dumps(dict(sorted(aliases.items())), ensure_ascii=False, separators=(",", ":")) + ";",
        "",
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fp:
        fp.write("\n".join(lines))
    print("書き出し:", os.path.relpath(OUT), len(data), "書体", len(aliases), "別名")


if __name__ == "__main__":
    main()
