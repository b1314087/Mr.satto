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

import json
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


# ───────────── フォントの寸法(実際のOfficeのフォントの数値と、GDIの1行の高さの決まり) ─────────────
MEASURED = {f["key"]: f for f in json.load(open(os.path.join(HERE, "..", "..", "..", "scripts", "fonts", "office-measured-metrics.json"), encoding="utf-8"))}


def gdi_line(key: str) -> float:
    """1行の高さ(倍率)：usWinAscent + usWinDescent + max(0, hhea.lineGap − ((win) − (hhea.asc + hhea.desc)))(OpenTypeの仕様 OS/2)"""
    f = MEASURED[key]
    win = f["win"][0] + f["win"][1]
    return (win + max(0, f["hhea"][2] - (win - (f["hhea"][0] + f["hhea"][1])))) / 1000


def latin_width(key: str, text: str, size: float) -> float:
    f = MEASURED[key]
    return sum(f["latin"][ord(c) - 0x20] if 0x20 <= ord(c) <= 0x7E else f["fullWidth"] for c in text) / 1000 * size


def font_lines_case(name: str, key: str, font: str, size: float):
    """1行の高さを固定しない(1行＝フォントの1行の高さ)段落を並べる。1ページの行の数 = floor(697.9 / (倍率 × 大きさ))"""
    d = w.Doc(name, f"フォントの1行の高さ({font} {size}pt。倍率 {gdi_line(key):.4f})", "B")
    lh = gdi_line(key) * size
    per_page = int(697.9 // lh)
    n = per_page + 6
    rpr = f'<w:rFonts w:ascii="{font}" w:eastAsia="{font}" w:hAnsi="{font}"/><w:sz w:val="{round(size * 2)}"/>'
    for i in range(1, n + 1):
        t = f"{name[:3].upper()}L{i:02d}"
        d.mark(t, 1 if i <= per_page else 2)
        d.body.append(para(run(t, rpr), '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/>'))
    d.pages = 2
    return d


def s13():
    return font_lines_case("s13-font-meiryo-lines", "meiryo", "メイリオ", 10.5)


def s14():
    return font_lines_case("s14-font-yugothic-lines", "yuGothic", "游ゴシック", 10.5)


def s15():
    return font_lines_case("s15-font-msmincho-lines", "msMincho", "ＭＳ 明朝", 12)


def s16():
    """英数字の幅：1行目に入る単語の数を、フォントの文字の幅(Officeのフォントの数値)から計算する"""
    d = w.Doc("s16-font-latin-widths", "英数字の幅(Calibri・Century・メイリオ・游明朝で、1行に入る単語の数)", "A")
    xr = {}
    same = []
    for key, font in [("calibri", "Calibri"), ("century", "Century"), ("meiryo", "メイリオ"), ("yuMincho", "游明朝")]:
        size = 10.5
        tag = key[:3].upper()
        start, last_fit, first_next = f"F{tag}S", f"F{tag}A", f"F{tag}BMARKERWIDE"
        n = 0
        # 「先頭の目印＋単語n個＋1行目の最後の目印」が本文の幅(451.3pt)に入る、いちばん大きいn
        while latin_width(key, " ".join([start] + ["layout"] * (n + 1) + [last_fit]), size) <= 451.3:
            n += 1
        assert latin_width(key, " ".join([start] + ["layout"] * n + [last_fit, first_next]), size) > 451.3
        rpr = f'<w:rFonts w:ascii="{font}" w:eastAsia="{font}" w:hAnsi="{font}"/><w:sz w:val="21"/>'
        d.body.append(para(run(" ".join([start] + ["layout"] * n + [last_fit, first_next, "layout"]), rpr), '<w:jc w:val="left"/>'))
        for t in (start, last_fit, first_next):
            d.mark(t, 1)
        xr[first_next] = [71.5, 73.5]
        same.append([start, last_fit])
    d.extra["xRange"] = xr
    d.extra["sameLine"] = same
    d.pages = 1
    return d


# ───────────── ヘッダー・フッターの画像 ─────────────
class HDoc(w.Doc):
    def hf_part(self, kind: str, xml_paras: str, images: list[tuple[str, tuple, float, float, bool, tuple]]) -> str:
        """画像を含むヘッダー/フッターの部品。images: (目印の名前, 色, 幅, 高さ, 浮動配置か, (x, y)ページの左上からの位置)"""
        n = len([k for k in self.parts if k.startswith(f"word/{kind}") and k.endswith(".xml")]) + 1
        part = f"{kind}{n}.xml"
        rels = []
        runs = ""
        for i, (name, rgb, wpt, hpt, floating, pos) in enumerate(images):
            idx = len(self.media) + 1
            self.media.append((f"image{idx}.png", w.png_bytes(40, 20, rgb)))
            rid = f"rIdH{i + 1}"
            rels.append(f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{idx}.png"/>')
            cx, cy = round(wpt * EMU), round(hpt * EMU)
            graphic = (
                f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
                f'<pic:nvPicPr><pic:cNvPr id="{100 + idx}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
                f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
            )
            if floating:
                runs += (
                    f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">'
                    f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{round(pos[0] * EMU)}</wp:posOffset></wp:positionH>'
                    f'<wp:positionV relativeFrom="page"><wp:posOffset>{round(pos[1] * EMU)}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
                    f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{100 + idx}" name="{name}"/>{graphic}</wp:anchor></w:drawing></w:r>'
                )
            else:
                runs += f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{100 + idx}" name="{name}"/>{graphic}</wp:inline></w:drawing></w:r>'
        tag = "w:hdr" if kind == "header" else "w:ftr"
        self.parts[f"word/{part}"] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<{tag} {w.NS}><w:p>{runs}</w:p>{xml_paras}</{tag}>'
        self.parts[f"word/_rels/{part}.rels"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(rels) + "</Relationships>"
        rid = f"rId{kind.capitalize()}{n}"
        self.rels.append((rid, f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}", part))
        return rid


def hf_sect(headers: dict | None = None, footers: dict | None = None, title_pg=False, cols: int = 1, brk: str | None = None) -> str:
    refs = "".join(f'<w:headerReference w:type="{k}" r:id="{v}"/>' for k, v in (headers or {}).items())
    refs += "".join(f'<w:footerReference w:type="{k}" r:id="{v}"/>' for k, v in (footers or {}).items())
    return (
        f'<w:sectPr>{refs}{"<w:type w:val=" + chr(34) + brk + chr(34) + "/>" if brk else ""}'
        f'<w:pgSz w:w="{round(595.3 * TW)}" w:h="{round(841.9 * TW)}"/>'
        f'<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
        f'{"<w:cols w:num=" + chr(34) + str(cols) + chr(34) + " w:space=" + chr(34) + "720" + chr(34) + "/>" if cols > 1 else "<w:cols w:space=" + chr(34) + "720" + chr(34) + "/>"}'
        f'{"<w:titlePg/>" if title_pg else ""}</w:sectPr>'
    )


RED, GREEN, BLUE, ORANGE, PURPLE, TEAL = (220, 30, 30), (30, 160, 60), (40, 70, 220), (240, 140, 20), (140, 40, 170), (20, 150, 150)


def pages_body(d: w.Doc, prefix: str, n: int):
    for i in range(1, n + 1):
        if i > 1:
            d.body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
        d.body.append(para(run(d.mark(f"{prefix}P{i}", i))))


def s17():
    d = HDoc("s17-header-footer-images", "ヘッダーのロゴ画像・フッターの画像(文字と一緒)・すべてのページ", "A")
    h = d.hf_part("header", para(run("S17ヘッダー")), [("logo", RED, 80, 30, False, (0, 0))])
    f = d.hf_part("footer", para(run("S17フッター")), [("foot", GREEN, 60, 20, False, (0, 0))])
    pages_body(d, "S17", 3)
    d.final_sect = hf_sect({"default": h}, {"default": f})
    d.extra.update({"colors": {"red": list(RED), "green": list(GREEN)}, "colorPages": {"red": [1, 2, 3], "green": [1, 2, 3]}, "imageSize": {"red": [80, 30], "green": [60, 20]}, "texts": ["S17ヘッダー", "S17フッター"]})
    d.pages = 3
    return d


def s18():
    d = HDoc("s18-header-first-even", "先頭ページだけ違うヘッダー(w:titlePg)・奇数/偶数ページで違うヘッダー(w:evenAndOddHeaders)", "A")
    d.settings_extra = "<w:evenAndOddHeaders/>"
    first = d.hf_part("header", "", [("first", ORANGE, 70, 25, False, (0, 0))])
    dflt = d.hf_part("header", "", [("odd", RED, 70, 25, False, (0, 0))])
    even = d.hf_part("header", "", [("even", BLUE, 70, 25, False, (0, 0))])
    pages_body(d, "S18", 4)
    d.final_sect = hf_sect({"first": first, "default": dflt, "even": even}, None, title_pg=True)
    d.extra.update({"colors": {"orange": list(ORANGE), "red": list(RED), "blue": list(BLUE)}, "colorPages": {"orange": [1], "red": [3], "blue": [2, 4]}})
    d.pages = 4
    return d


def s19():
    d = HDoc("s19-header-per-section", "セクションごとに違うヘッダーの画像(指定の無いセクションは前のセクションを引き継ぐ)", "A")
    h1 = d.hf_part("header", "", [("sec1", RED, 70, 25, False, (0, 0))])
    h2 = d.hf_part("header", "", [("sec2", PURPLE, 70, 25, False, (0, 0))])
    d.body.append(para(run(d.mark("S19P1", 1)), hf_sect({"default": h1}, None)))
    d.body.append(para(run(d.mark("S19P2", 2)), hf_sect({"default": h2}, None)))
    d.body.append(para(run(d.mark("S19P3", 3))))
    d.final_sect = hf_sect(None, None)  # 指定なし → 2つ目のセクションのヘッダーを引き継ぐ
    d.extra.update({"colors": {"red": list(RED), "purple": list(PURPLE)}, "colorPages": {"red": [1], "purple": [2, 3]}})
    d.pages = 3
    return d


def s20():
    d = HDoc("s20-header-floating-images", "ヘッダーの浮動配置の画像(ページの位置で置く・文字の背面)と、複数の画像", "A")
    h = d.hf_part("header", para(run("S20ヘッダー")), [("float", TEAL, 100, 40, True, (400, 30)), ("inline", RED, 50, 20, False, (0, 0))])
    pages_body(d, "S20", 2)
    d.final_sect = hf_sect({"default": h}, None)
    d.extra.update({"colors": {"teal": list(TEAL), "red": list(RED)}, "colorPages": {"teal": [1, 2], "red": [1, 2]}, "imageSize": {"teal": [100, 40]}, "imagePos": {"teal": [400, 30]}})
    d.pages = 2
    return d


# ───────────── 縦に結合したセル(1行20pt) ─────────────
def vm_cell(xml: str, vmerge: str | None, width: float, span: int = 1) -> str:
    pr = f'<w:tcW w:w="{round(width * TW)}" w:type="dxa"/>' + (f'<w:gridSpan w:val="{span}"/>' if span > 1 else "") + (f'<w:vMerge w:val="restart"/>' if vmerge == "restart" else "<w:vMerge/>" if vmerge == "continue" else "")
    return f"<w:tc><w:tcPr>{pr}</w:tcPr>{xml or '<w:p/>'}</w:tc>"


def vm_table(rows: list[list[str]], widths: list[float], header_rows: int = 0) -> str:
    grid = "".join(f'<w:gridCol w:w="{round(x * TW)}"/>' for x in widths)
    borders = "".join(f'<w:{s_} w:val="single" w:sz="4" w:space="0" w:color="000000"/>' for s_ in ("top", "left", "bottom", "right", "insideH", "insideV"))
    trs = "".join(f"<w:tr>{'<w:trPr><w:tblHeader/></w:trPr>' if i < header_rows else ''}{''.join(r)}</w:tr>" for i, r in enumerate(rows))
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="{round(sum(widths) * TW)}" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders><w:tblLayout w:type="fixed"/>'
        f'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{trs}</w:tbl>"
    )


def s21():
    d = w.Doc("s21-vmerge-long-text", "縦に結合したセルの長い文字が、ページをまたぐ(結合の範囲の最後の行を分ける)", "B")
    merged = marks(d, "S21M", 1, 60, lambda i: 1 if i <= 34 else 2)
    rows = []
    for r in range(6):
        own = marks(d, f"S21R{r + 1}L", 1, 5, 1)
        rows.append([vm_cell(lines_para(merged) if r == 0 else "", "restart" if r == 0 else "continue", 150), vm_cell(lines_para(own), None, 200)])
    d.body.append(vm_table(rows, [150, 200]))
    d.pages = 2
    return d


def s22():
    d = w.Doc("s22-vmerge-header-boundary", "縦に結合したセル(2列・隣り合う結合)・タイトル行の繰り返し・結合の範囲がページの境目にかかる", "B")
    rows = [[vm_cell(lines_para(["S22H"]), None, 100), vm_cell(lines_para(["見出し"]), None, 200), vm_cell(lines_para(["見出し2"]), None, 100)]]
    d.markers["S22H"] = [1, 2]
    for r in range(1, 41):
        page_ = 1 if r <= 33 else 2  # 1ページ目はタイトル行20pt + 33行
        c0 = vm_cell(lines_para([d.mark("S22MG1", 1)]) if r == 1 else "", "restart" if r == 1 else "continue", 100) if r <= 40 else None
        c2 = vm_cell(lines_para([d.mark("S22MG2", 1)]) if r == 30 else "", ("restart" if r == 30 else "continue") if r >= 30 else None, 100)
        rows.append([c0, vm_cell(lines_para([d.mark(f"S22R{r:02d}", page_)]), None, 200), c2])
    d.body.append(vm_table(rows, [100, 200, 100], header_rows=1))
    d.pages = 2
    return d


# ───────────── 段組み ─────────────
def s23():
    d = w.Doc("s23-columns", "2段組み(1段に34行・段区切り・段組みの後の1段のセクション・段の中の画像)", "B")
    col_w = (451.3 - 36) / 2
    for i in range(1, 61):
        t = d.mark(f"S23L{i:02d}", 1)
        d.body.append(para(run(t), EXACT20 + '<w:jc w:val="left"/>'))
    # 段区切り：次の文字は次の段(2段目は60−34=26行使用中 → 段区切りで次のページの1段目)
    d.body.append(para(run("S23BRK") + '<w:r><w:br w:type="column"/></w:r>' + run(d.mark("S23AFTERCOL", 2)), EXACT20 + '<w:jc w:val="left"/>'))
    d.mark("S23BRK", 1)
    # 段の幅より広い画像は、段の幅に縮める
    d.body.append(para(d.image_xml((30, 160, 60), 300, 150)))
    d.body.append(para(run(d.mark("S23END", 2)), EXACT20 + hf_sect(None, None, cols=2)))
    d.body.append(para(run(d.mark("S23ONECOL", 2)), '<w:jc w:val="left"/>'))
    d.final_sect = hf_sect(None, None, cols=1, brk="continuous")
    d.extra.update({
        "xRange": {"S23L01": [71.5, 74], "S23L34": [71.5, 74], "S23L35": [72 + col_w + 36 - 0.5, 72 + col_w + 36 + 2], "S23L60": [72 + col_w + 36 - 0.5, 72 + col_w + 36 + 2], "S23AFTERCOL": [71.5, 74]},
        "colors": {"green": [30, 160, 60]}, "colorPages": {"green": [2]}, "imageSize": {"green": [round(col_w), round(col_w / 2)]},
    })
    d.pages = 2
    return d


# ───────────── 画像の回り込み ─────────────
def anchor_image(d: w.Doc, rgb, w_pt, h_pt, x_pt, wrap_xml: str) -> str:
    idx = len(d.media) + 1
    rid = f"rIdImg{idx}"
    d.media.append((f"image{idx}.png", w.png_bytes(40, 40, rgb)))
    d.rels.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", f"media/image{idx}.png"))
    cx, cy = round(w_pt * EMU), round(h_pt * EMU)
    return (
        f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
        f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{round(x_pt * EMU)}</wp:posOffset></wp:positionH>'
        f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap_xml}<wp:docPr id="{200 + idx}" name="画像{idx}"/>'
        f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{200 + idx}" name="画像{idx}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
        f"</wp:anchor></w:drawing></w:r>"
    )


def s24():
    d = w.Doc("s24-wrap-tight-polygon", "外周の折り返し(輪郭 wp:wrapPolygon の三角形)：下に行くほど文字が左に寄る", "A")
    # 左上の三角形(左上・左下・右上)：上の行は画像の右端の右、下の行ほど左から始まる
    poly = '<wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon>'
    img = anchor_image(d, (200, 40, 40), 200, 200, 0, f'<wp:wrapTight wrapText="bothSides">{poly}</wp:wrapTight>')
    d.body.append(para(img + run(d.mark("S24T01", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    for i in range(2, 11):
        d.body.append(para(run(d.mark(f"S24T{i:02d}", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    d.extra["xOrder"] = {"markers": [f"S24T{i:02d}" for i in range(1, 11)], "decreasing": True, "minDrop": 100}
    d.pages = 1
    return d


def s25():
    d = w.Doc("s25-wrap-sides-multi", "折り返しの側(右だけ)と、左右の2つの画像の間の文字", "A")
    # 1つ目：中央の画像、文字は右側だけ
    img = anchor_image(d, (200, 40, 40), 100, 100, 150, '<wp:wrapSquare wrapText="right"/>')
    d.body.append(para(img + run(d.mark("S25R01", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    for i in range(2, 5):
        d.body.append(para(run(d.mark(f"S25R{i:02d}", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    d.body.append(para("", '<w:spacing w:before="0" w:after="0" w:line="2400" w:lineRule="exact"/>'))
    # 2つ目：左右の画像。文字は2つの画像の間
    l_img = anchor_image(d, (40, 40, 200), 100, 100, 0, '<wp:wrapSquare wrapText="bothSides"/>')
    r_img = anchor_image(d, (40, 160, 40), 100, 100, 351.3, '<wp:wrapSquare wrapText="bothSides"/>')
    d.body.append(para(l_img + r_img + run(d.mark("S25M01", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    for i in range(2, 5):
        d.body.append(para(run(d.mark(f"S25M{i:02d}", 1)), EXACT20 + '<w:jc w:val="left"/>'))
    d.extra["minX"] = {**{f"S25R{i:02d}": 72 + 250 - 0.5 for i in range(1, 5)}, **{f"S25M{i:02d}": 72 + 100 - 0.5 for i in range(1, 5)}}
    d.extra["maxX2"] = {f"S25M{i:02d}": 72 + 351.3 + 0.5 for i in range(1, 5)}
    d.pages = 1
    return d


def main():
    os.makedirs(w.OUT, exist_ok=True)
    cases = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s21, s22, s23, s24, s25]
    for f in cases:
        d = f()
        d.save()
    print(f"{len(cases)}件")


if __name__ == "__main__":
    main()
