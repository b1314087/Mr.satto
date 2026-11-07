#!/usr/bin/env python3
"""
Excel→PDF 印刷の再現性・内容の欠落の監査用Excel(OOXMLを直接作る)と、その期待値(JSON)を作る。

- Excelの部品は tests/fixtures/excel-chart/generate_ooxml_chart_fixtures.py の Book を使う(LibreOfficeは通さない)。
- セルには、場所が分かる固有の文字(例: @J50、2枚目のシートは S2@J50)を入れる。
- 期待値(ページ数・各ページの用紙の大きさ・各文字が出るページ・出てはいけない文字)は、このファイルの中の
  「Excelの印刷の決まりに沿ったページの分け方」で計算する。Mr.Satto(TypeScript)の計算とは別に作った計算なので、
  両者が食い違えば、どちらかの解釈の誤りが見つかる。

Excelの決まり(このファイルの計算の前提):
  - 列の幅(文字数)→ピクセル: trunc(((256×幅 + trunc(128/MDW)) / 256) × MDW)、1px = 0.75pt。
    游ゴシック11ptの MDW は 8px。幅の指定の無い列は 8.38文字 = 72px = 54pt。行の高さの既定は 18.75pt。
  - 印刷できる幅・高さ = 用紙 − 左右(上下)の余白。
  - 「次のページ数に合わせて印刷」(fitToPage)が有効なら、倍率 = min(1, 横ページ数×幅÷表の幅, 縦ページ数×高さ÷表の高さ)
    (0=自動の方向は制限しない)。このとき手動の改ページは使わない。無効なら pageSetup@scale(10〜400%)。
  - ページは、入るだけ列(行)を詰めて分ける。手動の改ページではそこで分ける。行・列の途中では分けない。
  - ページの順は「左から右へ、ではなく上から下へ」(既定の「下へ、次に右へ」)。
  - 印刷範囲が複数あるときは、範囲ごとに新しいページから。
  - 値・書式・画像・グラフの何も無いページは出力しない。
  - 印刷タイトル(行)は毎ページの上に繰り返す(その分、1ページに入る行が減る)。
  - 非表示の行・列は印刷しない。

使い方:  python3 tests/fixtures/excel-print-audit/generate_print_audit_fixtures.py
出力先:  tests/fixtures/static/excel-print-audit/*.xlsx と *.expect.json
データはすべて架空。
"""
from __future__ import annotations

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "excel-chart"))
sys.dont_write_bytecode = True  # 生成のたびに __pycache__ を作らない
import generate_ooxml_chart_fixtures as g  # noqa: E402

OUT = os.path.join(HERE, "..", "static", "excel-print-audit")
EMU = 12700
MM = 72 / 25.4

# 用紙の番号 → (名前, 幅pt, 高さpt)(縦向き)
PAPERS = {
    8: ("A3", 841.89, 1190.55),
    9: ("A4", 595.28, 841.89),
    11: ("A5", 419.53, 595.28),
    12: ("B4(JIS)", 257 * MM, 364 * MM),
    13: ("B5(JIS)", 182 * MM, 257 * MM),
    88: ("B6(JIS)", 128 * MM, 182 * MM),
    1: ("レター", 612, 792),
    5: ("リーガル", 612, 1008),
    43: ("はがき", 100 * MM, 148 * MM),
    69: ("往復はがき", 200 * MM, 148 * MM),
}
DEFAULT_MARGINS = {"left": 0.7, "right": 0.7, "top": 0.75, "bottom": 0.75, "header": 0.3, "footer": 0.3}
DEFAULT_COL_PT = 54.0
DEFAULT_ROW_PT = 18.75

# 監査用の書式(cellXfs の番号)
S_GEN, S_DATE, S_YEN, S_PCT, S_TIME, S_NEGRED, S_WRAP, S_SHRINK, S_RIGHT, S_CENTER, S_INDENT, S_ROT90, S_VTOP, S_VBOTTOM, S_DATETIME = range(15)
AUDIT_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<styleSheet xmlns="{g.NS_MAIN}">'
    '<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0"/><numFmt numFmtId="167" formatCode="yyyy/m/d"/>'
    '<numFmt numFmtId="168" formatCode="#,##0;[Red]\\-#,##0"/><numFmt numFmtId="169" formatCode="yyyy/m/d h:mm"/></numFmts>'
    '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="游ゴシック"/><family val="2"/><charset val="128"/><scheme val="minor"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs>'
    '<cellXfs count="15">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>'
    '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" shrinkToFit="1"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="2"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" textRotation="90"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="bottom"/></xf>'
    '<xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="center"/></xf>'
    "</cellXfs>"
    '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0"/>'
    "</styleSheet>"
)


