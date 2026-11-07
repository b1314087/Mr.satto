#!/usr/bin/env python3
"""
Word→PDF「ページ単位の再現性」の検証用DOCX(WordprocessingMLを直接書く)と、その期待値(JSON)を作る。

Wordのページの分け方(文字の幅・行の折り返し・行の高さ)はフォントと組版の細部で決まるため、この生成スクリプトでは
Wordの組版そのものは計算しない。期待値は、次のどれかで決まるように作る(どれで決まるかを各ケースに書く)。

  A. 明示的な区切り：改ページ(w:br type=page)・「段落の前で改ページ」・セクション区切り。区切りの間の内容は1ページに十分収まる量にする。
  B. 行の高さを固定した文書：行間「固定値」(lineRule=exact)・1行の段落(または段落内の改行)だけで作り、
     フォントや文字の幅に関係なく、1ページに入る行数が計算で決まるようにする(Wordの決まり：次の段落と分離しない・
     段落を分割しない・改ページ時1行残して段落を区切らない、も計算できる)。
  C. Wordが保存した改ページの位置(w:lastRenderedPageBreak)と総ページ数(docProps/app.xml の Pages)を持つ文書：
     Wordは保存のたびに、そのとき組んだページの境目を文書の中に記録する。Microsoft Wordで保存した文書の
     この情報は「Wordで印刷したときのページの境目」そのものなので、Mr.Sattoはそれに合わせる。
     このスクリプトでは、Wordが保存した文書と同じ形の情報を書き込む(位置は、ケースごとに決めた場所)。
  D. 参考：自然に流れる文書(行の高さが文字の大きさで決まる)。Wordの結果は計算できないので、テストでは
     「内容の欠落・重複・紙の外への はみ出しが無いこと」だけを確かめ、ページの境目は LibreOffice と見比べる
     (tests/fixtures/excel-page-fidelity/compare_with_libreoffice.py)。

文字には、場所が分かる目印(例: W06P03、段落の途中は W06P03S2)を入れる。期待値の markers は「目印 → 出るページ」。
フォントは、LibreOfficeとMr.Sattoで同じ字形・幅になるよう Noto Sans CJK JP を指定する(Mr.Sattoは常にNoto Sans JPで描く)。

使い方:  python3 tests/fixtures/word-page-fidelity/generate_word_fixtures.py
出力先:  tests/fixtures/static/word-page-fidelity/*.docx と *.expect.json
データはすべて架空。
"""
from __future__ import annotations

import json
import os
import struct
import sys
import zipfile
import zlib
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "word-page-fidelity")
TW = 20  # 1pt = 20twips
EMU = 12700
FONT = "Noto Sans CJK JP"
A4 = (595.3, 841.9)  # pt(11906×16838 twips)

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
    'mc:Ignorable="wp14"'
)


def png_bytes(w: int, h: int, rgb) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def sect_pr(w=A4[0], h=A4[1], landscape=False, margins=(72, 72, 72, 72), brk: str | None = None, grid_pitch: float | None = None, hdr=None, ftr=None, title_pg=False) -> str:
    """セクションの設定。margins=(上, 右, 下, 左) pt。brk=次のセクションの始まり方(このsectPrは「このセクションの終わり」に置く)"""
    pw, ph = (max(w, h), min(w, h)) if landscape else (w, h)
    t, r, b, l = margins
    refs = ""
    if hdr:
        refs += f'<w:headerReference w:type="default" r:id="{hdr}"/>'
    if ftr:
        refs += f'<w:footerReference w:type="default" r:id="{ftr}"/>'
    typ = f'<w:type w:val="{brk}"/>' if brk else ""
    orient = ' w:orient="landscape"' if landscape else ""
    grid = f'<w:docGrid w:type="lines" w:linePitch="{int(grid_pitch * TW)}"/>' if grid_pitch else '<w:docGrid w:linePitch="360"/>'
    return (
        f"<w:sectPr>{refs}{typ}<w:pgSz w:w=\"{round(pw * TW)}\" w:h=\"{round(ph * TW)}\"{orient}/>"
        f'<w:pgMar w:top="{round(t * TW)}" w:right="{round(r * TW)}" w:bottom="{round(b * TW)}" w:left="{round(l * TW)}" w:header="720" w:footer="720" w:gutter="0"/>'
        f"{'<w:titlePg/>' if title_pg else ''}{grid}</w:sectPr>"
    )


