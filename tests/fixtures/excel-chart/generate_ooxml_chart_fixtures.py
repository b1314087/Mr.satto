#!/usr/bin/env python3
"""
Excel→PDFのグラフ検証用：Excel本体が保存するファイルの構造(OOXML)をまねたExcelファイルを、XMLから直接作る。

前回の excel-chart/ のファイルは openpyxl で作って LibreOffice で保存し直したもの。こちらは
LibreOfficeを通さず、Excel 2016以降が書き出すXMLの形(c14:styleの包み、c16:uniqueId、テーマ色の
明暗(lumMod/lumOff)で書かれた文字・線の色、sharedStrings、日本語Excelの既定フォント 游ゴシック 等)に
合わせて部品を組み立てる。

注意：これは「Excel本体が保存したファイル」そのものではない。Excel本体で開いて確かめたものでもない。
OOXMLの仕様(ECMA-376)と、Excelが書き出すXMLの一般的な形に沿って作った検証用のファイルである。

使い方:  python3 tests/fixtures/excel-chart/generate_ooxml_chart_fixtures.py
出力先:  tests/fixtures/static/excel-chart-ooxml/
データはすべて架空。
"""
from __future__ import annotations

import io
import os
import re
import struct
import sys
import zipfile
import zlib
from xml.dom import minidom
from xml.sax.saxutils import escape


def attr(v: str) -> str:
    """XMLの属性の値(\" も &quot; にする)"""
    return escape(v, {'"': "&quot;"})

OUT = os.path.join(os.path.dirname(__file__), "..", "static", "excel-chart-ooxml")
# 分類の軸の項目名の表示(間引き・折り返し・回転)の検証用
OUT_LABELS = os.path.join(os.path.dirname(__file__), "..", "static", "excel-chart-labels")
# 変換の前の「グラフのページ境界チェック」の検証用
OUT_PAGECHECK = os.path.join(os.path.dirname(__file__), "..", "static", "excel-chart-pagecheck")

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
EMU = 12700  # 1pt

# ───────────────────────── セル・数値 ─────────────────────────


def col_name(c: int) -> str:
    s = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def cell_ref(r: int, c: int) -> str:
    return f"{col_name(c)}{r + 1}"


def abs_range(sheet: str, r0: int, c0: int, r1: int, c1: int) -> str:
    q = f"'{sheet}'" if re.search(r"[^A-Za-z0-9_]", sheet) else sheet
    a = f"${col_name(c0)}${r0 + 1}"
    b = f"${col_name(c1)}${r1 + 1}"
    return f"{q}!{a}" if (r0, c0) == (r1, c1) else f"{q}!{a}:{b}"


def date_serial(y: int, m: int, d: int) -> int:
    import datetime

    return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days


def fmt_num(v: float) -> str:
    if isinstance(v, int) or float(v).is_integer():
        return str(int(v))
    return repr(float(v))


class F:
    """数式のセル(Excelと同じく、計算結果<v>も保存する)"""

    def __init__(self, formula: str, value):
        self.formula = formula
        self.value = value


# styles.xml の cellXfs の番号
ST_GENERAL, ST_DATE, ST_YEN, ST_PCT, ST_JDATE, ST_MD = 0, 1, 2, 3, 4, 5
NUMFMT_OF_STYLE = {ST_DATE: "yyyy/m/d", ST_YEN: '"¥"#,##0', ST_PCT: "0%", ST_JDATE: 'yyyy"年"m"月"d"日"', ST_MD: "m/d"}

# ───────────────────────── グラフのXML(Excel 2016以降の形) ─────────────────────────

TX_GRAY = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>'
LINE_GRAY = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill>'
LINE_GRAY25 = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="25000"/><a:lumOff val="75000"/></a:schemeClr></a:solidFill>'


def txpr(sz=900, bold=False, color=TX_GRAY, rot=None) -> str:
    rot_attr = f' rot="{rot}" vert="horz"' if rot is not None else ' rot="-60000000" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"'
    return (
        f'<c:txPr><a:bodyPr{rot_attr}/><a:lstStyle/><a:p><a:pPr>'
        f'<a:defRPr sz="{sz}" b="{1 if bold else 0}" i="0" u="none" strike="noStrike" kern="1200" baseline="0">{color}'
        f'<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>'
        f'</a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr>'
    )


def rich_title(text_or_runs, sz=1400, rot=None) -> str:
    """グラフ・軸のタイトル(文字を直接入力したもの)。runs は [[(文字, rPr属性, 色XML)...], ...](段落ごと)"""
    if isinstance(text_or_runs, str):
        paras = [[(text_or_runs, "", "")]]
    else:
        paras = text_or_runs
    body = f'<a:bodyPr rot="{rot}" vert="horz"/>' if rot is not None else '<a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/>'
    ps = ""
    for runs in paras:
        rs = "".join(f'<a:r><a:rPr lang="ja-JP" altLang="en-US"{attrs}>{color}</a:rPr><a:t>{escape(t)}</a:t></a:r>' for t, attrs, color in runs)
        ps += (
            f'<a:p><a:pPr><a:defRPr sz="{sz}" b="0" i="0" u="none" strike="noStrike" kern="1200" spc="0" baseline="0">{TX_GRAY}'
            f'<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr>{rs}</a:p>'
        )
    return (
        f'<c:title><c:tx><c:rich>{body}<a:lstStyle/>{ps}</c:rich></c:tx><c:overlay val="0"/>'
        f'<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr></c:title>'
    )


def solid(scheme=None, srgb=None, mods: dict | None = None) -> str:
    m = "".join(f'<a:{k} val="{v}"/>' for k, v in (mods or {}).items())
    if scheme:
        return f'<a:solidFill><a:schemeClr val="{scheme}">{m}</a:schemeClr></a:solidFill>'
    return f'<a:solidFill><a:srgbClr val="{srgb}">{m}</a:srgbClr></a:solidFill>'


def sppr_fill(fill: str, line: str = "<a:ln><a:noFill/></a:ln>") -> str:
    return f"<c:spPr>{fill}{line}<a:effectLst/></c:spPr>"


def sppr_line(color_fill: str, w=28575, dash: str | None = None) -> str:
    d = f'<a:prstDash val="{dash}"/>' if dash else ""
    return f'<c:spPr><a:ln w="{w}" cap="rnd">{color_fill}{d}<a:round/></a:ln><a:effectLst/></c:spPr>'


_uid = [0]


def unique_id() -> str:
    _uid[0] += 1
    return (
        '<c:extLst><c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart">'
        f'<c16:uniqueId val="{{{_uid[0]:08X}-6E6B-4C3A-9D2B-5A1F0C3E7B21}}"/></c:ext></c:extLst>'
    )


def str_ref(f: str | None, values: list | None) -> str:
    cache = ""
    if values is not None:
        pts = "".join(f'<c:pt idx="{i}"><c:v>{escape(str(v))}</c:v></c:pt>' for i, v in enumerate(values) if v is not None)
        cache = f'<c:strCache><c:ptCount val="{len(values)}"/>{pts}</c:strCache>'
    return f"<c:strRef><c:f>{escape(f)}</c:f>{cache}</c:strRef>" if f else f"<c:strLit>{cache[12:-13] if cache else ''}</c:strLit>"


def num_ref(f: str, values: list | None, fmt="General") -> str:
    cache = ""
    if values is not None:
        pts = "".join(f'<c:pt idx="{i}"><c:v>{fmt_num(v)}</c:v></c:pt>' for i, v in enumerate(values) if v is not None)
        cache = f"<c:numCache><c:formatCode>{escape(fmt)}</c:formatCode><c:ptCount val=\"{len(values)}\"/>{pts}</c:numCache>"
    return f"<c:numRef><c:f>{escape(f)}</c:f>{cache}</c:numRef>"


def ser(kind: str, i: int, name_f, name, cat_f, cats, val_f, vals, *, sppr="", extra="", cat_num=False, cat_fmt="General", val_fmt="General", marker="", smooth=None, order=None, idx=None) -> str:
    """kind: bar / line / area / pie / scatter。cats・vals=None なら値の控え(キャッシュ)を書かない"""
    tx = f"<c:tx>{str_ref(name_f, [name] if name is not None else None)}</c:tx>" if name_f else (f"<c:tx><c:v>{escape(name)}</c:v></c:tx>" if name else "")
    head = f'<c:idx val="{i if idx is None else idx}"/><c:order val="{i if order is None else order}"/>{tx}{sppr}'
    if kind == "bar":
        head += '<c:invertIfNegative val="0"/>'
    if kind in ("line", "scatter"):
        head += marker
    if kind == "pie":
        pass
    head += extra
    if kind == "scatter":
        xs = f"<c:xVal>{num_ref(cat_f, cats, cat_fmt)}</c:xVal>" if cat_f else ""
        body = f"{xs}<c:yVal>{num_ref(val_f, vals, val_fmt)}</c:yVal>"
    else:
        if cat_f is None:
            cat = ""
        elif cat_num:
            cat = f"<c:cat>{num_ref(cat_f, cats, cat_fmt)}</c:cat>"
        else:
            cat = f"<c:cat>{str_ref(cat_f, cats)}</c:cat>"
        body = f"{cat}<c:val>{num_ref(val_f, vals, val_fmt)}</c:val>"
    tail = ""
    if kind in ("line", "scatter"):
        tail = f'<c:smooth val="{1 if smooth else 0}"/>'
    return f"<c:ser>{head}{body}{tail}{unique_id()}</c:ser>"


def marker_xml(symbol="none", size=5, fill: str | None = None) -> str:
    if symbol == "none":
        return '<c:marker><c:symbol val="none"/></c:marker>'
    sp = f"<c:spPr>{fill}<a:ln w=\"9525\">{fill}</a:ln><a:effectLst/></c:spPr>" if fill else ""
    return f'<c:marker><c:symbol val="{symbol}"/><c:size val="{size}"/>{sp}</c:marker>'


def dlbls(show_val=False, pos=None, num_fmt=None, extra="", show_pct=False, show_cat=False, delete=False) -> str:
    if delete:
        return '<c:dLbls><c:delete val="1"/></c:dLbls>'
    nf = f'<c:numFmt formatCode="{attr(num_fmt)}" sourceLinked="0"/>' if num_fmt else ""
    p = f'<c:dLblPos val="{pos}"/>' if pos else ""
    return (
        f'<c:dLbls>{extra}{nf}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>{txpr(900)}{p}'
        f'<c:showLegendKey val="0"/><c:showVal val="{int(show_val)}"/><c:showCatName val="{int(show_cat)}"/><c:showSerName val="0"/>'
        f'<c:showPercent val="{int(show_pct)}"/><c:showBubbleSize val="0"/></c:dLbls>'
    )


def cat_ax(ax_id, cross, *, pos="b", delete=False, title="", num_fmt="General", linked=True, crosses="autoZero", crosses_at=None, tick_lbl="nextTo", orientation="minMax", date=False, base_unit="days", major_unit=None, major_time_unit=None, extra_scaling="", label_skip=None, label_rot=None) -> str:
    tag = "c:dateAx" if date else "c:catAx"
    cr = f'<c:crossesAt val="{crosses_at}"/>' if crosses_at is not None else f'<c:crosses val="{crosses}"/>'
    tail = (
        f'<c:auto val="1"/><c:lblOffset val="100"/><c:baseTimeUnit val="{base_unit}"/>'
        + (f'<c:majorUnit val="{major_unit}"/><c:majorTimeUnit val="{major_time_unit}"/>' if major_unit else "")
        if date
        else '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>'
        + (f'<c:tickLblSkip val="{label_skip}"/><c:tickMarkSkip val="{label_skip}"/>' if label_skip else "")
        + '<c:noMultiLvlLbl val="0"/>'
    )
    return (
        f'<{tag}><c:axId val="{ax_id}"/><c:scaling><c:orientation val="{orientation}"/>{extra_scaling}</c:scaling><c:delete val="{int(delete)}"/>'
        f'<c:axPos val="{pos}"/>{title}<c:numFmt formatCode="{attr(num_fmt)}" sourceLinked="{int(linked)}"/>'
        f'<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="{tick_lbl}"/>'
        f'<c:spPr><a:noFill/><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">{LINE_GRAY}<a:round/></a:ln><a:effectLst/></c:spPr>'
        f'{txpr(900, rot=label_rot)}<c:crossAx val="{cross}"/>{cr}{tail}</{tag}>'
    )