def col_pt(width_chars: float, mdw: int = 8) -> float:
    px = math.floor(((256 * width_chars + math.floor(128 / mdw)) / 256) * mdw)
    return px * 0.75


def cell(r: int, c: int) -> str:
    return g.cell_ref(r, c)


def parse_cell(ref: str) -> tuple[int, int]:
    letters = "".join(ch for ch in ref if ch.isalpha())
    digits = "".join(ch for ch in ref if ch.isdigit())
    c = 0
    for ch in letters:
        c = c * 26 + (ord(ch) - 64)
    return int(digits) - 1, c - 1


# ───────────────────────── ページの分け方(Excelの決まり) ─────────────────────────


def group(sizes: list[float], limit: float, breaks_after: set[int]) -> list[list[int]]:
    groups: list[list[int]] = []
    cur: list[int] = []
    total = 0.0
    for i, size in enumerate(sizes):
        if cur and total + size > limit + 1e-6:
            groups.append(cur)
            cur, total = [], 0.0
        cur.append(i)
        total += size
        if i in breaks_after and i < len(sizes) - 1:
            groups.append(cur)
            cur, total = [], 0.0
    if cur:
        groups.append(cur)
    return groups


class SheetModel:
    """1枚のシートの、印刷の期待値の計算"""

    def __init__(self, sheet: g.Sheet, prefix: str):
        self.sh = sheet
        self.prefix = prefix
        self.markers: dict[tuple[int, int], str] = {}
        self.drawings: list[tuple[str, int, int, int, int]] = []  # (色の名前, 始まりの行, 始まりの列, 終わりの行, 終わりの列) ※終わりは含まない
        self.extra_present: list[str] = []  # 印刷される(場所は問わない)文字

    def mark(self, r: int, c: int, style: int = g.ST_GENERAL) -> str:
        t = f"{self.prefix}{cell(r, c)}"
        self.sh.put(r, c, t, style)
        self.markers[(r, c)] = t
        return t

    def grid(self, rows: int, cols: int, r0: int = 0, c0: int = 0):
        for r in range(r0, r0 + rows):
            for c in range(c0, c0 + cols):
                self.mark(r, c)

    def clear_under(self, r1: int, c1: int, r2: int, c2: int):
        """グラフの下に隠れるセル(グラフの白い背景が上に描かれるので見えないのが正しい)には目印を置かない"""
        for r in range(r1, r2):
            for c in range(c1, c2):
                self.markers.pop((r, c), None)
                self.sh.cells.pop((r, c), None)

    def col_size(self, c: int) -> float:
        if c in self.sh.hidden_cols:
            return 0.0
        w = self.sh.col_widths.get(c)
        return col_pt(w) if w is not None else DEFAULT_COL_PT

    def row_size(self, r: int) -> float:
        if r in self.sh.hidden_rows:
            return 0.0
        return self.sh.row_heights.get(r, DEFAULT_ROW_PT)

    def paper(self) -> tuple[float, float]:
        _, w, h = PAPERS[self.sh.paper]
        return (h, w) if self.sh.landscape else (w, h)

    def margins(self) -> dict:
        return self.sh.margins or DEFAULT_MARGINS

    def areas(self) -> list[tuple[int, int, int, int]]:
        """(始まりの行, 始まりの列, 終わりの行, 終わりの列)(含む)"""
        used_rows = [r for r, _ in self.sh.cells] + [d[3] - 1 for d in self.drawings]
        used_cols = [c for _, c in self.sh.cells] + [d[4] - 1 for d in self.drawings]
        last_r = max(used_rows or [0])
        last_c = max(used_cols or [0])
        if not self.sh.print_area:
            return [(0, 0, last_r, last_c)]
        out = []
        for part in self.sh.print_area.split(","):
            ref = part.split("!")[-1].replace("$", "")
            a, b = ref.split(":")
            if a.isdigit():  # 行だけ($1:$20)
                out.append((int(a) - 1, 0, int(b) - 1, last_c))
            elif a.isalpha():  # 列だけ($A:$D)
                out.append((0, parse_cell(a + "1")[1], last_r, parse_cell(b + "1")[1]))
            else:
                r1, c1 = parse_cell(a)
                r2, c2 = parse_cell(b)
                out.append((r1, c1, min(r2, last_r), min(c2, last_c)))
        return out

    def title_rows(self) -> list[int]:
        if not self.sh.print_title_rows:
            return []
        a, b = self.sh.print_title_rows.replace("$", "").split(":")
        return [r for r in range(int(a) - 1, int(b)) if r not in self.sh.hidden_rows]

    def title_cols(self) -> list[int]:
        t = getattr(self.sh, "print_title_cols", None)
        if not t:
            return []
        a, b = t.replace("$", "").split(":")
        c1, c2 = parse_cell(a + "1")[1], parse_cell(b + "1")[1]
        return [c for c in range(c1, c2 + 1) if c not in self.sh.hidden_cols]

    def paginate(self, first_page_no: int):
        """出力するページの一覧と、文字ごとのページを返す"""
        pw, ph = self.paper()
        m = self.margins()
        cw = pw - (m["left"] + m["right"]) * 72
        ch = ph - (m["top"] + m["bottom"]) * 72
        # 表の本体を印刷できる枠(紙の左上が原点、pt)。中央配置でも、この枠の中に収まる
        box = [round(m["left"] * 72, 2), round(m["top"] * 72, 2), round(pw - m["right"] * 72, 2), round(ph - m["bottom"] * 72, 2)]
        titles = self.title_rows()
        tcols = self.title_cols()
        title_h = sum(self.row_size(r) for r in titles)
        title_w = sum(self.col_size(c) for c in tcols)
        pages = []
        marker_pages: dict[str, list[int]] = {}
        page_no = first_page_no
        for (r1, c1, r2, c2) in self.areas():
            rows = [r for r in range(r1, r2 + 1) if r not in self.sh.hidden_rows and r not in titles]
            cols = [c for c in range(c1, c2 + 1) if c not in self.sh.hidden_cols and c not in tcols]
            rs = [self.row_size(r) for r in rows]
            cs = [self.col_size(c) for c in cols]
            if self.sh.fit:
                fw, fh = self.sh.fit
                cands = [1.0]
                if fw > 0:
                    # 毎ページに繰り返すタイトルの列も同じ倍率で縮む：fw×(cw − title×s) ≥ Σ列×s
                    cands.append(fw * cw / (sum(cs) + fw * title_w))
                if fh > 0:
                    cands.append(fh * ch / (sum(rs) + fh * title_h))
                scale = max(0.1, min(cands))
                # Excelは列・行を途中で分けない。切れ目の都合で指定のページ数を超えるときは、収まるまで少しずつ縮小する(10%まで)
                while scale > 0.1 and (
                    (fw > 0 and len(group(cs, (cw - title_w * scale) / scale, set())) > fw)
                    or (fh > 0 and len(group(rs, (ch - title_h * scale) / scale, set())) > fh)
                ):
                    scale = max(0.1, scale - 0.0005)
                rb, cb = set(), set()
            else:
                scale = (self.sh.scale or 100) / 100
                rb = {rows.index(b - 1) for b in self.sh.row_breaks if (b - 1) in rows}
                cb = {cols.index(b - 1) for b in self.sh.col_breaks if (b - 1) in cols}
            col_groups = group(cs, (cw - title_w * scale) / scale, cb)
            row_groups = group(rs, (ch - title_h * scale) / scale, rb)
            # ページの順：既定は「下へ、次に右へ」。pageOrder="overThenDown" は「右へ、次に下へ」
            if getattr(self.sh, "page_order", None) == "overThenDown":
                order = [(cg, rg) for rg in row_groups for cg in col_groups]
            else:
                order = [(cg, rg) for cg in col_groups for rg in row_groups]
            for cg, rg in order:
                pcols = {cols[i] for i in cg}
                prows = {rows[i] for i in rg}
                content = [t for (r, c), t in self.markers.items() if r in prows and c in pcols]
                draws = [d for d in self.drawings if any(r in prows for r in range(d[1], d[3])) and any(c in pcols for c in range(d[2], d[4]))]
                if not content and not draws:
                    continue
                for t in content:
                    marker_pages.setdefault(t, []).append(page_no)
                # 印刷タイトル(行・列・その交わり)は毎ページに繰り返す
                for (r, c), t in self.markers.items():
                    if (r in titles and (c in pcols or c in tcols)) or (c in tcols and r in prows):
                        marker_pages.setdefault(t, []).append(page_no)
                pages.append({"pageNo": page_no, "width": round(pw, 2), "height": round(ph, 2), "scale": round(scale, 4), "drawings": [d[0] for d in draws], "box": box})
                page_no += 1
        printed = set(marker_pages)
        absent = sorted(t for t in self.markers.values() if t not in printed)
        return pages, marker_pages, absent