class Doc:
    def __init__(self, name: str, title: str, how: str):
        self.name = name
        self.title = title
        self.how = how  # 期待値の決まり方(A/B/C/D)
        self.body: list[str] = []
        self.media: list[tuple[str, bytes]] = []
        self.rels: list[tuple[str, str, str]] = []  # (id, type, target)
        self.parts: dict[str, str] = {}
        self.final_sect = sect_pr()
        self.markers: dict[str, list[int]] = {}
        self.extra: dict = {}
        self.pages: int | None = None
        self.page_sizes: list[list[float]] | None = None
        self.word_saved = False  # Wordが保存した文書と同じ形(改ページの位置・総ページ数)にする
        self.numbering = False
        self.page = 1  # 目印を置くときの「期待するページ」

    # ── 段落 ──
    def p(self, text: str = "", *, style: str | None = None, before=None, after=None, line=None, exact=None, keep_next=False, keep_lines=False,
          widow=None, pb_before=False, align=None, size=None, runs_xml: str | None = None, sect: str | None = None, num: tuple[int, int] | None = None,
          lrpb=False, ind_left=None, color=None, bold=False):
        ppr = ""
        if style:
            ppr += f'<w:pStyle w:val="{style}"/>'
        if keep_next:
            ppr += "<w:keepNext/>"
        if keep_lines:
            ppr += "<w:keepLines/>"
        if pb_before:
            ppr += "<w:pageBreakBefore/>"
        if widow is not None:
            ppr += f'<w:widowControl w:val="{1 if widow else 0}"/>'
        if num:
            ppr += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
        sp = ""
        if before is not None:
            sp += f' w:before="{round(before * TW)}"'
        if after is not None:
            sp += f' w:after="{round(after * TW)}"'
        if exact is not None:
            sp += f' w:line="{round(exact * TW)}" w:lineRule="exact"'
        elif line is not None:
            sp += f' w:line="{round(line * 240)}" w:lineRule="auto"'
        if sp:
            ppr += f"<w:spacing{sp}/>"
        if ind_left is not None:
            ppr += f'<w:ind w:left="{round(ind_left * TW)}"/>'
        if align:
            ppr += f'<w:jc w:val="{align}"/>'
        if sect:
            ppr += sect
        rpr = ""
        if bold:
            rpr += "<w:b/>"
        if color:
            rpr += f'<w:color w:val="{color}"/>'
        if size:
            rpr += f'<w:sz w:val="{round(size * 2)}"/><w:szCs w:val="{round(size * 2)}"/>'
        rpr_xml = f"<w:rPr>{rpr}</w:rPr>" if rpr else ""
        content = runs_xml if runs_xml is not None else (
            (("<w:r><w:lastRenderedPageBreak/></w:r>" if lrpb else "") + self.text_runs(text, rpr_xml)) if text else ("<w:r><w:lastRenderedPageBreak/></w:r>" if lrpb else "")
        )
        self.body.append(f"<w:p>{'<w:pPr>' + ppr + '</w:pPr>' if ppr else ''}{content}</w:p>")

    @staticmethod
    def text_runs(text: str, rpr_xml: str = "") -> str:
        """\\n は段落の中の改行(w:br)、\\f は段落の中の改ページ(w:br type=page)、\\r はWordが記録した改ページの位置(w:lastRenderedPageBreak)"""
        out = []
        buf = ""
        for ch in text:
            if ch in "\n\f\r":
                if buf:
                    out.append(f'<w:r>{rpr_xml}<w:t xml:space="preserve">{escape(buf)}</w:t></w:r>')
                    buf = ""
                out.append({"\n": f"<w:r>{rpr_xml}<w:br/></w:r>", "\f": f'<w:r>{rpr_xml}<w:br w:type="page"/></w:r>', "\r": "<w:r><w:lastRenderedPageBreak/></w:r>"}[ch])
            else:
                buf += ch
        if buf:
            out.append(f'<w:r>{rpr_xml}<w:t xml:space="preserve">{escape(buf)}</w:t></w:r>')
        return "".join(out)

    def mark(self, token: str, page: int | None = None):
        self.markers.setdefault(token, []).append(page or self.page)
        return token

    def page_break(self):
        self.body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

    # ── 表 ──
    def table(self, rows: list[list[str]], widths: list[float], header_rows=0, row_anchor: set[int] | None = None, exact: float | None = None, cant_split=False):
        grid = "".join(f'<w:gridCol w:w="{round(w * TW)}"/>' for w in widths)
        trs = []
        for ri, row in enumerate(rows):
            trpr = ""
            if ri < header_rows:
                trpr += "<w:tblHeader/>"
            if cant_split:
                trpr += "<w:cantSplit/>"
            tcs = []
            for ci, text in enumerate(row):
                sp = f'<w:spacing w:before="0" w:after="0" w:line="{round(exact * TW)}" w:lineRule="exact"/>' if exact else '<w:spacing w:before="0" w:after="0"/>'
                lr = "<w:r><w:lastRenderedPageBreak/></w:r>" if (row_anchor and ri in row_anchor and ci == 0) else ""
                tcs.append(f'<w:tc><w:tcPr><w:tcW w:w="{round(widths[ci] * TW)}" w:type="dxa"/></w:tcPr><w:p><w:pPr>{sp}</w:pPr>{lr}{self.text_runs(text)}</w:p></w:tc>')
            trs.append(f"<w:tr>{'<w:trPr>' + trpr + '</w:trPr>' if trpr else ''}{''.join(tcs)}</w:tr>")
        borders = "".join(f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>' for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
        self.body.append(
            f'<w:tbl><w:tblPr><w:tblW w:w="{round(sum(widths) * TW)}" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders>'
            f'<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>'
            f"<w:tblGrid>{grid}</w:tblGrid>{''.join(trs)}</w:tbl>"
        )

    # ── 画像・テキストボックス ──
    def image_xml(self, rgb, w_pt: float, h_pt: float, floating=False, wrap="square", text_after: str = "") -> str:
        idx = len(self.media) + 1
        rid = f"rIdImg{idx}"
        self.media.append((f"image{idx}.png", png_bytes(40, 20, rgb)))
        self.rels.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", f"media/image{idx}.png"))
        cx, cy = round(w_pt * EMU), round(h_pt * EMU)
        graphic = (
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
            f'<pic:nvPicPr><pic:cNvPr id="{idx}" name="画像{idx}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            f"</pic:pic></a:graphicData></a:graphic>"
        )
        if not floating:
            return (
                f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:docPr id="{idx}" name="画像{idx}"/>{graphic}</wp:inline></w:drawing></w:r>'
            )
        wrap_xml = '<wp:wrapSquare wrapText="bothSides"/>' if wrap == "square" else "<wp:wrapTopAndBottom/>"
        return (
            f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
            f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
            f'<wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap_xml}<wp:docPr id="{idx}" name="画像{idx}"/>{graphic}</wp:anchor></w:drawing></w:r>'
        )

    def textbox_xml(self, text: str, w_pt=150, h_pt=40) -> str:
        cx, cy = round(w_pt * EMU), round(h_pt * EMU)
        inner = f'<w:txbxContent><w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p></w:txbxContent>'
        return (
            f'<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="2" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
            f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{round(250 * EMU)}</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/>'
            f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="90" name="テキスト ボックス 1"/>'
            f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>'
            f'<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            f'<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="6350"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>'
            f"<wps:txbx>{inner}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>"
            f'<mc:Fallback><w:pict><v:shape id="tb1" style="position:absolute;margin-left:250pt;width:{w_pt}pt;height:{h_pt}pt" type="#_x0000_t202"><v:textbox>{inner}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'
        )

    def header_footer(self, kind: str, xml_paras: str) -> str:
        n = len([k for k in self.parts if k.startswith(f"word/{kind}")]) + 1
        rid = f"rId{kind.capitalize()}{n}"
        tag = "w:hdr" if kind == "header" else "w:ftr"
        self.parts[f"word/{kind}{n}.xml"] = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<{tag} {NS}>{xml_paras}</{tag}>'
        self.rels.append((rid, f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}", f"{kind}{n}.xml"))
        return rid

    # ── 保存 ──
    def save(self):
        os.makedirs(OUT, exist_ok=True)
        doc_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {NS}><w:body>{"".join(self.body)}{self.final_sect}</w:body></w:document>'
        rels = [("rIdStyles", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", "styles.xml"),
                ("rIdSettings", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", "settings.xml")]
        if self.numbering:
            rels.append(("rIdNum", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering", "numbering.xml"))
        rels += self.rels
        rels_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
            f'<Relationship Id="{i}" Type="{t}" Target="{escape(tg)}"{" TargetMode=" + chr(34) + "External" + chr(34) if tg.startswith("http") else ""}/>' for i, t, tg in rels) + "</Relationships>"
        overrides = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
                     '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
                     '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>']
        if self.numbering:
            overrides.append('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>')
        for k in self.parts:
            kind = "header" if "header" in k else "footer"
            overrides.append(f'<Override PartName="/{k}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>')
        ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
              '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
              '<Default Extension="png" ContentType="image/png"/>' + "".join(overrides) + "</Types>")
        app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
               + ("<Application>Microsoft Office Word</Application>" if self.word_saved else "<Application>Mr.Satto test generator</Application>")
               + (f"<Pages>{self.pages}</Pages>" if self.word_saved and self.pages else "") + "</Properties>")
        files = {
            "[Content_Types].xml": ct,
            "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                           '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                           '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
            "docProps/app.xml": app,
            "word/document.xml": doc_xml,
            "word/_rels/document.xml.rels": rels_xml,
            "word/styles.xml": STYLES.replace("</w:styles>", getattr(self, "styles_extra", "") + "</w:styles>"),
            "word/settings.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings {NS}><w:defaultTabStop w:val="840"/>{getattr(self, "settings_extra", "")}</w:settings>',
        }
        if self.numbering:
            files["word/numbering.xml"] = NUMBERING
        files.update(self.parts)
        path = os.path.join(OUT, f"{self.name}.docx")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n, data in files.items():
                zi = zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0))
                zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, data)
            for n, data in self.media:
                zi = zipfile.ZipInfo(f"word/media/{n}", date_time=(2026, 1, 1, 0, 0, 0))
                z.writestr(zi, data)
        # XMLとして正しいか
        from xml.dom import minidom
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if n.endswith(".xml") or n.endswith(".rels"):
                    minidom.parseString(z.read(n))
        expect = {"title": self.title, "how": self.how, "pages": self.pages, "markers": self.markers, **self.extra}
        if self.page_sizes:
            expect["pageSizes"] = self.page_sizes
        with open(os.path.join(OUT, f"{self.name}.expect.json"), "w", encoding="utf-8") as f:
            json.dump(expect, f, ensure_ascii=False, indent=1)


