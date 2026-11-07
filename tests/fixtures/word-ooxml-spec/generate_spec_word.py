#!/usr/bin/env python3
"""
Word→PDF：OOXMLの仕様に沿った検証用のDOCX(WordprocessingMLを直接書く)と、その期待値を作る。

期待値は、Mr.Sattoの変換結果ではなく、OOXMLの仕様(各要素の意味)と、計算で決まるレイアウトの性質から決める。
  - 内容コントロール(w:sdt)の中の段落・表、入れ子の表、表のセルの中の画像、ハイパーリンク、すべて大文字(w:caps)
    → 文字・画像が、ちょうど1回ずつ出る(以前は失われていたもの)
  - 段落スタイルの「段落の前で改ページ」(w:pageBreakBefore) → スタイルを使う段落が、新しいページから始まる
  - 表の行のページの分け方(w:cantSplit・行の高さの固定 w:hRule="exact"・タイトル行の繰り返し)
    → 行の高さを固定した文字(1行20pt)だけで作り、1ページに入る行の数が計算で決まるようにする
  - 日本語の禁則(行頭・行末の禁則、句読点のぶら下げ、分離禁止、禁則のレベル w:strictFirstAndLastChars)
    → 全角の文字の幅(10.5pt)だけで作り、1行の文字の数(42文字)が計算で決まるようにする
  - 英単語を途中で分けない → PDFの英単語が、すべて元の単語のどれかと同じ
本文の幅は 595.3 - 72×2 = 451.3pt、本文の高さは 841.9 - 72×2 = 697.9pt(A4・余白72pt)。

使い方:  python3 tests/fixtures/word-ooxml-spec/generate_spec_word.py
出力先:  tests/fixtures/static/word-ooxml-spec/*.docx と *.expect.json。データはすべて架空。
"""
from __future__ import annotations

import os
import sys
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, "..", "word-page-fidelity"))
import generate_word_fixtures as w  # noqa: E402

w.OUT = os.path.join(HERE, "..", "static", "word-ooxml-spec")
TW = w.TW
EMU = w.EMU
JA = "あ"  # 全角(10.5pt)の文字。本文の幅に42文字入る(43文字目は 451.5pt > 451.3pt)
EN_WORDS = ["layout", "engine", "paragraph", "document", "measure", "boundary", "consistent", "rendering", "kinsoku", "spacing", "table", "section"]


def run(text: str, rpr: str = "") -> str:
    return f'<w:r>{"<w:rPr>" + rpr + "</w:rPr>" if rpr else ""}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(content: str, ppr: str = "") -> str:
    return f'<w:p>{"<w:pPr>" + ppr + "</w:pPr>" if ppr else ""}{content}</w:p>'


EXACT20 = '<w:spacing w:before="0" w:after="0" w:line="400" w:lineRule="exact"/>'


def lines_para(markers: list[str]) -> str:
    """1行20ptの段落(行は段落の中の改行で分ける)"""
    out = []
    for i, m in enumerate(markers):
        if i:
            out.append("<w:r><w:br/></w:r>")
        out.append(run(m))
    return para("".join(out), EXACT20)


def table_xml(rows: list[dict], widths: list[float]) -> str:
    """rows: {"cells": [セルの中身のXML(段落など)], "header": bool, "cantSplit": bool, "height": (pt, "exact"|"atLeast")|None}"""
    grid = "".join(f'<w:gridCol w:w="{round(x * TW)}"/>' for x in widths)
    trs = []
    for r in rows:
        trpr = ("<w:tblHeader/>" if r.get("header") else "") + ("<w:cantSplit/>" if r.get("cantSplit") else "")
        if r.get("height"):
            h, rule = r["height"]
            trpr += f'<w:trHeight w:val="{round(h * TW)}" w:hRule="{rule}"/>'
        tcs = "".join(f'<w:tc><w:tcPr><w:tcW w:w="{round(widths[i] * TW)}" w:type="dxa"/></w:tcPr>{c}</w:tc>' for i, c in enumerate(r["cells"]))
        trs.append(f"<w:tr>{'<w:trPr>' + trpr + '</w:trPr>' if trpr else ''}{tcs}</w:tr>")
    borders = "".join(f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>' for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="{round(sum(widths) * TW)}" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders><w:tblLayout w:type="fixed"/>'
        f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{''.join(trs)}</w:tbl>"
    )


def sdt(content: str) -> str:
    return f'<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent>{content}</w:sdtContent></w:sdt>'


def marks(d: w.Doc, prefix: str, start: int, end: int, page) -> list[str]:
    out = []
    for i in range(start, end + 1):
        t = f"{prefix}{i:02d}"
        d.mark(t, page(i) if callable(page) else page)
        out.append(t)
    return out