class Case:
    def __init__(self, name: str, title: str):
        self.name = name
        self.title = title
        self.book = g.Book()
        self.book.styles_xml = AUDIT_STYLES
        self.models: list[SheetModel] = []
        self.extra: dict = {}

    def sheet(self, name: str, prefix: str = "@") -> SheetModel:
        model = SheetModel(self.book.sheet(name), prefix)
        self.models.append(model)
        return model

    def save(self, selected: list[str] | None = None):
        path = os.path.join(OUT, f"{self.name}.xlsx")
        self.book.save(path)
        problems = g.validate(path)
        all_pages = []
        marker_pages: dict[str, list[int]] = {}
        absent: list[str] = []
        page_no = 1
        for m in self.models:
            if (selected is not None and m.sh.name not in selected) or (selected is None and m.sh.state != "visible"):
                absent += sorted(m.markers.values())
                continue
            if not m.sh.cells and not m.drawings:
                continue
            pages, mp, ab = m.paginate(page_no)
            for p in pages:
                p["sheet"] = m.sh.name
            all_pages += pages
            marker_pages.update(mp)
            absent += ab
            page_no += len(pages)
        expect = {
            "title": self.title,
            "pages": all_pages,
            "markers": marker_pages,
            "absent": absent,
            **self.extra,
        }
        with open(os.path.join(OUT, f"{self.name}.expect.json"), "w", encoding="utf-8") as f:
            json.dump(expect, f, ensure_ascii=False, indent=1)
        return problems