STYLES = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles {NS}>'
    f'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{FONT}" w:eastAsia="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}"/><w:kern w:val="2"/>'
    '<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:qFormat/>'
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="a"/><w:pPr><w:ind w:left="840"/></w:pPr></w:style>'
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    "</w:styles>"
)

NUMBERING = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering {NS}>'
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl>'
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="○"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="840" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>'
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl>'
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="(%2)"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="840" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>'
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>'
)

SENT = "これは検証用の文章です。段落の中の文字が、ページの境目でずれたり欠けたりしないことを確かめます。"


def body_lines(d: Doc, prefix: str, n: int, exact: float = 20.0, page: int | None = None, **kw):
    """1行の段落を n 個(行の高さは固定値)"""
    for i in range(n):
        t = f"{prefix}{i + 1:02d}"
        d.mark(t, page)
        d.p(f"{t} 固定の行の高さの段落", exact=exact, **kw)


# ───────────────────────── A. 明示的な区切り ─────────────────────────


def w01():
    d = Doc("w01-one-page", "1ページの文章", "A")
    for i in range(8):
        d.p(d.mark(f"W01P{i + 1:02d}") + " " + SENT, after=6)
    d.pages = 1
    return d


def w02():
    d = Doc("w02-two-pages-break", "改ページで正確に2ページ", "A")
    for i in range(6):
        d.p(d.mark(f"W02A{i + 1:02d}") + " " + SENT, after=6)
    d.page_break()
    d.page = 2
    for i in range(6):
        d.p(d.mark(f"W02B{i + 1:02d}") + " " + SENT, after=6)
    d.pages = 2
    return d