# ───────────── 文書の構造(以前は失われていたもの) ─────────────


def s01():
    d = w.Doc("s01-content-controls", "内容コントロール(w:sdt)の中の段落・表・段落の前で改ページ", "A")
    d.body.append(sdt(para(run(d.mark("S01A", 1) + " 内容コントロールの中の段落"))
                      + para(run(d.mark("S01BIG", 1), '<w:sz w:val="40"/>'))))
    d.body.append(sdt(table_xml([{"cells": [para(run(d.mark("S01T1", 1))), para(run(d.mark("S01T2", 1)))]}], [200, 200])))
    d.body.append(sdt(para(run(d.mark("S01NEXT", 2) + " 内容コントロールの中の、段落の前で改ページ"), "<w:pageBreakBefore/>")))
    d.pages = 2
    d.extra["minHeight"] = {"S01BIG": 17}  # 20ptの文字(文字の書式が対応づけられている)
    return d


def s02():
    d = w.Doc("s02-style-page-break", "段落スタイルの「段落の前で改ページ」(w:pageBreakBefore)", "A")
    d.styles_extra = '<w:style w:type="paragraph" w:styleId="PB"><w:name w:val="Chapter"/><w:basedOn w:val="a"/><w:pPr><w:pageBreakBefore/></w:pPr></w:style>'
    for ch in range(1, 4):
        d.body.append(para(run(d.mark(f"S02C{ch}", ch) + " 章の見出し"), '<w:pStyle w:val="PB"/>'))
        d.body.append(para(run(d.mark(f"S02B{ch}", ch) + " 章の本文")))
    d.pages = 3
    return d


def s03():
    d = w.Doc("s03-cell-image", "表のセルの中の画像(行の中に置く画像)", "A")
    img = d.image_xml((220, 30, 30), 100, 50)
    d.body.append(table_xml([{"cells": [para(run(d.mark("S03CELL", 1))), para(img)]}], [150, 200]))
    d.body.append(para(run(d.mark("S03AFTER", 1))))
    d.pages = 1
    d.extra.update({"colors": {"red": [220, 30, 30]}, "colorPages": {"red": [1]}, "imageSize": {"red": [100, 50]}})
    return d


def s04():
    d = w.Doc("s04-nested-table", "入れ子の表(セルの中の表)の文字", "A")
    inner = table_xml([{"cells": [para(run(d.mark("S04N1", 1))), para(run(d.mark("S04N2", 1)))]}, {"cells": [para(run(d.mark("S04N3", 1))), para(run(d.mark("S04N4", 1)))]}], [90, 90])
    d.body.append(table_xml([{"cells": [para(run(d.mark("S04OUT", 1))), inner + para("")]}], [150, 220]))
    d.pages = 1
    return d


def s10():
    d = w.Doc("s10-hyperlink-caps", "ハイパーリンク・すべて大文字・小さな大文字", "A")
    d.rels.append(("rIdLink1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", "https://example.com/mr-satto-spec"))
    # rels の TargetMode="External" は、generate_word_fixtures の save が付けないので、Target だけで外部のURLと分かるようにする
    d.body.append(para(f'<w:hyperlink r:id="rIdLink1">{run("S10LINK", "<w:rStyle w:val=\"Hyperlink\"/>")}</w:hyperlink>'))
    d.body.append(para(run("capsmark", "<w:caps/>")))
    d.body.append(para(run("smallmark", "<w:smallCaps/>")))
    d.mark("S10LINK", 1)
    d.mark("CAPSMARK", 1)
    d.mark("SMALLMARK", 1)
    d.extra.update({"textsAbsent": ["capsmark", "smallmark"], "linkUris": ["https://example.com/mr-satto-spec"]})
    d.pages = 1
    return d


# ───────────── 表の行のページの分け方(1行20pt) ─────────────


def s05():
    d = w.Doc("s05-row-split", "表の行の途中のページの分割(60行のセル。1ページに34行)", "B")
    ms = marks(d, "S05L", 1, 60, lambda i: 1 if i <= 34 else 2)
    d.body.append(table_xml([{"cells": [lines_para(ms)]}], [400]))
    d.pages = 2
    return d


def s06():
    d = w.Doc("s06-row-cantsplit", "行の途中で改ページしない(w:cantSplit)行と、分けられる行", "B")
    for t in marks(d, "S06P", 1, 20, 1):
        d.body.append(para(run(t), EXACT20))
    a = marks(d, "S06A", 1, 20, 2)  # 残り297.9ptに入らない → 行ごと次のページ
    b = marks(d, "S06B", 1, 20, lambda i: 2 if i <= 14 else 3)  # 2ページ目の残り297.9pt に14行
    d.body.append(table_xml([{"cells": [lines_para(a)], "cantSplit": True}, {"cells": [lines_para(b)]}], [400]))
    d.pages = 3
    return d