# ───────────────────────── 監査ケース ─────────────────────────


def case_a01():
    """用紙の大きさ(10種類)×縦向き：A3・A4・A5・B4・B5・B6(JIS)・レター・リーガル・はがき・往復はがき"""
    c = Case("a01-paper-portrait", "用紙の大きさ(縦)")
    for i, code in enumerate(PAPERS):
        m = c.sheet(f"用紙{code}", prefix=f"S{i + 1}@")
        m.sh.paper = code
        m.grid(5, 3)
    return c


def case_a02():
    """用紙の大きさ(10種類)×横向き"""
    c = Case("a02-paper-landscape", "用紙の大きさ(横)")
    for i, code in enumerate(PAPERS):
        m = c.sheet(f"用紙{code}", prefix=f"S{i + 1}@")
        m.sh.paper = code
        m.sh.landscape = True
        m.grid(5, 3)
    return c


def case_a03():
    """印刷範囲 A1:J50(データは A1:L60)。範囲の最終行・最終列(J50)を含み、範囲の外(K列〜・51行目〜)は出さない"""
    c = Case("a03-print-area-basic", "印刷範囲の基本")
    m = c.sheet("Sheet1")
    m.grid(60, 12)
    m.sh.print_area = "Sheet1!$A$1:$J$50"
    return c


def case_a04():
    """印刷範囲が2つ(A1:C10 と E15:H30)：範囲ごとに新しいページ。間のセルは出さない"""
    c = Case("a04-print-area-multi", "印刷範囲が複数")
    m = c.sheet("Sheet1")
    m.grid(35, 10)
    m.sh.print_area = "Sheet1!$A$1:$C$10,Sheet1!$E$15:$H$30"
    return c


def case_a05():
    """印刷範囲なし：データ(A1:M70)の全体を印刷する"""
    c = Case("a05-no-print-area", "印刷範囲なし")
    m = c.sheet("Sheet1")
    m.grid(70, 13)
    return c


def case_a06():
    """印刷範囲が列だけ($A:$D)・行だけ($1:$20)の指定(Excelで列・行を選んで設定したとき)"""
    c = Case("a06-print-area-cols-rows", "列だけ・行だけの印刷範囲")
    m1 = c.sheet("列だけ", prefix="S1@")
    m1.grid(50, 8)
    m1.sh.print_area = "列だけ!$A:$D"
    m2 = c.sheet("行だけ", prefix="S2@")
    m2.grid(50, 8)
    m2.sh.print_area = "行だけ!$1:$20"
    return c


def case_a07():
    """印刷範囲が名前の付いたシート(空白・記号を含むシート名、'で囲む)と、データより広い印刷範囲(A1:Z200、データは A1:E20)"""
    c = Case("a07-print-area-quoted-wide", "シート名の引用符・データより広い印刷範囲")
    m1 = c.sheet("売上 2026(上期)", prefix="S1@")
    m1.grid(30, 6)
    m1.sh.print_area = "'売上 2026(上期)'!$B$2:$E$25"
    m2 = c.sheet("広い範囲", prefix="S2@")
    m2.grid(20, 5)
    m2.sh.print_area = "広い範囲!$A$1:$Z$200"
    return c


def case_a08():
    """横1×縦1ページに収める：A4・印刷範囲 A1:J50 が1ページに入る"""
    c = Case("a08-fit-1x1", "横1×縦1ページ")
    m = c.sheet("Sheet1")
    m.grid(60, 12)
    m.sh.print_area = "Sheet1!$A$1:$J$50"
    m.sh.fit = (1, 1)
    return c