def w03():
    d = Doc("w03-three-pages", "3ページ以上(改ページ・段落の前で改ページ)", "A")
    for pg in range(1, 5):
        d.page = pg
        for i in range(5):
            t = d.mark(f"W03G{pg}P{i + 1}")
            d.p(t + " " + SENT, pb_before=(pg > 1 and i == 0), after=6)
    d.pages = 4
    return d


def w04():
    d = Doc("w04-break-in-paragraph", "段落の途中の改ページ", "A")
    d.p(d.mark("W04P01") + " " + SENT)
    d.p(d.mark("W04P02") + " 改ページの前の文字です。\f" + d.mark("W04P02B", 2) + " 改ページの後の文字です。")
    d.page = 2
    d.p(d.mark("W04P03") + " " + SENT)
    d.pages = 2
    return d


def w05():
    d = Doc("w05-sections", "セクション区切り(次のページから・現在の位置から・余白の変更)", "A")
    d.p(d.mark("W05S1A") + " セクション1の文章です。" + SENT)
    d.p(d.mark("W05S1B") + " " + SENT, sect=sect_pr(brk=None))
    d.page = 2
    d.p(d.mark("W05S2A") + " セクション2(次のページから・余白を広く)の文章です。")
    d.p(d.mark("W05S2B") + " " + SENT, sect=sect_pr(margins=(144, 144, 144, 144), brk="nextPage"))
    d.p(d.mark("W05S3A") + " セクション3(現在の位置から)の文章です。")
    d.final_sect = sect_pr(brk="continuous")
    d.pages = 2
    # 2ページ目の左の余白は144pt(セクション2の設定)
    d.extra["leftMargin"] = {"W05S2A": 144}
    return d