def s07():
    d = w.Doc("s07-row-too-tall", "1ページに入らない「行の途中で改ページしない」行(分けて描く)", "B")
    ms = marks(d, "S07L", 1, 50, lambda i: 1 if i <= 34 else 2)
    d.body.append(table_xml([{"cells": [lines_para(ms)], "cantSplit": True}], [400]))
    d.pages = 2
    return d


def s08():
    d = w.Doc("s08-row-split-header", "タイトル行の繰り返しと、行の途中の分割", "B")
    ms = marks(d, "S08L", 1, 60, lambda i: 1 if i <= 33 else 2)  # 1ページ目はタイトル行20pt + 33行
    d.markers["S08H"] = [1, 2]
    d.body.append(table_xml([{"cells": [lines_para(["S08H"])], "header": True}, {"cells": [lines_para(ms)]}], [400]))
    d.pages = 2
    return d


def s12():
    d = w.Doc("s12-exact-row-height", "高さが固定(w:hRule=exact)の行(はみ出す文字の行は描かない)", "A")
    d.body.append(table_xml([{"cells": [lines_para(["S12E1", "S12E2", "S12E3", "S12E4", "S12E5"])], "height": (40, "exact")}], [300]))
    d.body.append(para(run(d.mark("S12AFTER", 1))))
    d.mark("S12E1", 1)
    d.mark("S12E2", 1)
    d.extra["textsAbsent"] = ["S12E3", "S12E4", "S12E5"]
    d.pages = 1
    return d


# ───────────── 日本語の禁則・英単語(全角10.5pt × 42文字/行) ─────────────


def kinsoku_body(d: w.Doc, strict: bool):
    p = lambda text: d.body.append(para(run(text), '<w:jc w:val="left"/>'))  # noqa: E731
    # 句読点のぶら下げ：43文字目の「。」は行末にぶら下げる → 次の目印は2行目の先頭(左の余白の位置)
    p(JA * 42 + "。 " + d.mark("K1MARK", 1))
    # 行頭禁則：43文字目の「」」は行頭に置けない(ぶら下げもしない) → 「あ」」が2行目へ
    p(JA * 42 + "」 " + d.mark("K2MARK", 1))
    # 行末禁則：42文字目の「「」は行末に置けない → 「「」から2行目へ
    p(JA * 41 + "「いいい」 " + d.mark("K3MARK", 1))
    # 小さい仮名：標準のレベルでは行頭に置ける。高レベル(strict)では置けない
    p(JA * 42 + "っ " + d.mark("K4MARK", 1))
    # 分離禁止：「……」は2つの間で改行しない
    p(JA * 41 + "……あ " + d.mark("K5MARK", 1))
    # 英単語：途中で分けない(日本語と英単語の混在も)
    words = " ".join(EN_WORDS[i % len(EN_WORDS)] for i in range(70))
    p(words + " " + d.mark("K6MARK", 1))
    p("日本語の文章と English words が混ざった段落。" * 3 + " ".join(EN_WORDS) + " 終わり " + d.mark("K7MARK", 1))
    d.extra.update({
        "forbiddenLineStarts": "、。，．」』）】〕〉》！？" + ("っゃゅょァィゥェォッャュョー" if strict else ""),
        "forbiddenLineEnds": "「『（【〔〈《",
        "inseparable": ["……"],
        "dictWords": EN_WORDS + ["English", "words"],
    })


def s09():
    d = w.Doc("s09-kinsoku-standard", "日本語の禁則(標準のレベル)・句読点のぶら下げ・分離禁止・英単語", "A")
    kinsoku_body(d, strict=False)
    d.extra["xRange"] = {"K1MARK": [71.5, 73.5], "K2MARK": [93.0, 98.0], "K4MARK": [82.5, 87.5]}
    d.pages = 1
    return d


def s11():
    d = w.Doc("s11-kinsoku-strict", "日本語の禁則(高レベル w:strictFirstAndLastChars：小さい仮名も行頭に置かない)", "A")
    d.settings_extra = "<w:strictFirstAndLastChars/>"
    kinsoku_body(d, strict=True)
    d.extra["xRange"] = {"K1MARK": [71.5, 73.5], "K4MARK": [93.0, 98.0]}
    d.pages = 1
    return d


def main():
    os.makedirs(w.OUT, exist_ok=True)
    cases = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12]
    for f in cases:
        d = f()
        d.save()
    print(f"{len(cases)}件")


if __name__ == "__main__":
    main()