def case_a09():
    """横1×縦自動：幅だけ1ページに合わせ、縦は内容に応じて複数ページ(20列×120行)"""
    c = Case("a09-fit-1xauto", "横1×縦自動")
    m = c.sheet("Sheet1")
    m.grid(120, 20)
    m.sh.fit = (1, 0)
    return c


def case_a10():
    """横自動×縦1：高さだけ1ページに合わせる(12列×200行)"""
    c = Case("a10-fit-autox1", "横自動×縦1")
    m = c.sheet("Sheet1")
    m.grid(200, 12)
    m.sh.fit = (0, 1)
    return c


def case_a11():
    """横2×縦2ページに収める(25列×100行)"""
    c = Case("a11-fit-2x2", "横2×縦2")
    m = c.sheet("Sheet1")
    m.grid(100, 25)
    m.sh.fit = (2, 2)
    return c


def case_a12():
    """FitToPageが無効(fitToWidth/Height=1 は書いてあるが、sheetPr の fitToPage が無い)：拡大縮小率(100%)を使う"""
    c = Case("a12-fit-flag-off", "FitToPage無効")
    m = c.sheet("Sheet1")
    m.grid(50, 12)
    m.sh.fit_attrs_without_flag = (1, 1)
    return c


def case_a13():
    """拡大縮小率 50%・75%・100%・125%・200%(シートごと。同じ 16列×90行)"""
    c = Case("a13-scales", "拡大縮小率")
    for i, sc in enumerate([50, 75, 100, 125, 200]):
        m = c.sheet(f"{sc}%", prefix=f"S{i + 1}@")
        m.grid(90, 16)
        m.sh.scale = sc
    return c


def case_a14():
    """余白(左1・右0.5・上1.2・下0.4インチ)と、水平・垂直の中央配置(表は 4列×10行)"""
    c = Case("a14-margins-center", "余白・中央配置")
    m = c.sheet("中央", prefix="S1@")
    m.grid(10, 4)
    m.sh.margins = {"left": 1.0, "right": 0.5, "top": 1.2, "bottom": 0.4, "header": 0.5, "footer": 0.2}
    m.sh.h_center = True
    m.sh.v_center = True
    m2 = c.sheet("余白だけ", prefix="S2@")
    m2.grid(60, 12)
    m2.sh.margins = {"left": 1.0, "right": 0.5, "top": 1.2, "bottom": 0.4, "header": 0.5, "footer": 0.2}
    # 期待：中央配置のシートの A1 の左上(シートの座標で(0,0))が、紙の上のどこに来るか
    pw, ph = 595.28, 841.89
    mm = m.sh.margins
    cw = pw - (mm["left"] + mm["right"]) * 72
    chh = ph - (mm["top"] + mm["bottom"]) * 72
    c.extra["origin"] = {
        "S1@A1": {"page": 1, "x": mm["left"] * 72 + (cw - 4 * DEFAULT_COL_PT) / 2, "y": mm["top"] * 72 + (chh - 10 * DEFAULT_ROW_PT) / 2},
        "S2@A1": {"page": 2, "x": mm["left"] * 72, "y": mm["top"] * 72},
    }
    return c


def case_a15():
    """手動の改ページ：行(10行目・25行目の下)と列(E列の右)。2枚目のシートは同じ改ページ＋拡大縮小75%"""
    c = Case("a15-manual-breaks", "手動の改ページ")
    m = c.sheet("100%", prefix="S1@")
    m.grid(40, 12)
    m.sh.row_breaks = [10, 25]
    m.sh.col_breaks = [5]
    m2 = c.sheet("75%", prefix="S2@")
    m2.grid(40, 12)
    m2.sh.row_breaks = [10, 25]
    m2.sh.col_breaks = [5]
    m2.sh.scale = 75
    return c


def case_a16():
    """自動の改ページ：100行×12列(39行目と40行目、I列とJ列の間で分かれる)"""
    c = Case("a16-auto-breaks", "自動の改ページ")
    m = c.sheet("Sheet1")
    m.grid(100, 12)
    return c


def case_a17():
    """複数シート：A4縦(範囲なし)・B5横(印刷範囲)・A3(横1×縦1)・非表示のシート・レター(手動の改ページ)・空のシート"""
    c = Case("a17-multi-sheet", "複数シート")
    m1 = c.sheet("A4縦", prefix="S1@")
    m1.grid(45, 10)
    m2 = c.sheet("B5横", prefix="S2@")
    m2.grid(30, 14)
    m2.sh.paper = 13
    m2.sh.landscape = True
    m2.sh.print_area = "B5横!$B$2:$K$20"
    m3 = c.sheet("A3収める", prefix="S3@")
    m3.grid(80, 20)
    m3.sh.paper = 8
    m3.sh.fit = (1, 1)
    m4 = c.sheet("非表示", prefix="S4@")
    m4.grid(10, 4)
    m4.sh.state = "hidden"
    m5 = c.sheet("レター", prefix="S5@")
    m5.grid(30, 6)
    m5.sh.paper = 1
    m5.sh.row_breaks = [12]
    c.sheet("空", prefix="S6@")
    return c