def w16():
    d = Doc("w16-orientation-mixed", "縦向きと横向きの混在", "A")
    d.p(d.mark("W16P1") + " 1ページ目(縦)。" + SENT, sect=sect_pr(brk=None))
    d.page = 2
    d.p(d.mark("W16P2") + " 2ページ目(横)。" + SENT, sect=sect_pr(landscape=True, brk="nextPage"))
    d.page = 3
    d.p(d.mark("W16P3") + " 3ページ目(縦)。" + SENT)
    d.final_sect = sect_pr(brk="nextPage")
    d.pages = 3
    d.page_sizes = [[595.3, 841.9], [841.9, 595.3], [595.3, 841.9]]
    return d


# ───────────────────────── B. 行の高さを固定した文書 ─────────────────────────
# A4・上下の余白72pt → 本文の高さ 697.9pt。固定値20ptの行は1ページに34行(680pt)入り、35行目(700pt)は次のページ。


def w06():
    d = Doc("w06-exact-two-pages", "行の高さ固定で正確に2ページ(34行+34行)", "B")
    body_lines(d, "W06L", 34, page=1)
    d.page = 2
    body_lines(d, "W06M", 34, page=2)
    d.pages = 2
    return d


def w07():
    d = Doc("w07-keep-next", "次の段落と分離しない(見出しがページの最後の行に来る)", "B")
    body_lines(d, "W07L", 33, page=1)
    # 見出し(次の段落と分離しない)が34行目。次の段落(3行)は入らないので、見出しごと次のページへ
    d.p(d.mark("W07H", 2) + " 見出し", exact=20, keep_next=True, bold=True)
    d.p(d.mark("W07B1", 2) + " 本文1行目\n" + d.mark("W07B2", 2) + " 本文2行目\n" + d.mark("W07B3", 2) + " 本文3行目", exact=20)
    d.pages = 2
    return d


