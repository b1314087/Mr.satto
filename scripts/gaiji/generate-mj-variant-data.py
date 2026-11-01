#!/usr/bin/env python3
"""
外字・特殊文字チェック用：MJ縮退マップから「形の違う字」のデータ（src/lib/gaiji/mj-variant-data.ts）を作る。

使い方（開発者向け。サイトの動作には不要）:
  1. npm pack @mandel59/mojidata@1.9.3 で取得し、展開した package/dist/moji.db を用意する（依存関係には入れない）
  2. python3 scripts/gaiji/generate-mj-variant-data.py <moji.db のパス> src/lib/gaiji/mj-variant-data.ts

使うデータ: MJ縮退マップ Ver.1.2.0 と MJ文字情報一覧表 Ver.006.02（© IPA、CC BY-SA 2.1 JP）。
「辞書類等による関連字」「読み字形による類推」は、関係がゆるいため使わない。
"""
import sqlite3
import sys
import unicodedata
from collections import OrderedDict

EXCLUDED_TABLES = ("辞書類等による関連字", "読み字形による類推")


def is_vs(ch: str) -> bool:
    cp = ord(ch)
    return 0xE0100 <= cp <= 0xE01EF or 0xFE00 <= cp <= 0xFE0F


def main(db_path: str, out_path: str) -> None:
    con = sqlite3.connect(db_path)
    rows = con.execute(
        """
        SELECT s.縮退UCS, m.MJ文字図形名, m.実装したUCS, m.実装したMoji_JohoコレクションIVS, s.表
        FROM mjsm s JOIN mji m USING (MJ文字図形名)
        ORDER BY s.縮退UCS, m.MJ文字図形名
        """
    ).fetchall()
    groups: "OrderedDict[str, OrderedDict[str, str]]" = OrderedDict()
    for base, mj, ucs, ivs, table in rows:
        if table in EXCLUDED_TABLES or not base or len(base) != 1:
            continue
        if unicodedata.normalize("NFC", base) != base:
            continue
        glyph = ucs or ivs
        if not glyph:
            continue
        # 正規化（NFC）で変わる字（互換漢字の一部）は、貼り付けで別の字になるため除く
        if any(unicodedata.normalize("NFC", c) != c for c in glyph if not is_vs(c)):
            continue
        if glyph == base:
            continue
        g = groups.setdefault(base, OrderedDict())
        # 異体字セレクタ付きの字は、形を確かめられるよう MJ文字図形名の数字を付ける
        g.setdefault(glyph, mj[2:] if len(glyph) > 1 else "")
    lines = []
    for base, glyphs in sorted(groups.items(), key=lambda kv: ord(kv[0])):
        tokens = [g + ("#" + n if n else "") for g, n in glyphs.items()]
        lines.append(base + " " + " ".join(tokens))
    body = "\n".join(lines)
    header = """/**
 * 外字・特殊文字チェック：戸籍・住民基本台帳・入管などで使われる、形の違う字（MJ文字）の一覧（自動生成。手で直さない）。
 * 作り方：scripts/gaiji/generate-mj-variant-data.py
 *
 * 1行が1つの字：「元の字 形違いの字 形違いの字 …」。
 * 形違いの字が「#数字」付きのときは、異体字セレクタ付きの字で、数字は MJ文字図形名（MJ を除いた部分）。
 *
 * このファイルのデータは、次の著作物を加工したもの（CC BY-SA 2.1 JP。このファイルにも同じライセンスが適用される）:
 *   文字情報基盤 MJ縮退マップ Ver.1.2.0 / MJ文字情報一覧表 Ver.006.02
 *   Copyright © IPA 独立行政法人情報処理推進機構（Information-technology Promotion Agency, Japan）
 *   提供：一般社団法人 文字情報技術促進協議会 https://moji.or.jp/mojikiban/
 *   ライセンス：クリエイティブ・コモンズ 表示 – 継承 2.1 日本 https://creativecommons.org/licenses/by-sa/2.1/jp/
 *   加工の内容：縮退マップの「辞書類等による関連字」「読み字形による類推」を除き、縮退先の字ごとに、
 *   実装したUCS（無ければ Moji_Joho コレクションの IVS）を並べた。正規化（NFC）で変わる字を除いた。
 *   取得元：@mandel59/mojidata 1.9.3（MJデータを SQLite に変換したもの。Copyright (c) 2020 Ryusei Yamaguchi、ソースは MIT）
 *   文字情報技術促進協議会・IPA は、この加工したデータを保証しない。
 */
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("export const MJ_VARIANT_DATA = `\n")
        f.write(body)
        f.write("\n`;\n")
    print(f"bases={len(groups)} glyphs={sum(len(g) for g in groups.values())} bytes={len(body.encode())}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