def case_a18():
    """非表示の行(5〜9行目)・列(C列)：非表示のセルは出さず、ページの境目はその分ずれる(60行×12列)"""
    c = Case("a18-hidden-rows-cols", "非表示の行・列")
    m = c.sheet("Sheet1")
    m.grid(60, 12)
    for r in range(4, 9):
        m.sh.hidden_rows.add(r)
    m.sh.hidden_cols = {2}
    return c


def case_a19():
    """結合セル：A1:D3、ページの境目(39〜41行目)をまたぐ結合、列の境目(I〜J列)をまたぐ結合"""
    c = Case("a19-merged", "結合セル")
    m = c.sheet("Sheet1")
    for r in range(50):
        for col in range(12):
            if (r < 3 and col < 4) or (37 <= r <= 40 and col == 1) or (r == 15 and 8 <= col <= 9):
                continue
            m.mark(r, col)
    m.mark(0, 0)
    m.mark(37, 1)
    m.mark(15, 8)
    m.sh.merges = ["A1:D3", "B38:B41", "I16:J16"]
    # 結合の中の左上以外のセルは空なので、期待値の上でも「無いもの」(markers に入れない)
    return c


def case_a20():
    """セルの内容と表示形式：日本語の長文(折り返し)・縮小して全体を表示・右/中央/字下げ・縦の文字・上/下揃え・日付・時刻・日時・通貨・%・負の数(赤)・0・空・数式の結果・真偽値"""
    c = Case("a20-cell-formats", "セルの内容と表示形式")
    m = c.sheet("Sheet1")
    sh = m.sh
    sh.col_widths = {0: 14, 1: 30}
    sh.row_heights = {1: 60, 3: 70, 9: 40, 10: 40}
    items = [
        ("見出し", "値", g.ST_GENERAL, None),
        ("長文(折り返し)", "これはセルの中で折り返して表示する長い日本語の文章です。最後まで欠けずに印刷されること。", S_WRAP, None),
        ("縮小して表示", "とても長い文字列を縮小して1行に収めるセル", S_SHRINK, None),
        ("縦の文字", "縦書き", S_ROT90, None),
        ("右揃え", "右寄せの文字", S_RIGHT, None),
        ("中央揃え", "中央の文字", S_CENTER, None),
        ("字下げ", "字下げの文字", S_INDENT, None),
        ("上揃え", "上の文字", S_VTOP, None),
        ("下揃え", "下の文字", S_VBOTTOM, None),
        ("日付", g.date_serial(2026, 4, 1), S_DATE, "2026/4/1"),
        ("時刻", 0.395833333333333, S_TIME, "9:30"),
        ("日時", g.date_serial(2026, 4, 1) + 0.395833333333333, S_DATETIME, "2026/4/1 9:30"),
        ("通貨", 1234567, S_YEN, "¥1,234,567"),
        ("パーセント", 0.125, S_PCT, "13%"),
        ("負の数", -9876, S_NEGRED, "-9,876"),
        ("ゼロ", 0, g.ST_GENERAL, "0"),
        ("空の文字", "", g.ST_GENERAL, None),
        ("数式(数値)", g.F("100*3", 300), g.ST_GENERAL, "300"),
        ("数式(文字)", g.F('"合"&"計"', "合計"), g.ST_GENERAL, "合計"),
        ("記号", "①②③※〒〜♪", g.ST_GENERAL, None),
        ("英数字", "ABCxyz-0123_!?", g.ST_GENERAL, None),
    ]
    present = []
    for i, (label, value, style, shown) in enumerate(items):
        m.mark(i, 2)  # 行ごとの目印(C列)
        sh.put(i, 0, label)
        if value != "":
            sh.put(i, 1, value, style)
        if shown is not None:
            present.append(shown)
        elif isinstance(value, str) and value:
            present.append(value)
    c.extra["texts"] = present + [label for label, *_ in items]
    return c