def w08():
    d = Doc("w08-widow-control", "改ページ時1行残して段落を区切らない(3行の段落の2行だけが入る位置)", "B")
    body_lines(d, "W08L", 32, page=1)
    # 33・34行目に2行、3行目だけが次のページになる → 最後の1行だけが次のページに行かないよう、段落ごと次のページへ
    d.p(d.mark("W08B1", 2) + " 段落1行目\n" + d.mark("W08B2", 2) + " 段落2行目\n" + d.mark("W08B3", 2) + " 段落3行目", exact=20, widow=True)
    d.pages = 2
    return d


def w09():
    d = Doc("w09-keep-lines", "段落を分割しない(5行の段落に、ページの残り3行)", "B")
    body_lines(d, "W09L", 31, page=1)
    d.p("\n".join(d.mark(f"W09K{i}", 2) + f" 分割しない段落{i}行目" for i in range(1, 6)), exact=20, keep_lines=True)
    d.pages = 2
    return d


def w10():
    d = Doc("w10-no-widow-split", "1行残しの制御なし(段落がそのまま境目で分かれる)", "B")
    body_lines(d, "W10L", 32, page=1)
    d.p(d.mark("W10B1", 1) + " 段落1行目\n" + d.mark("W10B2", 1) + " 段落2行目\n" + d.mark("W10B3", 2) + " 段落3行目", exact=20, widow=False)
    d.pages = 2
    return d


def w11():
    d = Doc("w11-table-header-repeat", "ページをまたぐ表と見出し行の繰り返し(行の高さ固定)", "B")
    body_lines(d, "W11L", 4, exact=20.25, page=1)
    # 表：見出し1行 + 40行(各20pt)。1ページ目の残りは 697.9-81=616.9pt → 30行(見出し+29行)。罫線の太さ(0.5pt)を行の高さに
    # 足すソフトでも足さないソフトでも同じ行数になる余裕をとった。残り11行と、繰り返す見出しが2ページ目
    rows = [["W11HD 見出し", "列2"]] + [[f"W11R{i:02d}", f"内容{i}"] for i in range(1, 41)]
    d.table(rows, [200, 200], header_rows=1, exact=20)
    for i in range(1, 41):
        d.mark(f"W11R{i:02d}", 1 if i <= 29 else 2)
    d.markers["W11HD"] = [1, 2]
    d.pages = 2
    return d


# ───────────────────────── C. Wordが保存した改ページの位置を持つ文書 ─────────────────────────


def w12():
    d = Doc("w12-word-saved-breaks", "Wordが保存した改ページの位置(計算と合う位置は使い、大きく離れた位置は使わない)", "C")
    d.word_saved = True
    # 1ページ目：固定値20ptの行が32行(640pt)。次の3行の段落の、2行目の前でWordが改ページした記録がある。
    # 計算では2行目もまだ入る(残り57.9pt)が、残りが3行ぶん(60pt)未満なので、記録どおり2行目から2ページ目にする
    body_lines(d, "W12L", 32, page=1)
    d.p(d.mark("W12B1", 1) + " 段落1行目\n\r" + d.mark("W12B2", 2) + " 段落2行目\n" + d.mark("W12B3", 2) + " 段落3行目", exact=20, widow=False)
    d.page = 2
    body_lines(d, "W12M", 3, page=2)
    # 2ページ目の4行目の前にも記録があるが、ページの残りが大きく(30行ぶん以上)、計算と大きく離れているので使わない
    d.p(d.mark("W12FAR", 2) + " 保存後に内容が変わった位置", exact=20, lrpb=True)
    body_lines(d, "W12N", 3, page=2)
    d.pages = 2
    d.extra["warningsContain"] = ["使っていません"]
    return d