def val_ax(ax_id, cross, *, pos="l", delete=False, title="", num_fmt="General", linked=True, crosses="autoZero", crosses_at=None, min_=None, max_=None, major=None, gridlines=True, cross_between="between", tick_lbl="nextTo", orientation="minMax", line=False) -> str:
    sc = f'<c:orientation val="{orientation}"/>' + (f'<c:max val="{max_}"/>' if max_ is not None else "") + (f'<c:min val="{min_}"/>' if min_ is not None else "")
    grid = f'<c:majorGridlines><c:spPr><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">{LINE_GRAY}<a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines>' if gridlines else ""
    cr = f'<c:crossesAt val="{crosses_at}"/>' if crosses_at is not None else f'<c:crosses val="{crosses}"/>'
    ln = f'<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">{LINE_GRAY25}<a:round/></a:ln>' if line else "<a:ln><a:noFill/></a:ln>"
    mu = f'<c:majorUnit val="{major}"/>' if major is not None else ""
    return (
        f'<c:valAx><c:axId val="{ax_id}"/><c:scaling>{sc}</c:scaling><c:delete val="{int(delete)}"/><c:axPos val="{pos}"/>{grid}{title}'
        f'<c:numFmt formatCode="{attr(num_fmt)}" sourceLinked="{int(linked)}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>'
        f'<c:tickLblPos val="{tick_lbl}"/><c:spPr><a:noFill/>{ln}<a:effectLst/></c:spPr>{txpr(900)}'
        f'<c:crossAx val="{cross}"/>{cr}<c:crossBetween val="{cross_between}"/>{mu}</c:valAx>'
    )


def ax_title(text, rot=None) -> str:
    return rich_title(text, sz=1000, rot=rot)


def legend(pos="b", extra="", overlay=False) -> str:
    return (
        f'<c:legend><c:legendPos val="{pos}"/>{extra}<c:overlay val="{int(overlay)}"/>'
        f'<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>{txpr(900)}</c:legend>'
    )


def bar_group(series: list[str], ax=(500001, 500002), bar_dir="col", grouping="clustered", gap=219, overlap=None, vary=False, extra="") -> str:
    ov = f'<c:overlap val="{overlap}"/>' if overlap is not None else ('<c:overlap val="-27"/>' if grouping == "clustered" else '<c:overlap val="100"/>')
    return (
        f'<c:barChart><c:barDir val="{bar_dir}"/><c:grouping val="{grouping}"/><c:varyColors val="{int(vary)}"/>{"".join(series)}{extra}'
        f'<c:gapWidth val="{gap}"/>{ov}<c:axId val="{ax[0]}"/><c:axId val="{ax[1]}"/></c:barChart>'
    )


def line_group(series: list[str], ax=(500001, 500002), grouping="standard", marker=True, extra="") -> str:
    return (
        f'<c:lineChart><c:grouping val="{grouping}"/><c:varyColors val="0"/>{"".join(series)}{extra}'
        f'<c:marker val="{int(marker)}"/><c:smooth val="0"/><c:axId val="{ax[0]}"/><c:axId val="{ax[1]}"/></c:lineChart>'
    )


def chart_space(plot: str, *, title: str | None = None, auto_title_deleted=False, leg: str | None = None, plot_vis_only=True, blanks="gap", space_sppr: str | None = None, plot_sppr: str | None = None, ext="") -> str:
    sp = space_sppr or (
        f'<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">{LINE_GRAY}<a:round/></a:ln><a:effectLst/></c:spPr>'
    )
    psp = plot_sppr or '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<c:chartSpace xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:c16r2="http://schemas.microsoft.com/office/drawing/2015/06/chart">'
        '<c:date1904 val="0"/><c:lang val="ja-JP"/><c:roundedCorners val="0"/>'
        f'<mc:AlternateContent xmlns:mc="{NS_MC}"><mc:Choice Requires="c14" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart"><c14:style val="102"/></mc:Choice><mc:Fallback><c:style val="2"/></mc:Fallback></mc:AlternateContent>'
        f'<c:chart>{title or ""}<c:autoTitleDeleted val="{int(auto_title_deleted)}"/><c:plotArea><c:layout/>{plot}{psp}</c:plotArea>{leg or ""}'
        f'<c:plotVisOnly val="{int(plot_vis_only)}"/><c:dispBlanksAs val="{blanks}"/>{ext}</c:chart>{sp}'
        f'<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr>'
        '<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>'
        "</c:chartSpace>"
    )


# ───────────────────────── 描画(drawing)の位置 ─────────────────────────


def two_cell(c0, r0, c1, r1, co0=0, ro0=0, co1=0, ro1=0, edit_as=None):
    return {"type": "two", "from": (c0, co0, r0, ro0), "to": (c1, co1, r1, ro1), "editAs": edit_as}


def one_cell(c0, r0, w_pt, h_pt, co0=0, ro0=0):
    return {"type": "one", "from": (c0, co0, r0, ro0), "ext": (int(w_pt * EMU), int(h_pt * EMU))}


def absolute(x_pt, y_pt, w_pt, h_pt):
    return {"type": "abs", "pos": (int(x_pt * EMU), int(y_pt * EMU)), "ext": (int(w_pt * EMU), int(h_pt * EMU))}


def png_bytes(w: int, h: int, rgb=(255, 128, 0)) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# ───────────────────────── ブック全体 ─────────────────────────

THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office テーマ"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="游ゴシック Light" panose="020B0300000000000000"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック Light"/></a:majorFont><a:minorFont><a:latin typeface="游ゴシック" panose="020B0400000000000000"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="游ゴシック"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"""

STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<styleSheet xmlns="{NS_MAIN}">'
    '<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0"/><numFmt numFmtId="165" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="166" formatCode="m/d"/><numFmt numFmtId="167" formatCode="yyyy/m/d"/></numFmts>'
    '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="游ゴシック"/><family val="2"/><charset val="128"/><scheme val="minor"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs>'
    '<cellXfs count="6">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>'
    '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    "</cellXfs>"
    '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    "</styleSheet>"
)


class Sheet:
    def __init__(self, name: str):
        self.name = name
        self.cells: dict[tuple[int, int], object] = {}
        self.styles: dict[tuple[int, int], int] = {}
        self.col_widths: dict[int, float] = {}
        self.row_heights: dict[int, float] = {}
        self.hidden_rows: set[int] = set()
        self.drawings: list[dict] = []  # {"anchor":..., "chart": xml} / {"anchor":..., "png": bytes} / {"anchor":..., "chartex": xml}
        self.landscape = False
        self.row_breaks: list[int] = []
        self.state = "visible"
        self.print_area: str | None = None
        self.scale: int | None = None  # 拡大縮小(%)
        self.col_breaks: list[int] = []

    def put(self, r: int, c: int, v, style: int = ST_GENERAL):
        self.cells[(r, c)] = v
        if style:
            self.styles[(r, c)] = style

    def table(self, r0: int, c0: int, rows: list[list], styles: list[int] | None = None):
        for i, row in enumerate(rows):
            for j, v in enumerate(row):
                if v is None:
                    continue
                st = styles[j] if (styles and i > 0) else ST_GENERAL
                self.put(r0 + i, c0 + j, v, st)

    def chart(self, anchor, xml: str):
        self.drawings.append({"anchor": anchor, "chart": xml})

    def picture(self, anchor, png: bytes):
        self.drawings.append({"anchor": anchor, "png": png})


class Book:
    def __init__(self):
        self.sheets: list[Sheet] = []
        self.defined_names: list[tuple[str, str, int | None]] = []  # (名前, 参照, シート番号(シートのみの名前))
        self.external_links: list[str] = []  # 外部ブックのファイル名

    def sheet(self, name: str) -> Sheet:
        s = Sheet(name)
        self.sheets.append(s)
        return s

    # ── 保存 ──
    def save(self, path: str):
        files: dict[str, bytes | str] = {}
        overrides: list[tuple[str, str]] = []
        sst: list[str] = []
        sst_index: dict[str, int] = {}

        def s_idx(t: str) -> int:
            if t not in sst_index:
                sst_index[t] = len(sst)
                sst.append(t)
            return sst_index[t]

        chart_no = 0
        drawing_no = 0
        image_no = 0
        chartex_no = 0
        wb_rels = []
        for si, sh in enumerate(self.sheets, start=1):
            rows_xml = []
            for r in sorted({r for r, _ in sh.cells} | set(sh.row_heights) | sh.hidden_rows):
                attrs = f' r="{r + 1}"'
                if r in sh.row_heights:
                    attrs += f' ht="{sh.row_heights[r]}" customHeight="1"'
                if r in sh.hidden_rows:
                    attrs += ' hidden="1"'
                cs = []
                for c in sorted(c for rr, c in sh.cells if rr == r):
                    v = sh.cells[(r, c)]
                    st = sh.styles.get((r, c), 0)
                    sa = f' s="{st}"' if st else ""
                    ref = cell_ref(r, c)
                    if isinstance(v, F):
                        if isinstance(v.value, str):
                            cs.append(f'<c r="{ref}"{sa} t="str"><f>{escape(v.formula)}</f><v>{escape(v.value)}</v></c>')
                        else:
                            cs.append(f'<c r="{ref}"{sa}><f>{escape(v.formula)}</f><v>{fmt_num(v.value)}</v></c>')
                    elif isinstance(v, str):
                        cs.append(f'<c r="{ref}"{sa} t="s"><v>{s_idx(v)}</v></c>')
                    else:
                        cs.append(f'<c r="{ref}"{sa}><v>{fmt_num(v)}</v></c>')
                rows_xml.append(f"<row{attrs}>{''.join(cs)}</row>")
            cols = ""
            if sh.col_widths:
                cols = "<cols>" + "".join(f'<col min="{c + 1}" max="{c + 1}" width="{w}" customWidth="1"/>' for c, w in sorted(sh.col_widths.items())) + "</cols>"
            maxr = max([r for r, _ in sh.cells] or [0])
            maxc = max([c for _, c in sh.cells] or [0])
            sheet_rels = []
            drawing_xml = ""
            if sh.drawings:
                drawing_no += 1
                dpath = f"xl/drawings/drawing{drawing_no}.xml"
                sheet_rels.append(("rId1", f"{REL}/drawing", f"../drawings/drawing{drawing_no}.xml"))
                drawing_xml = '<drawing r:id="rId1"/>'
                overrides.append((f"/{dpath}", "application/vnd.openxmlformats-officedocument.drawing+xml"))
                anchors = []
                drels = []
                for k, d in enumerate(sh.drawings, start=1):
                    rid = f"rId{k}"
                    a = d["anchor"]
                    if "chart" in d:
                        chart_no += 1
                        files[f"xl/charts/chart{chart_no}.xml"] = d["chart"]
                        overrides.append((f"/xl/charts/chart{chart_no}.xml", "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"))
                        drels.append((rid, f"{REL}/chart", f"../charts/chart{chart_no}.xml"))
                        content = (
                            f'<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{k + 1}" name="グラフ {k}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
                            '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
                            f'<c:chart xmlns:c="{NS_C}" r:id="{rid}"/></a:graphicData></a:graphic></xdr:graphicFrame>'
                        )
                    elif "chartex" in d:
                        chartex_no += 1
                        files[f"xl/charts/chartEx{chartex_no}.xml"] = d["chartex"]
                        overrides.append((f"/xl/charts/chartEx{chartex_no}.xml", "application/vnd.ms-office.chartex+xml"))
                        drels.append((rid, "http://schemas.microsoft.com/office/2014/relationships/chartEx", f"../charts/chartEx{chartex_no}.xml"))
                        content = (
                            f'<mc:AlternateContent xmlns:mc="{NS_MC}"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1">'
                            f'<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{k + 1}" name="グラフ {k}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>'
                            '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex">'
                            f'<cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="{rid}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>'
                            f'<mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="{k + 100}" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr>'
                            '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr>'
                            '<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="ja-JP" altLang="en-US" sz="1100"/><a:t>このグラフは、お使いのバージョンの Excel では使用できません。</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent>'
                        )
                    else:
                        image_no += 1
                        files[f"xl/media/image{image_no}.png"] = d["png"]
                        drels.append((rid, f"{REL}/image", f"../media/image{image_no}.png"))
                        content = (
                            f'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{k + 1}" name="図 {k}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
                            f'<xdr:blipFill><a:blip xmlns:r="{NS_R}" r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
                            '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
                        )
                    if a["type"] == "two":
                        fc, fco, fr, fro = a["from"]
                        tc, tco, tr, tro = a["to"]
                        ea = f' editAs="{a["editAs"]}"' if a["editAs"] else ""
                        anchors.append(
                            f"<xdr:twoCellAnchor{ea}><xdr:from><xdr:col>{fc}</xdr:col><xdr:colOff>{fco}</xdr:colOff><xdr:row>{fr}</xdr:row><xdr:rowOff>{fro}</xdr:rowOff></xdr:from>"
                            f"<xdr:to><xdr:col>{tc}</xdr:col><xdr:colOff>{tco}</xdr:colOff><xdr:row>{tr}</xdr:row><xdr:rowOff>{tro}</xdr:rowOff></xdr:to>{content}<xdr:clientData/></xdr:twoCellAnchor>"
                        )
                    elif a["type"] == "one":
                        fc, fco, fr, fro = a["from"]
                        anchors.append(
                            f"<xdr:oneCellAnchor><xdr:from><xdr:col>{fc}</xdr:col><xdr:colOff>{fco}</xdr:colOff><xdr:row>{fr}</xdr:row><xdr:rowOff>{fro}</xdr:rowOff></xdr:from>"
                            f'<xdr:ext cx="{a["ext"][0]}" cy="{a["ext"][1]}"/>{content}<xdr:clientData/></xdr:oneCellAnchor>'
                        )
                    else:
                        anchors.append(
                            f'<xdr:absoluteAnchor><xdr:pos x="{a["pos"][0]}" y="{a["pos"][1]}"/><xdr:ext cx="{a["ext"][0]}" cy="{a["ext"][1]}"/>{content}<xdr:clientData/></xdr:absoluteAnchor>'
                        )
                files[dpath] = (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                    f'<xdr:wsDr xmlns:xdr="{NS_XDR}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">{"".join(anchors)}</xdr:wsDr>'
                )
                files[f"xl/drawings/_rels/drawing{drawing_no}.xml.rels"] = rels_xml(drels)
            scale_attr = f' scale="{sh.scale}"' if sh.scale else ""
            setup = f'<pageSetup paperSize="9"{scale_attr} orientation="{"landscape" if sh.landscape else "portrait"}"/>'
            breaks = ""
            if sh.row_breaks:
                breaks = f'<rowBreaks count="{len(sh.row_breaks)}" manualBreakCount="{len(sh.row_breaks)}">' + "".join(f'<brk id="{b}" max="16383" man="1"/>' for b in sh.row_breaks) + "</rowBreaks>"
            if sh.col_breaks:
                breaks += f'<colBreaks count="{len(sh.col_breaks)}" manualBreakCount="{len(sh.col_breaks)}">' + "".join(f'<brk id="{b}" max="1048575" man="1"/>' for b in sh.col_breaks) + "</colBreaks>"
            sel = ' tabSelected="1"' if si == 1 else ""
            files[f"xl/worksheets/sheet{si}.xml"] = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_R}"><dimension ref="A1:{cell_ref(maxr, maxc)}"/>'
                f'<sheetViews><sheetView{sel} workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18.75"/>{cols}'
                f'<sheetData>{"".join(rows_xml)}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>{setup}{breaks}{drawing_xml}</worksheet>'
            )
            overrides.append((f"/xl/worksheets/sheet{si}.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"))
            if sheet_rels:
                files[f"xl/worksheets/_rels/sheet{si}.xml.rels"] = rels_xml(sheet_rels)
            wb_rels.append((f"rId{si}", f"{REL}/worksheet", f"worksheets/sheet{si}.xml"))
        n = len(self.sheets)
        wb_rels += [(f"rId{n + 1}", f"{REL}/theme", "theme/theme1.xml"), (f"rId{n + 2}", f"{REL}/styles", "styles.xml"), (f"rId{n + 3}", f"{REL}/sharedStrings", "sharedStrings.xml")]
        ext_refs = ""
        for k, fname in enumerate(self.external_links, start=1):
            rid = f"rId{n + 3 + k}"
            wb_rels.append((rid, f"{REL}/externalLink", f"externalLinks/externalLink{k}.xml"))
            ext_refs += f'<externalReference r:id="{rid}"/>'
            files[f"xl/externalLinks/externalLink{k}.xml"] = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<externalLink xmlns="{NS_MAIN}" xmlns:r="{NS_R}"><externalBook r:id="rId1"><sheetNames><sheetName val="Sheet1"/></sheetNames>'
                '<sheetDataSet><sheetData sheetId="0"><row r="2"><cell r="B2"><v>120</v></cell></row><row r="3"><cell r="B3"><v>180</v></cell></row>'
                '<row r="4"><cell r="B4"><v>150</v></cell></row><row r="5"><cell r="B5"><v>210</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>'
            )
            files[f"xl/externalLinks/_rels/externalLink{k}.xml.rels"] = rels_xml([("rId1", f"{REL}/externalLinkPath", fname, "External")])
            overrides.append((f"/xl/externalLinks/externalLink{k}.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"))
        sheets_xml = "".join(
            f'<sheet name="{escape(sh.name)}" sheetId="{i}"{" state=" + chr(34) + sh.state + chr(34) if sh.state != "visible" else ""} r:id="rId{i}"/>' for i, sh in enumerate(self.sheets, start=1)
        )
        names = list(self.defined_names)
        for i, sh in enumerate(self.sheets):
            if sh.print_area:
                names.append(("_xlnm.Print_Area", sh.print_area, i))
        dn = ""
        if names:
            dn = "<definedNames>" + "".join(
                f'<definedName name="{escape(nm)}"{f" localSheetId={chr(34)}{lid}{chr(34)}" if lid is not None else ""}>{escape(ref)}</definedName>' for nm, ref, lid in names
            ) + "</definedNames>"
        files["xl/workbook.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_R}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/>'
            f'<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews><sheets>{sheets_xml}</sheets>'
            f'{"<externalReferences>" + ext_refs + "</externalReferences>" if ext_refs else ""}{dn}<calcPr calcId="191029"/></workbook>'
        )
        files["xl/_rels/workbook.xml.rels"] = rels_xml(wb_rels)
        files["xl/theme/theme1.xml"] = THEME
        files["xl/styles.xml"] = STYLES
        files["xl/sharedStrings.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<sst xmlns="{NS_MAIN}" count="{len(sst)}" uniqueCount="{len(sst)}">' + "".join(f"<si><t>{escape(t)}</t></si>" for t in sst) + "</sst>"
        )
        files["docProps/app.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop></Properties>'
        )
        files["docProps/core.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            '<dc:creator>テスト</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>'
        )
        files["_rels/.rels"] = rels_xml(
            [
                ("rId1", f"{REL}/officeDocument", "xl/workbook.xml"),
                ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"),
                ("rId3", f"{REL}/extended-properties", "docProps/app.xml"),
            ]
        )
        overrides += [
            ("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
            ("/xl/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"),
            ("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"),
            ("/xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"),
            ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
            ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
        ]
        files["[Content_Types].xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>' + "".join(f'<Override PartName="{p}" ContentType="{t}"/>' for p, t in overrides) + "</Types>"
        )
        order = ["[Content_Types].xml", "_rels/.rels"] + sorted(k for k in files if k not in ("[Content_Types].xml", "_rels/.rels"))
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for name in order:
                data = files[name]
                zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, data.encode("utf-8") if isinstance(data, str) else data)


def rels_xml(rels) -> str:
    items = []
    for r in rels:
        rid, typ, target = r[0], r[1], r[2]
        mode = f' TargetMode="{r[3]}"' if len(r) > 3 else ""
        items.append(f'<Relationship Id="{rid}" Type="{typ}" Target="{escape(target)}"{mode}/>')
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(items) + "</Relationships>"


# ───────────────────────── 構造の検査(参照の不整合がないこと) ─────────────────────────


def validate(path: str) -> list[str]:
    """ZIPの中の全XMLが読めること、すべての関係(rels)の参照先が存在すること、
    すべての部品に種類(Content Types)があること、r:id がrelsにあること、を確かめる"""
    problems: list[str] = []
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    docs = {}
    for n in names:
        if n.endswith(".xml") or n.endswith(".rels"):
            try:
                docs[n] = minidom.parseString(z.read(n))
            except Exception as e:  # noqa: BLE001
                problems.append(f"{n}: XMLとして読めない ({e})")
    ct = docs.get("[Content_Types].xml")
    defaults = {e.getAttribute("Extension") for e in ct.getElementsByTagName("Default")} if ct else set()
    overrides = {e.getAttribute("PartName").lstrip("/") for e in ct.getElementsByTagName("Override")} if ct else set()
    for n in names:
        if n == "[Content_Types].xml" or n.endswith("/"):
            continue
        if n not in overrides and n.rsplit(".", 1)[-1] not in defaults:
            problems.append(f"{n}: Content Typesにない")
    for o in overrides:
        if o not in names:
            problems.append(f"Content TypesのOverride {o} の部品が無い")
    for n, d in docs.items():
        if not n.endswith(".rels"):
            continue
        owner_dir = n.replace("_rels/", "").rsplit("/", 1)[0] if "/" in n.replace("_rels/", "") else ""
        owner = n.replace("_rels/", "")[: -len(".rels")]
        ids = set()
        for rel in d.getElementsByTagName("Relationship"):
            ids.add(rel.getAttribute("Id"))
            if rel.getAttribute("TargetMode") == "External":
                continue
            t = rel.getAttribute("Target")
            parts = (owner_dir.split("/") if owner_dir and n != "_rels/.rels" else []) + t.split("/")
            out = []
            for p in parts:
                if p == "..":
                    out.pop()
                elif p and p != ".":
                    out.append(p)
            target = "/".join(out)
            if target not in names:
                problems.append(f"{n}: 参照先 {target} が無い")
        # 持ち主のXMLの r:id / r:embed がrelsにあるか
        od = docs.get(owner)
        if od:
            for m in re.finditer(r'r:(?:id|embed)="([^"]+)"', z.read(owner).decode("utf-8")):
                if m.group(1) not in ids:
                    problems.append(f"{owner}: r:id {m.group(1)} がrelsに無い")
    return problems


# ───────────────────────── 検証ケース ─────────────────────────

MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月"]


def base_sheet(b: Book, name="Sheet1", series=(("売上", [120, 180, 150, 210, 260, 230]), ("費用", [90, 110, 130, 120, 150, 170])), cats=MONTHS) -> Sheet:
    s = b.sheet(name)
    s.put(0, 0, "月")
    for j, (nm, vals) in enumerate(series):
        s.put(0, j + 1, nm)
        for i, v in enumerate(vals):
            if v is not None:
                s.put(i + 1, j + 1, v)
    for i, c in enumerate(cats):
        s.put(i + 1, 0, c)
    return s


def std_bar_series(sheet: str, series, cats, cache=True, colors=("accent1", "accent2", "accent3", "accent4", "accent5", "accent6")):
    out = []
    n = len(cats)
    for j, (nm, vals) in enumerate(series):
        out.append(
            ser(
                "bar", j, abs_range(sheet, 0, j + 1, 0, j + 1), nm if cache else None,
                abs_range(sheet, 1, 0, n, 0), list(cats) if cache else None,
                abs_range(sheet, 1, j + 1, n, j + 1), list(vals) if cache else None,
                sppr=sppr_fill(solid(colors[j % 6])),
            )
        )
    return out


def case_x01(b: Book):
    """Excel 2016以降の標準の縦棒(値の控えあり)。3つ目の系列は「グラフ フィルター」で非表示(c15:filteredBarSeries)"""
    series = (("売上", [120, 180, 150, 210, 260, 230]), ("費用", [90, 110, 130, 120, 150, 170]))
    s = base_sheet(b, series=series + (("予備", [50, 50, 50, 50, 50, 50]),))
    sers = std_bar_series("Sheet1", series, MONTHS)
    filtered = (
        '<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">'
        '<c15:filteredBarSeries><c15:ser>'
        + ser("bar", 2, abs_range("Sheet1", 0, 3, 0, 3), "予備", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 3, 6, 3), [50] * 6, sppr=sppr_fill(solid("accent3")))[7:-8]
        + "</c15:ser></c15:filteredBarSeries></c:ext></c:extLst>"
    )
    plot = bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001)
    xml = chart_space(plot, title=rich_title("月別の売上と費用"), leg=legend("b"))
    # グラフ フィルターで隠した系列は、barChartの直後ではなく、barChartの中の末尾(axIdの後ろ)の extLst に入る
    xml = xml.replace('<c:axId val="500002"/></c:barChart>', f'<c:axId val="500002"/>{filtered}</c:barChart>', 1)
    s.chart(two_cell(4, 1, 11, 16), xml)


def case_x02(b: Book):
    """値の控えなし・セルは数式(計算結果<v>あり)。参照しているセルから値を読む"""
    s = b.sheet("Sheet1")
    s.table(0, 0, [["月", "単価", "数量", "売上"]])
    for i, (m, p, q) in enumerate(zip(MONTHS[:4], [100, 120, 110, 130], [3, 4, 6, 5]), start=1):
        s.put(i, 0, m)
        s.put(i, 1, p)
        s.put(i, 2, q)
        s.put(i, 3, F(f"B{i + 1}*C{i + 1}", p * q))
    sers = [
        ser("bar", 0, abs_range("Sheet1", 0, 3, 0, 3), None, abs_range("Sheet1", 1, 0, 4, 0), None, abs_range("Sheet1", 1, 3, 4, 3), None, sppr=sppr_fill(solid("accent1"))),
        ser("line", 1, abs_range("Sheet1", 0, 1, 0, 1), None, abs_range("Sheet1", 1, 0, 4, 0), None, abs_range("Sheet1", 1, 1, 4, 1), None, sppr=sppr_line(solid("accent2")), marker=marker_xml("none")),
    ]
    plot = bar_group(sers[:1]) + line_group(sers[1:], marker=False) + cat_ax(500001, 500002) + val_ax(500002, 500001)
    s.chart(two_cell(5, 1, 12, 16), chart_space(plot, title=rich_title("数式のセルから読むグラフ"), leg=legend("b")))


def case_x03(b: Book):
    """空白のセル：空白を「空間(gap)」「ゼロ(zero)」「線で結ぶ(span)」の3つ"""
    vals = [100, 140, None, 180, None, 160]
    s = base_sheet(b, series=(("来店", vals),))
    for k, mode in enumerate(["gap", "zero", "span"]):
        sers = [ser("line", 0, abs_range("Sheet1", 0, 1, 0, 1), "来店", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 1, 6, 1), vals, sppr=sppr_line(solid("accent1")), marker=marker_xml("circle", 5, solid("accent1")))]
        plot = line_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=200, major=50)
        s.chart(two_cell(3, 1 + k * 14, 10, 13 + k * 14), chart_space(plot, title=rich_title(f"空白={mode}"), auto_title_deleted=False, leg=None, blanks=mode))


def case_x04(b: Book):
    """非表示の行：4月(5行目)を非表示。①値の控えあり(Excelは非表示の点を控えに入れない) ②控えなし ③非表示も表示(plotVisOnly=0)"""
    vals = [120, 180, 150, 999, 260, 230]
    s = base_sheet(b, series=(("売上", vals),))
    s.hidden_rows.add(4)
    vis_cats = [c for i, c in enumerate(MONTHS) if i != 3]
    vis_vals = [v for i, v in enumerate(vals) if i != 3]
    specs = [("控えあり", vis_cats, vis_vals, True), ("控えなし", None, None, True), ("非表示も表示", MONTHS, vals, False)]
    for k, (title, cats, vv, vis_only) in enumerate(specs):
        sers = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "売上" if cats else None, abs_range("Sheet1", 1, 0, 6, 0), cats, abs_range("Sheet1", 1, 1, 6, 1), vv, sppr=sppr_fill(solid("accent1")))]
        plot = bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=1000, major=200)
        s.chart(two_cell(3, 1 + k * 14, 10, 13 + k * 14), chart_space(plot, title=rich_title(title), plot_vis_only=vis_only))


def case_x05(b: Book):
    """リッチテキストのタイトル(2段落・色と大きさが違う文字)、テーマ色の明暗、透明度、グラフと描画領域の背景色・枠線"""
    series = (("東日本", [120, 180, 150, 210]), ("西日本", [100, 150, 170, 190]))
    s = base_sheet(b, series=series, cats=MONTHS[:4])
    sers = [
        ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "東日本", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, 1, 4, 1), [120, 180, 150, 210], sppr=sppr_fill(solid("accent1", mods={"lumMod": 50000}))),
        ser("bar", 1, abs_range("Sheet1", 0, 2, 0, 2), "西日本", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, 2, 4, 2), [100, 150, 170, 190], sppr=sppr_fill(solid("accent2", mods={"lumMod": 60000, "lumOff": 40000, "alpha": 50000}))),
    ]
    title = rich_title(
        [
            [("地域別", ' sz="1800" b="1"', solid(srgb="C00000")), ("の売上", ' sz="1800" b="1"', "")],
            [("（単位：千円）", ' sz="1000"', solid("tx1", mods={"lumMod": 50000, "lumOff": 50000}))],
        ]
    )
    plot = bar_group(sers, overlap=60) + cat_ax(500001, 500002) + val_ax(500002, 500001)
    space = '<c:spPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:ln w="28575"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln><a:effectLst/></c:spPr>'
    plot_sp = '<c:spPr><a:solidFill><a:schemeClr val="bg1"><a:lumMod val="95000"/></a:schemeClr></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>'
    s.chart(two_cell(4, 1, 11, 18), chart_space(plot, title=title, leg=legend("r"), space_sppr=space, plot_sppr=plot_sp))


def case_x06(b: Book):
    """データ点ごとの色(dPt)と、データラベルの個別設定(1本だけ表示・1本だけ文字を書き換え)"""
    vals = [120, 180, 150, 260]
    s = base_sheet(b, series=(("売上", vals),), cats=MONTHS[:4])
    dpt = '<c:dPt><c:idx val="3"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/>' + sppr_fill(solid(srgb="C00000")) + "</c:dPt>"
    dl_one = (
        '<c:dLbl><c:idx val="1"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>' + txpr(900) + '<c:dLblPos val="outEnd"/>'
        '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>'
        '<c:dLbl><c:idx val="3"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ja-JP" altLang="en-US" b="1"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>最高！</a:t></a:r></a:p></c:rich></c:tx>'
        '<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>'
    )
    labels = dlbls(show_val=False, extra=dl_one)
    sers = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "売上", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, 1, 4, 1), vals, sppr=sppr_fill(solid("accent1")), extra=dpt + labels)]
    plot = bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=300, major=50)
    s.chart(two_cell(3, 1, 10, 16), chart_space(plot, title=rich_title("個別の色とラベル"), auto_title_deleted=False))
    # 2つ目：数値の書式つきデータラベル(全部の点)
    sers2 = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "売上", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, 1, 4, 1), vals, sppr=sppr_fill(solid("accent6")), extra=dlbls(show_val=True, pos="inEnd", num_fmt='#,##0"円"'))]
    plot2 = bar_group(sers2) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=300, major=50)
    s.chart(two_cell(3, 17, 10, 32), chart_space(plot2, title=rich_title("書式つきラベル")))


def case_x07(b: Book):
    """軸：最小値・最大値・間隔の指定、横軸を上(crosses=max)、交差位置の指定(crossesAt)、数値軸の書式"""
    vals = [120, 180, 150, 210]
    s = base_sheet(b, series=(("売上", vals),), cats=MONTHS[:4])
    sers = lambda: [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "売上", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, 1, 4, 1), vals, sppr=sppr_fill(solid("accent1")))]
    charts = [
        ("最小100・最大250・間隔25", cat_ax(500001, 500002) + val_ax(500002, 500001, min_=100, max_=250, major=25)),
        # 横軸を上に：分類軸(catAx)が、縦軸の最大値の所で交わる
        ("横軸を上に", cat_ax(500001, 500002, crosses="max") + val_ax(500002, 500001, min_=0, max_=250, major=50)),
        # 交差位置：分類軸が、縦軸の値150の所で交わる(catAx の crossesAt)
        ("交差位置=150", cat_ax(500001, 500002, crosses_at=150) + val_ax(500002, 500001, min_=0, max_=250, major=50)),
        ("軸の書式(千円)", cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50, num_fmt='#,##0"千円"', linked=False)),
    ]
    for k, (title, axes) in enumerate(charts):
        col = 3 + (k % 2) * 7
        row = 1 + (k // 2) * 15
        s.chart(two_cell(col, row, col + 7, row + 14), chart_space(bar_group(sers()) + axes, title=rich_title(title, sz=1200)))


def case_x08(b: Book):
    """第2軸：縦棒(左の軸)と、達成率の折れ線(右の第2軸、0%〜120%、間隔20%)。軸のタイトルつき"""
    s = b.sheet("Sheet1")
    s.table(0, 0, [["月", "売上", "達成率"]])
    sales = [800, 950, 1100, 1020, 1200, 1300]
    rate = [0.8, 0.95, 1.1, 1.02, 1.2, 1.3]
    for i, (m, v, r) in enumerate(zip(MONTHS, sales, rate), start=1):
        s.put(i, 0, m)
        s.put(i, 1, v)
        s.put(i, 2, r, ST_PCT)
    bar = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "売上", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 1, 6, 1), sales, sppr=sppr_fill(solid("accent1")))]
    line = [ser("line", 1, abs_range("Sheet1", 0, 2, 0, 2), "達成率", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 2, 6, 2), rate, sppr=sppr_line(solid("accent2")), marker=marker_xml("circle", 5, solid("accent2")), val_fmt="0%")]
    plot = (
        bar_group(bar, ax=(500001, 500002))
        + line_group(line, ax=(500003, 500004))
        + cat_ax(500001, 500002, title=ax_title("月"))
        + val_ax(500002, 500001, title=ax_title("売上（千円）", rot=-5400000), min_=0, max_=1400, major=200)
        + cat_ax(500003, 500004, delete=True)
        + val_ax(500004, 500003, pos="r", crosses="max", gridlines=False, min_=0, max_=1.4, major=0.2, num_fmt="0%", linked=False, title=ax_title("達成率", rot=-5400000))
    )
    s.chart(two_cell(4, 1, 13, 20), chart_space(plot, title=rich_title("売上と達成率"), leg=legend("b")))


def case_x09(b: Book):
    """日付軸：日付の間隔がそろっていない折れ線(日単位)。Excelは日付の間隔どおりに点を置く。もう1つは月単位の縦棒"""
    s = b.sheet("Sheet1")
    dates = [date_serial(2026, 1, d) for d in (1, 2, 5, 10, 20, 31)]
    vals = [10, 20, 30, 40, 50, 60]
    s.table(0, 0, [["日付", "件数"]])
    for i, (d, v) in enumerate(zip(dates, vals), start=1):
        s.put(i, 0, d, ST_MD)
        s.put(i, 1, v)
    sers = [ser("line", 0, abs_range("Sheet1", 0, 1, 0, 1), "件数", abs_range("Sheet1", 1, 0, 6, 0), dates, abs_range("Sheet1", 1, 1, 6, 1), vals, cat_num=True, cat_fmt="m/d", sppr=sppr_line(solid("accent1")), marker=marker_xml("circle", 5, solid("accent1")))]
    plot = line_group(sers) + cat_ax(500001, 500002, date=True, num_fmt="m/d", base_unit="days") + val_ax(500002, 500001, min_=0, max_=70, major=10)
    s.chart(two_cell(3, 1, 12, 16), chart_space(plot, title=rich_title("日付の間隔どおり")))
    months = [date_serial(2026, m, 1) for m in (1, 2, 3, 4, 5, 6)]
    for i, (d, v) in enumerate(zip(months, [5, 8, 6, 9, 7, 10]), start=1):
        s.put(i, 3 + 10, d, ST_DATE)
        s.put(i, 4 + 10, v)
    s.put(0, 13, "月初")
    s.put(0, 14, "件数")
    sers2 = [ser("bar", 0, abs_range("Sheet1", 0, 14, 0, 14), "件数", abs_range("Sheet1", 1, 13, 6, 13), months, abs_range("Sheet1", 1, 14, 6, 14), [5, 8, 6, 9, 7, 10], cat_num=True, cat_fmt="yyyy/m/d", sppr=sppr_fill(solid("accent6")))]
    plot2 = bar_group(sers2) + cat_ax(500001, 500002, date=True, num_fmt='yyyy"年"m"月"', linked=False, base_unit="months", major_unit=1, major_time_unit="months") + val_ax(500002, 500001, min_=0, max_=12, major=2)
    s.chart(two_cell(3, 17, 12, 32), chart_space(plot2, title=rich_title("月単位の日付軸")))


def case_x10(b: Book):
    """凡例の位置：上・左・右上・下。下のグラフは凡例の一部(費用)を削除"""
    series = (("売上", [120, 180, 150, 210]), ("費用", [90, 110, 130, 120]), ("利益", [30, 70, 20, 90]))
    s = base_sheet(b, series=series, cats=MONTHS[:4])
    for k, pos in enumerate(["t", "l", "tr", "b"]):
        sers = std_bar_series("Sheet1", series, MONTHS[:4])
        extra = '<c:legendEntry><c:idx val="1"/><c:delete val="1"/></c:legendEntry>' if pos == "b" else ""
        col = 5 + (k % 2) * 7
        row = 1 + (k // 2) * 15
        plot = bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001)
        s.chart(two_cell(col, row, col + 7, row + 14), chart_space(plot, title=rich_title(f"凡例={pos}", sz=1200), leg=legend(pos, extra)))


def small_chart(sheet: str, title: str, color="accent1", n=4) -> str:
    vals = [120, 180, 150, 210][:n]
    sers = [ser("bar", 0, abs_range(sheet, 0, 1, 0, 1), "売上", abs_range(sheet, 1, 0, n, 0), MONTHS[:n], abs_range(sheet, 1, 1, n, 1), vals, sppr=sppr_fill(solid(color)))]
    return chart_space(bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50), title=rich_title(title, sz=1200))


def case_x11(b: Book):
    """配置：列幅・行の高さが標準でないシートで、セルに合わせて移動・サイズ変更(twoCell)、移動のみ(editAs=oneCell)、
    固定(editAs=absolute)、oneCellAnchor、absoluteAnchor の5つ。保存されたファイルでは、どれも保存時の位置で描く"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]),), cats=MONTHS[:4])
    s.col_widths = {0: 6, 1: 6, 2: 20, 3: 4, 4: 12}
    s.row_heights = {6: 30, 7: 9, 12: 40}
    s.chart(two_cell(2, 5, 4, 14), small_chart("Sheet1", "セルに合わせる"))
    s.chart(two_cell(5, 1, 9, 10, edit_as="oneCell"), small_chart("Sheet1", "移動のみ", "accent2"))
    s.chart(two_cell(5, 11, 9, 20, edit_as="absolute"), small_chart("Sheet1", "固定", "accent6"))
    s.chart(one_cell(0, 16, 200, 120, co0=0, ro0=0), small_chart("Sheet1", "oneCell", "accent4"))
    s.chart(absolute(300, 470, 200, 120), small_chart("Sheet1", "absolute", "accent5"))