def case_a21():
    """画像：範囲の中・ページの境目(36〜42行目)をまたぐ・印刷範囲の外(出さない)"""
    c = Case("a21-images", "画像")
    m = c.sheet("Sheet1")
    m.grid(60, 8)
    m.sh.print_area = "Sheet1!$A$1:$H$60"
    m.sh.picture(g.two_cell(1, 2, 3, 6, edit_as="oneCell"), g.png_bytes(60, 40, (112, 48, 160)))
    m.drawings.append(("purple", 2, 1, 6, 3))
    m.sh.picture(g.two_cell(4, 35, 7, 42, edit_as="oneCell"), g.png_bytes(60, 40, (0, 176, 80)))
    m.drawings.append(("green", 35, 4, 42, 7))
    m.sh.picture(g.two_cell(10, 2, 12, 6, edit_as="oneCell"), g.png_bytes(60, 40, (255, 128, 0)))  # 範囲の外
    c.extra["colors"] = {"purple": [112, 48, 160], "green": [0, 176, 80], "orange": [255, 128, 0]}
    c.extra["colorAbsent"] = ["orange"]
    return c


def colored_chart(sheet: str, title: str, rgb: str) -> str:
    vals = [120, 180, 150, 210]
    sers = [g.ser("bar", 0, g.abs_range(sheet, 0, 1, 0, 1), "売上", g.abs_range(sheet, 1, 0, 4, 0), ["1月", "2月", "3月", "4月"], g.abs_range(sheet, 1, 1, 4, 1), vals, sppr=g.sppr_fill(g.solid(srgb=rgb)))]
    plot = g.bar_group(sers) + g.cat_ax(500001, 500002) + g.val_ax(500002, 500001, min_=0, max_=250, major=50)
    return g.chart_space(plot, title=g.rich_title(title, sz=1200))


def case_a22():
    """グラフ：範囲の中・ページの境目をまたぐ・印刷範囲の外(出さない)。タイトルの文字も確かめる"""
    c = Case("a22-charts", "グラフ")
    m = c.sheet("Sheet1")
    m.grid(60, 8)
    m.sh.print_area = "Sheet1!$A$1:$H$60"
    m.sh.chart(g.two_cell(2, 5, 7, 18), colored_chart("Sheet1", "範囲の中のグラフ", "0070C0"))
    m.drawings.append(("blue", 5, 2, 18, 7))
    m.sh.chart(g.two_cell(1, 30, 6, 48), colored_chart("Sheet1", "境目をまたぐグラフ", "00B050"))
    m.drawings.append(("green", 30, 1, 48, 6))
    m.sh.chart(g.two_cell(10, 2, 15, 15), colored_chart("Sheet1", "範囲の外のグラフ", "FF0000"))
    for (_, r1, c1, r2, c2) in m.drawings:
        m.clear_under(r1, c1, r2, c2)
    c.extra["colors"] = {"blue": [0, 112, 192], "green": [0, 176, 80], "red": [255, 0, 0]}
    c.extra["colorAbsent"] = ["red"]
    c.extra["texts"] = ["範囲の中のグラフ", "境目をまたぐグラフ"]
    c.extra["textsAbsent"] = ["範囲の外のグラフ"]
    return c


def case_a23():
    """ページの境目の行：境目の直前(39行目)・直後(40行目)、境目にかかる高い行(38行目を高さ60pt)は丸ごと次のページへ"""
    c = Case("a23-boundary-rows", "ページの境目の行")
    m = c.sheet("Sheet1")
    m.grid(80, 6)
    m.sh.row_heights = {37: 60}
    return c


def case_a24():
    """ヘッダー・フッター：&P/&N(ページ番号/総ページ数)・シート名・ファイル名・左右中央"""
    c = Case("a24-header-footer", "ヘッダー・フッター")
    m = c.sheet("報告書")
    m.grid(100, 6)
    m.sh.header = "&L左のヘッダー&C&P / &N&R&A"
    m.sh.footer = "&C&F &Pページ"
    c.extra["texts"] = ["左のヘッダー", "1 / 3", "2 / 3", "3 / 3", "報告書", "a24-header-footer.xlsx 1ページ"]
    return c


def case_a25():
    """印刷タイトル(1行目を毎ページの上に繰り返す)：100行×6列"""
    c = Case("a25-print-titles", "印刷タイトル")
    m = c.sheet("Sheet1")
    m.grid(100, 6)
    m.sh.print_title_rows = "$1:$1"
    return c


def case_a26():
    """印刷範囲の最終列の長い文字：範囲の外(F列)へはみ出す部分は出さない。範囲の最終行・最終列の目印は出す"""
    c = Case("a26-last-col-overflow", "最終列のはみ出し")
    m = c.sheet("Sheet1")
    m.grid(10, 5)
    m.sh.put(4, 4, "@E5 はみ出す長い文字列はみ出す長い文字列はみ出す")
    m.markers[(4, 4)] = "@E5"
    m.sh.put(2, 7, "@H3範囲外")
    m.markers[(2, 7)] = "@H3範囲外"
    m.sh.print_area = "Sheet1!$A$1:$E$10"
    c.extra["rightLimitCol"] = 5  # この列(F列)の左端より右に、文字の画素が無いこと
    return c