def w13():
    d = Doc("w13-word-saved-table", "Wordが保存した改ページの位置(ページの末尾近くの表の行)", "C")
    d.word_saved = True
    body_lines(d, "W13L", 30, page=1)
    # 残り97.9pt：計算では4行入るが、Wordは3行目の前で改ページした(残りが3行ぶん未満なので、記録を使う)
    rows = [[f"W13R{i:02d}", f"内容{i}"] for i in range(1, 7)]
    d.table(rows, [200, 200], row_anchor={2}, exact=20)
    for i in range(1, 7):
        d.mark(f"W13R{i:02d}", 1 if i <= 2 else 2)
    d.page = 2
    d.p(d.mark("W13P4") + " 表の後の段落。")
    d.pages = 2
    return d


def w14():
    d = Doc("w14-word-saved-flow", "Wordが保存した改ページの位置(各ページで計算より1行早い記録)", "C")
    d.word_saved = True
    # 固定値20ptの1行の段落が80個。計算では1ページに34行入るが、Wordは33行目・65行目の前で改ページした記録がある
    # (どちらも、そのページの残りが3行ぶん未満なので、記録を使う)
    page = 1
    for i in range(1, 81):
        brk = i in (33, 65)
        if brk:
            page += 1
        d.page = page
        d.p(d.mark(f"W14P{i:02d}") + " 固定の行の高さの段落", exact=20, lrpb=brk)
    d.pages = 3
    return d


# ───────────────────────── 内容(段落・リスト・表・画像・ヘッダー/フッター) ─────────────────────────


def w15():
    d = Doc("w15-lists", "箇条書き・番号付きリスト(入れ子)", "A")
    d.numbering = True
    for i in range(1, 4):
        d.p(d.mark(f"W15B{i}") + " 箇条書きの項目", num=(1, 0))
        d.p(d.mark(f"W15B{i}x") + " 入れ子の項目", num=(1, 1))
    for i in range(1, 4):
        d.p(d.mark(f"W15N{i}") + " 番号付きの項目", num=(2, 0))
    d.pages = 1
    d.extra["texts"] = ["1.", "2.", "3."]
    return d


def w17():
    d = Doc("w17-image-inline-size", "画像の大きさ(文字と同じ行に置く画像・120×60pt)と、同じ段落の文字", "A")
    d.p(d.mark("W17P1") + " 画像の前の段落。")
    d.p("", runs_xml=d.text_runs(d.mark("W17IMG") + " 画像の左の文字 ") + d.image_xml((112, 48, 160), 120, 60) + d.text_runs(" 画像の右の文字 " + d.mark("W17IMGR")))
    d.p(d.mark("W17P2") + " 画像の後の段落。")
    d.pages = 1
    d.extra["colors"] = {"purple": [112, 48, 160]}
    d.extra["colorPages"] = {"purple": [1]}
    d.extra["imageSize"] = {"purple": [120, 60]}
    # 文字と同じ行に置く画像：画像の左の文字と右の文字は、同じ行にある
    d.extra["sameLine"] = [["W17IMG", "W17IMGR"]]
    return d