def case_x12(b: Book):
    """重なり：グラフ2つ(後のものが上)と、グラフの上に重なる画像"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]),), cats=MONTHS[:4])
    s.chart(two_cell(3, 1, 9, 13), small_chart("Sheet1", "下のグラフ", "accent1"))
    s.chart(two_cell(6, 7, 12, 19), small_chart("Sheet1", "上のグラフ", "accent2"))
    s.picture(two_cell(4, 9, 6, 12, edit_as="oneCell"), png_bytes(40, 30, (112, 48, 160)))


def case_x13(b: Book):
    """印刷範囲の境界：印刷範囲 A1:F20 の右の境界(F列とG列の間)をまたぐグラフ。範囲の外の部分は印刷しない"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]),), cats=MONTHS[:4])
    for r in range(20):
        s.put(r, 5, f"F{r + 1}") if r > 5 else None
    s.print_area = "Sheet1!$A$1:$F$20"
    s.chart(two_cell(3, 7, 9, 18), small_chart("Sheet1", "境界をまたぐ"))


def case_x14(b: Book):
    """改ページ付近：20行目の下に手動の改ページ。15〜30行目にまたがるグラフ"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]),), cats=MONTHS[:4])
    for r in range(6, 45):
        s.put(r, 0, f"行{r + 1}")
    s.row_breaks = [20]
    s.chart(two_cell(2, 14, 8, 30), small_chart("Sheet1", "改ページをまたぐ"))


def case_x15(b: Book):
    """複数シート：3シート(2つ目は非表示)。表示されるシートのグラフは、非表示のシートのデータを参照"""
    data = b.sheet("集計")
    data.table(0, 0, [["月", "売上"]] + [[m, v] for m, v in zip(MONTHS[:4], [120, 180, 150, 210])])
    data.chart(two_cell(3, 1, 9, 14), small_chart("集計", "集計のグラフ"))
    hidden = b.sheet("元データ")
    hidden.state = "hidden"
    hidden.table(0, 0, [["月", "件数"]] + [[m, v] for m, v in zip(MONTHS[:4], [5, 8, 6, 9])])
    hidden.chart(two_cell(3, 1, 9, 14), small_chart("元データ", "非表示シートのグラフ"))
    last = b.sheet("報告")
    last.landscape = True
    last.put(0, 0, "報告")
    sers = [ser("bar", 0, abs_range("元データ", 0, 1, 0, 1), None, abs_range("元データ", 1, 0, 4, 0), None, abs_range("元データ", 1, 1, 4, 1), None, sppr=sppr_fill(solid("accent2")))]
    last.chart(two_cell(1, 2, 9, 16), chart_space(bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=10, major=2), title=rich_title("非表示シートを参照", sz=1200)))


def case_x16(b: Book):
    """参照先が別のシート(シート名に空白)。値の控えなし"""
    g = b.sheet("グラフ")
    g.put(0, 0, "グラフはデータのシートを参照")
    d = b.sheet("データ 2026")
    d.table(0, 0, [["月", "売上", "費用"]] + [[m, v, w] for m, v, w in zip(MONTHS[:4], [120, 180, 150, 210], [90, 110, 130, 120])])
    sers = [
        ser("bar", j, abs_range("データ 2026", 0, j + 1, 0, j + 1), None, abs_range("データ 2026", 1, 0, 4, 0), None, abs_range("データ 2026", 1, j + 1, 4, j + 1), None, sppr=sppr_fill(solid(["accent1", "accent2"][j])))
        for j in range(2)
    ]
    g.chart(two_cell(1, 2, 9, 17), chart_space(bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50), title=rich_title("別シートのデータ"), leg=legend("b")))


def case_x17(b: Book):
    """参照先が別のブック([1]Sheet1!...)。①値の控えあり(Excelは開いたときに控えの値を表示する) ②控えなし"""
    b.external_links.append("売上データ.xlsx")
    s = b.sheet("Sheet1")
    s.put(0, 0, "別のブックを参照するグラフ")
    ext = "[1]Sheet1!$B$2:$B$5"
    cats = "[1]Sheet1!$A$2:$A$5"
    sers1 = [ser("bar", 0, None, "外部の売上", cats, MONTHS[:4], ext, [120, 180, 150, 210], sppr=sppr_fill(solid("accent1")))]
    sers2 = [ser("bar", 0, None, "外部の売上", cats, None, ext, None, sppr=sppr_fill(solid("accent2")))]
    s.chart(two_cell(1, 2, 7, 15), chart_space(bar_group(sers1) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50), title=rich_title("控えあり", sz=1200)))
    s.chart(two_cell(8, 2, 14, 15), chart_space(bar_group(sers2) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50), title=rich_title("控えなし", sz=1200)))


def case_x18(b: Book):
    """名前の定義を参照するグラフ：Sheet1!売上データ(ブック全体の名前)と、シートだけの名前。どちらも値の控えなし"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]), ("費用", [90, 110, 130, 120])), cats=MONTHS[:4])
    b.defined_names.append(("売上データ", "Sheet1!$B$2:$B$5", None))
    b.defined_names.append(("月の一覧", "Sheet1!$A$2:$A$5", None))
    b.defined_names.append(("費用データ", "Sheet1!$C$2:$C$5", 0))
    sers = [
        ser("bar", 0, None, "売上", "Sheet1!月の一覧", None, "Sheet1!売上データ", None, sppr=sppr_fill(solid("accent1"))),
        ser("bar", 1, None, "費用", "Sheet1!月の一覧", None, "Sheet1!費用データ", None, sppr=sppr_fill(solid("accent2"))),
    ]
    s.chart(two_cell(4, 1, 11, 16), chart_space(bar_group(sers) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=250, major=50), title=rich_title("名前の定義を参照"), leg=legend("b")))