def case_a27():
    """異常系：余白の要素が無い(Excelの標準の余白で印刷)・対応していない用紙番号(A4で出力)・拡大縮小5%(10%に)・fitToWidth/Heightが両方0(制限なし)"""
    c = Case("a27-abnormal-settings", "異常な印刷設定")
    m1 = c.sheet("余白なし", prefix="S1@")
    m1.grid(50, 10)
    m1.sh.no_margins = True
    m2 = c.sheet("用紙番号256", prefix="S2@")
    m2.grid(10, 3)
    m2.sh.paper = 9  # 期待値の計算はA4(下でXMLの用紙番号だけ256にする)
    m3 = c.sheet("5%", prefix="S3@")
    m3.grid(30, 30)
    m3.sh.scale = 10  # 期待値は10%で計算(XMLには5を書く)
    m4 = c.sheet("自動×自動", prefix="S4@")
    m4.grid(50, 12)
    m4.sh.fit = (0, 0)
    c.extra["patch"] = {"用紙番号256": {"paperSize": 256}, "5%": {"scale": 5}}
    c.extra["warningsContain"] = ["用紙番号256"]
    return c


def case_a28():
    """組み合わせ：B4横・横1ページ・印刷範囲(非表示の列を含む)・結合・画像・グラフ・ヘッダー/フッター・印刷タイトル"""
    c = Case("a28-combination", "組み合わせ")
    m = c.sheet("集計表")
    for r in range(120):
        for col in range(26):
            if r == 0 and 1 <= col <= 3:
                continue
            m.mark(r, col)
    m.mark(0, 0)
    m.sh.merges = ["A1:D1"]
    m.sh.paper = 12
    m.sh.landscape = True
    m.sh.fit = (1, 0)
    m.sh.print_area = "集計表!$A$1:$X$110"
    m.sh.hidden_cols = {5}
    m.sh.print_title_rows = "$1:$1"
    m.sh.header = "&C集計表 &P/&N"
    m.sh.picture(g.two_cell(8, 3, 10, 8, edit_as="oneCell"), g.png_bytes(60, 40, (112, 48, 160)))
    m.drawings.append(("purple", 3, 8, 8, 10))
    m.sh.chart(g.two_cell(12, 40, 20, 60), colored_chart("集計表", "組み合わせのグラフ", "00B050"))
    m.drawings.append(("green", 40, 12, 60, 20))
    m.clear_under(40, 12, 60, 20)
    c.extra["colors"] = {"purple": [112, 48, 160], "green": [0, 176, 80]}
    c.extra["texts"] = ["集計表 1/", "組み合わせのグラフ"]
    return c


CASES = [case_a01, case_a02, case_a03, case_a04, case_a05, case_a06, case_a07, case_a08, case_a09, case_a10, case_a11, case_a12, case_a13, case_a14,
         case_a15, case_a16, case_a17, case_a18, case_a19, case_a20, case_a21, case_a22, case_a23, case_a24, case_a25, case_a26, case_a27, case_a28]


def patch_xml(path: str, patches: dict, book: g.Book):
    """保存したxlsxの一部のシートの pageSetup の属性を書き換える(期待値と別の値をわざと書く異常系)"""
    import re
    import zipfile

    names = [sh.name for sh in book.sheets]
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    for sheet_name, attrs in patches.items():
        idx = names.index(sheet_name) + 1
        key = f"xl/worksheets/sheet{idx}.xml"
        xml = files[key].decode("utf-8")
        for a, v in attrs.items():
            xml, n = re.subn(rf'(<pageSetup\b[^>]*\b{a}=")[^"]*(")', rf"\g<1>{v}\g<2>", xml)
            if n == 0:
                xml = xml.replace("<pageSetup ", f'<pageSetup {a}="{v}" ', 1)
        files[key] = xml.encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items():
            zi = zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)


def main():
    os.makedirs(OUT, exist_ok=True)
    bad = 0
    for fn in CASES:
        g._uid[0] = 0
        c = fn()
        problems = c.save()
        if "patch" in c.extra:
            patch_xml(os.path.join(OUT, f"{c.name}.xlsx"), c.extra["patch"], c.book)
            problems += g.validate(os.path.join(OUT, f"{c.name}.xlsx"))
        print(f"{c.name}.xlsx  {'OK' if not problems else '問題あり'}")
        for p in problems:
            print("   -", p)
        bad += len(problems)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