def w18():
    d = Doc("w18-image-floating", "画像の文字列の折り返し(四角形・浮動配置・90×90pt)", "A")
    d.p(d.mark("W18P1") + " 浮動配置の画像を持つ段落。", runs_xml=None)
    d.p("", runs_xml=d.image_xml((0, 176, 80), 90, 90, floating=True) + d.text_runs(d.mark("W18P2") + " " + SENT * 3))
    d.p(d.mark("W18P3") + " " + SENT)
    d.pages = 1
    d.extra["colors"] = {"green": [0, 176, 80]}
    d.extra["colorPages"] = {"green": [1]}
    d.extra["imageSize"] = {"green": [90, 90]}
    # 四角形の折り返し：画像(段の左端・幅90pt・右の間隔9pt)の右に、本文の文字が回り込む
    d.extra["minX"] = {"W18P2": 72 + 90 + 9 - 1}
    return d


def w19():
    d = Doc("w19-header-footer-pages", "ヘッダー・フッターとページ番号(PAGE / NUMPAGES)", "A")
    hdr = d.header_footer("header", '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>W19ヘッダーの文字</w:t></w:r></w:p>')
    fld = lambda instr: f'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> {instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    ftr = d.header_footer("footer", f'<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">ページ </w:t></w:r>{fld("PAGE")}<w:r><w:t xml:space="preserve"> / </w:t></w:r>{fld("NUMPAGES")}</w:p>')
    for pg in range(1, 4):
        d.page = pg
        if pg > 1:
            d.page_break()
        d.p(d.mark(f"W19G{pg}") + f" {pg}ページ目の本文。")
    d.final_sect = sect_pr(hdr=hdr, ftr=ftr)
    d.pages = 3
    d.extra["texts"] = ["W19ヘッダーの文字", "ページ1/3", "ページ2/3", "ページ3/3"]
    return d


def w20():
    d = Doc("w20-textbox-shape", "テキストボックス(浮動配置)を含む文章", "A")
    d.p(d.mark("W20P1") + " テキストボックスを持つ段落。", runs_xml=None)
    d.p("", runs_xml=d.text_runs(d.mark("W20P2") + " 本文の続き。") + d.textbox_xml("W20TB テキストボックスの文字"))
    d.p(d.mark("W20P3") + " " + SENT)
    d.mark("W20TB", 1)
    d.pages = 1
    # テキストボックスは、段の左端から250ptの位置(内側の余白7.2pt)に描く(本文の流れには入れない)
    d.extra["minX"] = {"W20TB": 72 + 250}
    d.extra["sameLine"] = []
    return d


def w21():
    d = Doc("w21-table-merged", "表(列幅・セル結合なし・文字の配置)と、表の後の段落", "A")
    d.p(d.mark("W21P1") + " 表の前の段落。")
    d.table([["W21A1 見出し", "W21B1 見出し", "W21C1 見出し"], ["W21A2", "W21B2 長めの内容が入るセル", "W21C2"], ["W21A3", "W21B3", "W21C3"]], [100, 220, 120], header_rows=1)
    for t in ["W21A1", "W21B1", "W21C1", "W21A2", "W21B2", "W21C2", "W21A3", "W21B3", "W21C3"]:
        d.mark(t)
    d.p(d.mark("W21P2") + " 表の後の段落。")
    d.pages = 1
    return d


# ───────────────────────── D. 自然に流れる文書(参考) ─────────────────────────


def w22():
    d = Doc("w22-natural-long", "自然に流れる長い文書(参考：LibreOfficeと比べる)", "D")
    for i in range(1, 41):
        d.p(d.mark(f"W22P{i:02d}") + " " + SENT * 2, after=8)
    d.pages = None
    return d


def w23():
    d = Doc("w23-natural-grid", "行グリッド(文字数と行数を指定)の文書(参考：LibreOfficeと比べる)", "D")
    for i in range(1, 31):
        d.p(d.mark(f"W23P{i:02d}") + " " + SENT * 2)
    d.final_sect = sect_pr(grid_pitch=18)
    d.pages = None
    return d


CASES = [w01, w02, w03, w04, w05, w06, w07, w08, w09, w10, w11, w12, w13, w14, w15, w16, w17, w18, w19, w20, w21, w22, w23]


def main():
    for fn in CASES:
        d = fn()
        d.save()
        print(f"{d.name}.docx  OK")


if __name__ == "__main__":
    sys.exit(main())