def case_x19(b: Book):
    """大量のデータ：2系列×3000点の折れ線と、2000点の散布図(値の控えあり)"""
    import math

    s = b.sheet("Sheet1")
    n = 3000
    s.table(0, 0, [["番号", "A", "B"]])
    a = [round(500 + 300 * math.sin(i / 150) + (i % 7) * 3, 1) for i in range(n)]
    c = [round(400 + 200 * math.cos(i / 90), 1) for i in range(n)]
    for i in range(n):
        s.put(i + 1, 0, i + 1)
        s.put(i + 1, 1, a[i])
        s.put(i + 1, 2, c[i])
    cats = list(range(1, n + 1))
    sers = [
        ser("line", 0, abs_range("Sheet1", 0, 1, 0, 1), "A", abs_range("Sheet1", 1, 0, n, 0), cats, abs_range("Sheet1", 1, 1, n, 1), a, cat_num=True, sppr=sppr_line(solid("accent1"), w=12700), marker=marker_xml("none")),
        ser("line", 1, abs_range("Sheet1", 0, 2, 0, 2), "B", abs_range("Sheet1", 1, 0, n, 0), cats, abs_range("Sheet1", 1, 2, n, 2), c, cat_num=True, sppr=sppr_line(solid("accent2"), w=12700), marker=marker_xml("none")),
    ]
    s.chart(two_cell(4, 1, 14, 18), chart_space(line_group(sers, marker=False) + cat_ax(500001, 500002) + val_ax(500002, 500001), title=rich_title("3000点の折れ線"), leg=legend("b")))
    m = 2000
    xs = [round((i * 37) % 1000 / 10, 1) for i in range(m)]
    ys = [round(x * 2 + ((i * 53) % 40) - 20, 1) for i, x in enumerate(xs)]
    # 散布図のデータは E・F列(セルの値と、グラフの値の控えを同じにする)
    s.put(0, 4, "X")
    s.put(0, 5, "Y")
    for i in range(m):
        s.put(i + 1, 4, xs[i])
        s.put(i + 1, 5, ys[i])
    sc = [ser("scatter", 0, None, "点", abs_range("Sheet1", 1, 4, m, 4), xs, abs_range("Sheet1", 1, 5, m, 5), ys, sppr='<c:spPr><a:ln w="25400"><a:noFill/></a:ln></c:spPr>', marker=marker_xml("circle", 3, solid("accent1")))]
    plot = (
        f'<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>{"".join(sc)}<c:axId val="600001"/><c:axId val="600002"/></c:scatterChart>'
        + val_ax(600001, 600002, pos="b", gridlines=False).replace('<c:crossBetween val="between"/>', '<c:crossBetween val="midCat"/>')
        + val_ax(600002, 600001).replace('<c:crossBetween val="between"/>', '<c:crossBetween val="midCat"/>')
    )
    s.chart(two_cell(4, 20, 14, 37), chart_space(plot, title=rich_title("2000点の散布図")))


def case_x20(b: Book):
    """系列が多い：15系列の縦棒と、25系列の折れ線(自動の色は6色を超えると明暗を変えて繰り返す)"""
    s = b.sheet("Sheet1")
    s.put(0, 0, "月")
    for i, m in enumerate(MONTHS[:4]):
        s.put(i + 1, 0, m)
    N = 25
    for j in range(N):
        s.put(0, j + 1, f"店{j + 1:02d}")
        for i in range(4):
            s.put(i + 1, j + 1, 50 + ((j * 13 + i * 29) % 100))
    def auto_sers(kind, n):
        out = []
        for j in range(n):
            vals = [50 + ((j * 13 + i * 29) % 100) for i in range(4)]
            # Excelが書く自動の色：accent1〜6、7系列目からは lumMod 60000 等
            k = j % 6
            rnd = j // 6
            mods = {} if rnd == 0 else ({"lumMod": 60000} if rnd == 1 else ({"lumMod": 80000, "lumOff": 20000} if rnd == 2 else {"lumMod": 80000}))
            col = solid(f"accent{k + 1}", mods=mods)
            if kind == "bar":
                out.append(ser("bar", j, abs_range("Sheet1", 0, j + 1, 0, j + 1), f"店{j + 1:02d}", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, j + 1, 4, j + 1), vals, sppr=sppr_fill(col)))
            else:
                out.append(ser("line", j, abs_range("Sheet1", 0, j + 1, 0, j + 1), f"店{j + 1:02d}", abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, j + 1, 4, j + 1), vals, sppr=sppr_line(col, w=19050), marker=marker_xml("none")))
        return out
    s.chart(two_cell(2, 6, 14, 26), chart_space(bar_group(auto_sers("bar", 15), gap=60) + cat_ax(500001, 500002) + val_ax(500002, 500001), title=rich_title("15系列"), leg=legend("r")))
    s.chart(two_cell(2, 28, 14, 48), chart_space(line_group(auto_sers("line", 25), marker=False) + cat_ax(500001, 500002) + val_ax(500002, 500001), title=rich_title("25系列"), leg=legend("r")))


def case_x21(b: Book):
    """日本語：日本語のシート名・タイトル・凡例・長い分類名・縦書きの軸タイトル"""
    cats = ["北海道・東北地方", "関東地方", "中部地方", "近畿地方", "中国・四国地方", "九州・沖縄地方"]
    series = (("前年度実績", [320, 980, 610, 720, 280, 450]), ("今年度実績", [350, 1020, 640, 700, 300, 470]))
    s = base_sheet(b, name="地域別集計", series=series, cats=cats)
    s.put(0, 0, "地域")
    sers = std_bar_series("地域別集計", series, cats)
    plot = bar_group(sers) + cat_ax(500001, 500002, title=ax_title("地域")) + val_ax(500002, 500001, title=ax_title("売上高（百万円）", rot=-5400000))
    s.chart(two_cell(4, 1, 13, 20), chart_space(plot, title=rich_title("地域別の売上高（前年度との比較）"), leg=legend("b")))


def case_x22(b: Book):
    """日付と通貨：分類は日付(yyyy年m月d日の書式のセル)、値は ¥#,##0。軸・ラベルはセルの書式に連動(sourceLinked=1)"""
    s = b.sheet("Sheet1")
    s.table(0, 0, [["日付", "金額"]])
    dates = [date_serial(2026, 4, d) for d in (1, 2, 3, 6)]
    vals = [125000, 98000, 143500, 110250]
    for i, (d, v) in enumerate(zip(dates, vals), start=1):
        s.put(i, 0, d, ST_JDATE)
        s.put(i, 1, v, ST_YEN)
    fmt_d = 'yyyy"年"m"月"d"日"'
    fmt_y = '"¥"#,##0'
    sers = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "金額", abs_range("Sheet1", 1, 0, 4, 0), dates, abs_range("Sheet1", 1, 1, 4, 1), vals, cat_num=True, cat_fmt=fmt_d, val_fmt=fmt_y, sppr=sppr_fill(solid("accent1")),
                extra=dlbls(show_val=True, pos="outEnd").replace('<c:dLbls>', f'<c:dLbls><c:numFmt formatCode="{attr(fmt_y)}" sourceLinked="1"/>'))]
    plot = bar_group(sers) + cat_ax(500001, 500002, num_fmt=fmt_d) + val_ax(500002, 500001, num_fmt=fmt_y)
    s.chart(two_cell(3, 1, 12, 18), chart_space(plot, title=rich_title("日付と金額")))
    # 控えなし版(セルの書式から表示する)
    sers2 = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), None, abs_range("Sheet1", 1, 0, 4, 0), None, abs_range("Sheet1", 1, 1, 4, 1), None, sppr=sppr_fill(solid("accent2")))]
    plot2 = bar_group(sers2) + cat_ax(500001, 500002, num_fmt=fmt_d) + val_ax(500002, 500001, num_fmt=fmt_y)
    s.chart(two_cell(3, 19, 12, 36), chart_space(plot2, title=rich_title("控えなし")))


def case_x23(b: Book):
    """負の数：縦棒・横棒・折れ線。縦棒は分類名を下端(tickLblPos=low)、横棒は既定(nextTo)"""
    vals = [120, -80, 60, -150, 200, -30]
    s = base_sheet(b, series=(("損益", vals),))
    s1 = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "損益", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 1, 6, 1), vals, sppr=sppr_fill(solid("accent1")))]
    s.chart(two_cell(3, 1, 10, 15), chart_space(bar_group(s1) + cat_ax(500001, 500002, tick_lbl="low") + val_ax(500002, 500001), title=rich_title("縦棒(負の数)", sz=1200)))
    s2 = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "損益", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 1, 6, 1), vals, sppr=sppr_fill(solid("accent2")))]
    s.chart(two_cell(11, 1, 18, 15), chart_space(bar_group(s2, bar_dir="bar") + cat_ax(500001, 500002, pos="l") + val_ax(500002, 500001, pos="b"), title=rich_title("横棒(負の数)", sz=1200)))
    s3 = [ser("line", 0, abs_range("Sheet1", 0, 1, 0, 1), "損益", abs_range("Sheet1", 1, 0, 6, 0), MONTHS, abs_range("Sheet1", 1, 1, 6, 1), vals, sppr=sppr_line(solid("accent6")), marker=marker_xml("circle", 5, solid("accent6")))]
    s.chart(two_cell(3, 16, 10, 30), chart_space(line_group(s3) + cat_ax(500001, 500002) + val_ax(500002, 500001), title=rich_title("折れ線(負の数)", sz=1200)))


def case_x24(b: Book):
    """0と空白：円グラフ(0と空白の扇形を含む、割合のラベル)と、0を含む縦棒(値のラベル)"""
    cats = ["A", "B", "C", "D", "E"]
    vals = [50, 0, 30, None, 20]
    s = base_sheet(b, series=(("件数", vals),), cats=cats)
    pie_ser = [ser("pie", 0, abs_range("Sheet1", 0, 1, 0, 1), "件数", abs_range("Sheet1", 1, 0, 5, 0), cats, abs_range("Sheet1", 1, 1, 5, 1), vals,
                   extra="".join(f'<c:dPt><c:idx val="{i}"/><c:bubble3D val="0"/>{sppr_fill(solid(f"accent{i + 1}"), "<a:ln w=\"19050\"><a:solidFill><a:schemeClr val=\"lt1\"/></a:solidFill></a:ln>")}</c:dPt>' for i in range(5))
                   + dlbls(show_pct=True, pos="bestFit"))]
    pie = f'<c:pieChart><c:varyColors val="1"/>{"".join(pie_ser)}<c:firstSliceAng val="0"/></c:pieChart>'
    s.chart(two_cell(3, 1, 10, 16), chart_space(pie, title=rich_title("0と空白を含む円", sz=1200), leg=legend("r")))
    bar = [ser("bar", 0, abs_range("Sheet1", 0, 1, 0, 1), "件数", abs_range("Sheet1", 1, 0, 5, 0), cats, abs_range("Sheet1", 1, 1, 5, 1), vals, sppr=sppr_fill(solid("accent1")), extra=dlbls(show_val=True, pos="outEnd"))]
    s.chart(two_cell(11, 1, 18, 16), chart_space(bar_group(bar) + cat_ax(500001, 500002) + val_ax(500002, 500001, min_=0, max_=60, major=10), title=rich_title("0を含む縦棒", sz=1200)))


def case_x25(b: Book):
    """対応していない種類：3-D縦棒・レーダー・株価・バブル・等高線・補助円・ウォーターフォール・ツリーマップ(1シートに8つ)"""
    s = base_sheet(b, series=(("売上", [120, 180, 150, 210]), ("費用", [90, 110, 130, 120]), ("利益", [30, 70, 20, 90])), cats=MONTHS[:4])
    def sers(kind="bar", n=1):
        return [ser(kind, j, None, ["売上", "費用", "利益"][j], abs_range("Sheet1", 1, 0, 4, 0), MONTHS[:4], abs_range("Sheet1", 1, j + 1, 4, j + 1), [[120, 180, 150, 210], [90, 110, 130, 120], [30, 70, 20, 90]][j]) for j in range(n)]
    ax = cat_ax(500001, 500002) + val_ax(500002, 500001)
    groups = [
        ("3-D縦棒", f'<c:view3D><c:rotX val="15"/><c:rotY val="20"/><c:rAngAx val="1"/></c:view3D>', f'<c:bar3DChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>{"".join(sers())}<c:gapWidth val="150"/><c:shape val="box"/><c:axId val="500001"/><c:axId val="500002"/><c:axId val="0"/></c:bar3DChart>' + ax),
        ("レーダー", "", f'<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>{"".join(s_.replace('<c:smooth val="0"/>', "") for s_ in sers("line"))}<c:axId val="500001"/><c:axId val="500002"/></c:radarChart>' + ax),
        ("株価", "", f'<c:stockChart>{"".join(sers("line", 3))}<c:hiLowLines/><c:axId val="500001"/><c:axId val="500002"/></c:stockChart>' + ax),
        ("バブル", "", '<c:bubbleChart><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:xVal><c:numRef><c:f>Sheet1!$B$2:$B$5</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>Sheet1!$C$2:$C$5</c:f></c:numRef></c:yVal><c:bubbleSize><c:numRef><c:f>Sheet1!$D$2:$D$5</c:f></c:numRef></c:bubbleSize><c:bubble3D val="0"/></c:ser><c:bubbleScale val="100"/><c:showNegBubbles val="0"/><c:axId val="600001"/><c:axId val="600002"/></c:bubbleChart>' + val_ax(600001, 600002, pos="b") + val_ax(600002, 600001)),
        ("等高線", "", f'<c:surfaceChart><c:wireframe val="0"/>{"".join(s_.replace("<c:invertIfNegative val=\"0\"/>", "") for s_ in sers("bar", 2))}<c:axId val="500001"/><c:axId val="500002"/><c:axId val="500003"/></c:surfaceChart>' + ax + '<c:serAx><c:axId val="500003"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="500002"/><c:crosses val="autoZero"/></c:serAx>'),
        ("補助円", "", f'<c:ofPieChart><c:ofPieType val="pie"/><c:varyColors val="1"/>{"".join(sers("pie"))}<c:gapWidth val="100"/><c:secondPieSize val="75"/></c:ofPieChart>'),
    ]
    for k, (title, pre, plot) in enumerate(groups):
        col = 5 + (k % 2) * 6
        row = 1 + (k // 2) * 12
        xml = chart_space(plot, title=rich_title(title, sz=1200))
        if pre:
            xml = xml.replace("<c:chart>", "<c:chart>").replace("<c:plotArea>", pre + "<c:plotArea>", 1)
        s.chart(two_cell(col, row, col + 6, row + 11), xml)
    for k, (layout, title) in enumerate([("waterfall", "ウォーターフォール"), ("treemap", "ツリーマップ")]):
        cx = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cx:chartSpace xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">'
            '<cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$5</cx:f></cx:strDim><cx:numDim type="val"><cx:f>Sheet1!$B$2:$B$5</cx:f></cx:numDim></cx:data></cx:chartData>'
            f'<cx:chart><cx:title pos="t" align="ctr" overlay="0"><cx:tx><cx:txData><cx:v>{title}</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="{layout}" uniqueId="{{00000000-0000-0000-0000-00000000000{k}}}"><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>'
        )
        col = 5 + k * 6
        s.drawings.append({"anchor": two_cell(col, 37, col + 6, 48), "chartex": cx})


CASES = [
    ("x01-standard-column", case_x01),
    ("x02-no-cache-formula", case_x02),
    ("x03-blank-cells", case_x03),
    ("x04-hidden-rows", case_x04),
    ("x05-rich-title-theme", case_x05),
    ("x06-point-format-labels", case_x06),
    ("x07-axis-settings", case_x07),
    ("x08-secondary-axis", case_x08),
    ("x09-date-axis", case_x09),
    ("x10-legend-positions", case_x10),
    ("x11-anchor-types", case_x11),
    ("x12-overlap", case_x12),
    ("x13-print-area-boundary", case_x13),
    ("x14-page-break", case_x14),
    ("x15-multi-sheet-hidden", case_x15),
    ("x16-other-sheet-ref", case_x16),
    ("x17-external-book-ref", case_x17),
    ("x18-defined-names", case_x18),
    ("x19-large-data", case_x19),
    ("x20-many-series", case_x20),
    ("x21-japanese", case_x21),
    ("x22-date-currency", case_x22),
    ("x23-negative-values", case_x23),
    ("x24-zero-blank", case_x24),
    ("x25-unsupported-types", case_x25),
]


# ───────────────────────── 分類の軸の項目名の表示の検証ケース ─────────────────────────


def label_sheet(b: Book, cats: list, series: list[tuple[str, list]], name="Sheet1", cat_style=ST_GENERAL) -> Sheet:
    s = b.sheet(name)
    s.put(0, 0, "項目")
    for j, (nm, vals) in enumerate(series):
        s.put(0, j + 1, nm)
        for i, v in enumerate(vals):
            s.put(i + 1, j + 1, v)
    for i, c in enumerate(cats):
        s.put(i + 1, 0, c, cat_style)
    return s


def label_series(kind: str, sheet: str, cats: list, series, *, cat_num=False, cat_fmt="General", colors=("accent1", "accent2", "accent6")):
    n = len(cats)
    out = []
    for j, (nm, vals) in enumerate(series):
        col = colors[j % len(colors)]
        common = dict(cat_num=cat_num, cat_fmt=cat_fmt)
        if kind == "bar":
            out.append(ser("bar", j, abs_range(sheet, 0, j + 1, 0, j + 1), nm, abs_range(sheet, 1, 0, n, 0), list(cats), abs_range(sheet, 1, j + 1, n, j + 1), list(vals), sppr=sppr_fill(solid(col)), **common))
        else:
            out.append(ser("line", j, abs_range(sheet, 0, j + 1, 0, j + 1), nm, abs_range(sheet, 1, 0, n, 0), list(cats), abs_range(sheet, 1, j + 1, n, j + 1), list(vals), sppr=sppr_line(solid(col), w=19050), marker=marker_xml("none"), **common))
    return out


def wave(n: int, k: int = 0) -> list:
    import math

    return [round(100 + 60 * math.sin((i + k * 7) / max(3, n / 12)) + (i * 13 + k * 5) % 17, 1) for i in range(n)]


def simple_chart(b: Book, kind: str, cats: list, title: str, *, anchor=None, bar_dir="col", cat_ax_kw=None, leg=None, n_series=1, cat_num=False, cat_fmt="General", cat_style=ST_GENERAL):
    series = [(["売上", "費用", "利益"][k], wave(len(cats), k)) for k in range(n_series)]
    s = label_sheet(b, cats, series, cat_style=cat_style)
    sers = label_series(kind, "Sheet1", cats, series, cat_num=cat_num, cat_fmt=cat_fmt)
    group = bar_group(sers, bar_dir=bar_dir) if kind == "bar" else line_group(sers, marker=False)
    pos_c, pos_v = ("l", "b") if bar_dir == "bar" else ("b", "l")
    plot = group + cat_ax(500001, 500002, pos=pos_c, **(cat_ax_kw or {})) + val_ax(500002, 500001, pos=pos_v)
    s.chart(anchor or two_cell(3, 1, 13, 20), chart_space(plot, title=rich_title(title), leg=leg))
    return s


def case_y01(b):
    """項目数10(縦棒)：全部を横書きで表示できる"""
    simple_chart(b, "bar", [f"{i + 1}月" for i in range(10)], "項目数10")


def case_y02(b):
    """項目数30(縦棒)：横書きでは入らない"""
    simple_chart(b, "bar", [f"商品{i + 1:02d}" for i in range(30)], "項目数30")


def case_y03(b):
    """項目数100(折れ線)"""
    simple_chart(b, "line", [f"No.{i + 1:03d}" for i in range(100)], "項目数100")


def case_y04(b):
    """項目数500(折れ線)"""
    simple_chart(b, "line", [f"ID-{i + 1:04d}" for i in range(500)], "項目数500")


def case_y05(b):
    """項目数3000(折れ線・分類は数値)"""
    n = 3000
    simple_chart(b, "line", list(range(1, n + 1)), "項目数3000", cat_num=True)


LONG_JA = ["北海道・東北地方の営業所（札幌・仙台）", "関東地方の本社営業部", "中部地方の営業所（名古屋）", "近畿地方の営業所（大阪・京都・神戸）", "中国・四国地方の営業所", "九州・沖縄地方の営業所（福岡）"]


def case_y06(b):
    """長い日本語の項目名(縦棒・6項目)"""
    simple_chart(b, "bar", LONG_JA, "長い日本語の項目名", n_series=2, leg=legend("b"))


def case_y07(b):
    """英数字と日本語が混ざった項目名(縦棒)"""
    cats = ["iPhone 15 Pro（256GB）", "Galaxy S24 Ultra 512GB", "Pixel 8a（ベーシック）", "Xperia 1 VI 限定モデル", "AQUOS sense8 SH-54D"]
    simple_chart(b, "bar", cats, "英数字と日本語の混在")


def case_y08(b):
    """日付の横軸(折れ線・90日分の日付)"""
    dates = [date_serial(2026, 1, 1) + i for i in range(90)]
    simple_chart(b, "line", dates, "日付の横軸", cat_num=True, cat_fmt="yyyy/m/d", cat_style=ST_DATE)


def case_y09(b):
    """長さがばらばらな項目名(縦棒)"""
    cats = ["A", "東京", "神奈川県横浜市", "B社", "株式会社サンプル商事 大阪支店", "C", "千葉", "埼玉県さいたま市大宮区"]
    simple_chart(b, "bar", cats, "長さが不均一な項目名")


def case_y10(b):
    """横棒：長い日本語の項目名(8項目)と、項目数40"""
    s = simple_chart(b, "bar", LONG_JA + ["本社（東京都千代田区丸の内）", "海外事業部"], "横棒・長い項目名", bar_dir="bar", anchor=two_cell(3, 1, 13, 20))
    del s
    # 2つ目のグラフ(同じシート、項目数40)
    cats = [f"支店{i + 1:02d}" for i in range(40)]
    sh = b.sheets[0]
    for i, c in enumerate(cats):
        sh.put(i + 1, 20, c)
        sh.put(i + 1, 21, wave(40)[i])
    sh.put(0, 20, "支店")
    sh.put(0, 21, "件数")
    sers = [ser("bar", 0, abs_range("Sheet1", 0, 21, 0, 21), "件数", abs_range("Sheet1", 1, 20, 40, 20), cats, abs_range("Sheet1", 1, 21, 40, 21), wave(40), sppr=sppr_fill(solid("accent2")))]
    plot = bar_group(sers, bar_dir="bar", gap=50) + cat_ax(500001, 500002, pos="l") + val_ax(500002, 500001, pos="b")
    sh.chart(two_cell(3, 22, 13, 48), chart_space(plot, title=rich_title("横棒・項目数40")))


def case_y11(b):
    """折れ線：36か月(2024年1月〜)"""
    cats = [f"{2024 + i // 12}年{i % 12 + 1}月" for i in range(36)]
    simple_chart(b, "line", cats, "折れ線・36か月", n_series=2, leg=legend("b"))


def case_y12(b):
    """複合(縦棒＋折れ線)：20項目の長めの項目名"""
    cats = [f"{2021 + i // 4}年度 第{i % 4 + 1}四半期" for i in range(20)]
    series = [("売上", wave(20)), ("利益率", [round(0.1 + (i % 7) * 0.02, 2) for i in range(20)])]
    s = label_sheet(b, cats, series)
    bars_ = label_series("bar", "Sheet1", cats, series[:1])
    line = label_series("line", "Sheet1", cats, series[1:])
    line = [x.replace('<c:idx val="0"/><c:order val="0"/>', '<c:idx val="1"/><c:order val="1"/>') for x in line]
    plot = (
        bar_group(bars_, ax=(500001, 500002))
        + line_group(line, ax=(500003, 500004), marker=False)
        + cat_ax(500001, 500002)
        + val_ax(500002, 500001)
        + cat_ax(500003, 500004, delete=True)
        + val_ax(500004, 500003, pos="r", crosses="max", gridlines=False, num_fmt="0%", linked=False)
    )
    s.chart(two_cell(3, 1, 14, 22), chart_space(plot, title=rich_title("複合・20項目"), leg=legend("b")))


def case_y13(b):
    """凡例・タイトル・軸のタイトルがすべてある縦棒(12項目・長めの項目名)"""
    cats = [f"{m}月度（第{(m - 1) // 3 + 1}四半期）" for m in range(1, 13)]
    series = [("売上", wave(12)), ("費用", wave(12, 1))]
    s = label_sheet(b, cats, series)
    sers = label_series("bar", "Sheet1", cats, series)
    plot = bar_group(sers) + cat_ax(500001, 500002, title=ax_title("月度")) + val_ax(500002, 500001, title=ax_title("金額（千円）", rot=-5400000))
    s.chart(two_cell(3, 1, 13, 22), chart_space(plot, title=rich_title("月度別の売上と費用"), leg=legend("b")))


def case_y14(b):
    """Excel側の指定：①間隔3・角度-45度(右上がり)／②縦書き(90度)／③角度0度(横書き)・間隔2"""
    cats = [f"商品{i + 1:02d}" for i in range(30)]
    series = [("売上", wave(30))]
    s = label_sheet(b, cats, series)
    specs = [
        ("間隔3・45度", dict(label_skip=3, label_rot="-2700000"), two_cell(3, 1, 12, 16)),
        ("縦書き90度", dict(label_rot="-5400000"), two_cell(3, 17, 12, 32)),
        ("横書き・間隔2", dict(label_skip=2, label_rot="0"), two_cell(3, 33, 12, 48)),
    ]
    for title, kw, anchor in specs:
        sers = label_series("bar", "Sheet1", cats, series)
        plot = bar_group(sers) + cat_ax(500001, 500002, **kw) + val_ax(500002, 500001)
        s.chart(anchor, chart_space(plot, title=rich_title(title, sz=1200)))


LABEL_CASES = [
    ("y01-count-10", case_y01),
    ("y02-count-30", case_y02),
    ("y03-count-100", case_y03),
    ("y04-count-500", case_y04),
    ("y05-count-3000", case_y05),
    ("y06-long-japanese", case_y06),
    ("y07-mixed-alnum-japanese", case_y07),
    ("y08-date-axis", case_y08),
    ("y09-uneven-length", case_y09),
    ("y10-horizontal-bar", case_y10),
    ("y11-line-36-months", case_y11),
    ("y12-combo", case_y12),
    ("y13-title-legend-axis-titles", case_y13),
    ("y14-explicit-skip-rotation", case_y14),
]


# ───────────────────────── グラフのページ境界チェックの検証ケース ─────────────────────────
# A4縦・余白(左右0.7インチ・上下0.75インチ)・游ゴシック11pt(標準の列幅8.38文字=54pt、行の高さ18.75pt)のとき、
# 1ページに入るのは 9列(A〜I、486pt) × 39行(731.25pt)。A4横は 13列 × 25行。


def pc_sheet(b: Book, name="Sheet1", rows=45, cols=12) -> Sheet:
    """表(番号と値)を入れたシート。何も無いページにならないよう、指定した範囲の四隅にも文字を置く"""
    s = b.sheet(name)
    s.put(0, 0, "月")
    s.put(0, 1, "売上")
    for i, m in enumerate(MONTHS[:4]):
        s.put(i + 1, 0, m)
        s.put(i + 1, 1, [120, 180, 150, 210][i])
    for r in range(6, rows):
        s.put(r, 0, f"行{r + 1}")
    s.put(0, cols - 1, "右上")
    s.put(rows - 1, cols - 1, "右下")
    return s


def pc_chart(sheet: str, title: str, color="accent1") -> str:
    return small_chart(sheet, title, color)


def case_p01(b):
    """ページの境目をまたがないグラフ(D2〜H16。1ページ目の中)"""
    s = pc_sheet(b)
    s.chart(two_cell(3, 1, 8, 16), pc_chart("Sheet1", "1ページに収まる"))


def case_p02(b):
    """左右のページの境目(I列とJ列の間)をまたぐグラフ(G2〜M16)"""
    s = pc_sheet(b, cols=16)
    s.chart(two_cell(6, 1, 13, 16), pc_chart("Sheet1", "左右にまたぐ"))


def case_p03(b):
    """上下のページの境目(39行目と40行目の間)をまたぐグラフ(B31〜H50)"""
    s = pc_sheet(b, rows=60)
    s.chart(two_cell(1, 30, 7, 50), pc_chart("Sheet1", "上下にまたぐ"))


def case_p04(b):
    """手動の改ページ(20行目の下)の上に置いたグラフ(B13〜H28)"""
    s = pc_sheet(b, rows=50)
    s.row_breaks = [20]
    s.chart(two_cell(1, 12, 7, 28), pc_chart("Sheet1", "手動の改ページ"))


def case_p05(b):
    """自動の改ページ(39行目の下)の上に置いたグラフ。表は80行(B35〜G46)"""
    s = pc_sheet(b, rows=80, cols=8)
    s.chart(two_cell(1, 34, 6, 46), pc_chart("Sheet1", "自動の改ページ"))


def case_p06(b):
    """印刷範囲(A1:G30)の右の端にかかるグラフ(E3〜J15)。範囲の外の部分は出力されない"""
    s = pc_sheet(b, rows=30, cols=7)
    s.print_area = "Sheet1!$A$1:$G$30"
    s.chart(two_cell(4, 2, 9, 15), pc_chart("Sheet1", "印刷範囲の端"))


def case_p07(b):
    """印刷範囲(A1:E20)の外にあるグラフ(K3〜Q15)"""
    s = pc_sheet(b, rows=20, cols=5)
    s.print_area = "Sheet1!$A$1:$E$20"
    s.chart(two_cell(10, 2, 16, 15), pc_chart("Sheet1", "印刷範囲の外"))


def case_p08(b):
    """拡大縮小50%：1ページに 18列 × 78行 入る。グラフ(B71〜H86)は78行目と79行目の間をまたぐ"""
    s = pc_sheet(b, rows=120, cols=10)
    s.scale = 50
    s.chart(two_cell(1, 70, 7, 86), pc_chart("Sheet1", "縮小50%でまたぐ"))


def case_p09(b):
    """A4横：1ページに 13列 × 25行。グラフ(C19〜I32)は25行目と26行目の間をまたぐ"""
    s = pc_sheet(b, rows=40, cols=10)
    s.landscape = True
    s.chart(two_cell(2, 18, 8, 32), pc_chart("Sheet1", "横向きでまたぐ"))


def case_p10(b):
    """1ページより大きいグラフ(B3〜U70。幅も高さも1ページより大きい)"""
    s = pc_sheet(b, rows=75, cols=22)
    s.chart(two_cell(1, 2, 20, 70), pc_chart("Sheet1", "大きなグラフ"))


def case_p11(b):
    """1シートに複数のグラフ：①1ページに収まる ②左右にまたぐ ③上下の境目にわずかにかかる(約5pt)"""
    s = pc_sheet(b, rows=60, cols=16)
    s.chart(two_cell(2, 1, 7, 14), pc_chart("Sheet1", "収まる"))
    s.chart(two_cell(6, 16, 12, 28), pc_chart("Sheet1", "左右にまたぐ", "accent2"))
    s.chart(two_cell(1, 30, 6, 39, ro1=5 * EMU), pc_chart("Sheet1", "わずかにかかる", "accent6"))


def case_p12(b):
    """非表示のシートにあるグラフ：表示されるシート(収まるグラフ)と、非表示のシート(またぐグラフ)"""
    s = pc_sheet(b, name="表示")
    s.chart(two_cell(3, 1, 8, 16), small_chart("表示", "表示のシート"))
    h = pc_sheet(b, name="非表示", cols=16)
    h.state = "hidden"
    h.chart(two_cell(6, 1, 13, 16), small_chart("非表示", "非表示のシート"))


def case_p13(b):
    """グラフと画像の重なり：上下にまたぐグラフ(B31〜H50)の上に画像。画像は確認の対象にしない"""
    s = pc_sheet(b, rows=60)
    s.chart(two_cell(1, 30, 7, 50), pc_chart("Sheet1", "画像と重なる"))
    s.picture(two_cell(3, 33, 5, 37, edit_as="oneCell"), png_bytes(60, 40, (112, 48, 160)))


def case_p14(b):
    """ページの境目に近いだけで、またがないグラフ(B26〜H39。39行目の下端の約3pt手前で終わる)"""
    s = pc_sheet(b, rows=60)
    s.chart(two_cell(1, 25, 7, 38, ro1=int((18.75 - 3) * EMU)), pc_chart("Sheet1", "近いがまたがない"))


def case_p15(b):
    """非表示の行(5〜14行目)があるシート：グラフ(B41〜H47)は、非表示の行を除くと1ページ目に収まる"""
    s = pc_sheet(b, rows=60)
    for r in range(4, 14):
        s.hidden_rows.add(r)
    s.chart(two_cell(1, 40, 7, 47), pc_chart("Sheet1", "非表示の行の後"))


def case_p16(b):
    """手動の改ページ(列：E列の右)の上に置いたグラフ(C3〜H15)"""
    s = pc_sheet(b, rows=30, cols=10)
    s.col_breaks = [5]
    s.chart(two_cell(2, 2, 7, 15), pc_chart("Sheet1", "列の手動改ページ"))


PAGECHECK_CASES = [
    ("p01-no-cross", case_p01),
    ("p02-cross-columns", case_p02),
    ("p03-cross-rows", case_p03),
    ("p04-manual-row-break", case_p04),
    ("p05-auto-row-break", case_p05),
    ("p06-print-area-edge", case_p06),
    ("p07-outside-print-area", case_p07),
    ("p08-scaled-50", case_p08),
    ("p09-landscape", case_p09),
    ("p10-large-chart", case_p10),
    ("p11-multiple-charts", case_p11),
    ("p12-hidden-sheet", case_p12),
    ("p13-chart-and-image", case_p13),
    ("p14-near-not-crossing", case_p14),
    ("p15-hidden-rows", case_p15),
    ("p16-manual-col-break", case_p16),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(OUT_LABELS, exist_ok=True)
    os.makedirs(OUT_PAGECHECK, exist_ok=True)
    bad = 0
    all_cases = [(OUT, n, f) for n, f in CASES] + [(OUT_LABELS, n, f) for n, f in LABEL_CASES] + [(OUT_PAGECHECK, n, f) for n, f in PAGECHECK_CASES]
    for out_dir, name, fn in all_cases:
        _uid[0] = 0
        b = Book()
        fn(b)
        path = os.path.join(out_dir, f"{name}.xlsx")
        b.save(path)
        problems = validate(path)
        print(f"{name}.xlsx  {'OK' if not problems else '問題あり'}")
        for p in problems:
            print("   -", p)
        bad += len(problems)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
