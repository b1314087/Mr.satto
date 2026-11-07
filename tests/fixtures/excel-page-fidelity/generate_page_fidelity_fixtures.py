#!/usr/bin/env python3
"""
Excel→PDF「ページ単位の再現性」の検証用Excel(OOXMLを直接作る)と、その期待値(JSON)を作る。

前回の印刷監査(tests/fixtures/excel-print-audit/)の仕組み(Case・SheetModel・ページの分け方の計算)をそのまま使い、
「Officeで印刷したときのページ構成・ページの境目と一致するか」の観点で、境目ちょうどの表・結合セルや画像が
境目をまたぐ表・印刷タイトル(行と列)・ページの順(右へ、次に下へ)・先頭ページの番号・シートごとに違う印刷設定などを足す。

期待値は、Excelの印刷の決まりに沿って、このファイル(と監査の生成スクリプト)の中で計算する。
Mr.Satto(TypeScript)の計算とは別に作った計算なので、両者が食い違えば、どちらかの解釈の誤りが見つかる。
LibreOfficeとの比較は compare_with_libreoffice.py(テストとは別に、手元で実行する)。

使い方:  python3 tests/fixtures/excel-page-fidelity/generate_page_fidelity_fixtures.py
出力先:  tests/fixtures/static/excel-page-fidelity/*.xlsx と *.expect.json
データはすべて架空。
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # 生成のたびに __pycache__ を作らない
sys.path.insert(0, os.path.join(HERE, "..", "excel-print-audit"))
import generate_print_audit_fixtures as a  # noqa: E402

g = a.g
a.OUT = os.path.join(HERE, "..", "static", "excel-page-fidelity")
Case = a.Case


def cover(m: a.SheetModel, x0: float, y0: float, w: float, h: float) -> tuple[int, int, int, int]:
    """シートの座標(pt)の四角がかかるセルの範囲 (始まりの行, 始まりの列, 終わりの行, 終わりの列)(終わりは含まない)"""

    def span(start: float, length: float, size) -> tuple[int, int]:
        pos, i = 0.0, 0
        while pos + size(i) <= start + 1e-6:
            pos += size(i)
            i += 1
        first = i
        while pos < start + length - 1e-6:
            pos += size(i)
            i += 1
        return first, i

    r1, r2 = span(y0, h, m.row_size)
    c1, c2 = span(x0, w, m.col_size)
    return r1, c1, r2, c2


# ───────────────────────── ページの構成 ─────────────────────────


def case_f01():
    """1ページにちょうど収まる表：A4縦・標準の余白で39行×9列(印刷できる高さ733.9ptに18.75pt×39=731.25pt)"""
    c = Case("f01-one-page-exact", "1ページちょうどの表")
    c.sheet("Sheet1").grid(39, 9)
    return c


def case_f02():
    """正確に2ページになる縦方向の表：78行×9列(39行ずつ)"""
    c = Case("f02-two-pages-vertical", "縦に2ページちょうど")
    c.sheet("Sheet1").grid(78, 9)
    return c


def case_f03():
    """正確に2ページになる横方向の表：39行×18列(9列ずつ)"""
    c = Case("f03-two-pages-horizontal", "横に2ページちょうど")
    c.sheet("Sheet1").grid(39, 18)
    return c


def case_f04():
    """縦横それぞれ複数ページ：120行×30列、列の幅(8/10/14文字)と行の高さ(15/18.75/30pt)をばらばらにする"""
    c = Case("f04-multi-both", "縦横に複数ページ")
    m = c.sheet("Sheet1")
    m.grid(120, 30)
    m.sh.col_widths = {i: (8, 10, 14)[i % 3] for i in range(30)}
    m.sh.row_heights = {i: (15, 18.75, 30)[i % 3] for i in range(120) if i % 3 != 1}
    return c


def case_f05():
    """手動の改ページ(行2か所・列2か所)と、表より後ろの改ページ(使われない)"""
    c = Case("f05-manual-breaks-mixed", "手動の改ページ(行と列)")
    m = c.sheet("Sheet1")
    m.grid(90, 20)
    m.sh.row_breaks = [20, 55, 200]
    m.sh.col_breaks = [5, 13]
    return c


def case_f06():
    """印刷範囲(表の途中 B5:M70)だけを印刷する"""
    c = Case("f06-print-area-mid", "表の途中の印刷範囲")
    m = c.sheet("Sheet1")
    m.grid(100, 20)
    m.sh.print_area = "Sheet1!$B$5:$M$70"
    return c


def case_f07():
    """印刷範囲(A1:H30)の外に大量のデータ(400行×26列)がある：範囲の外は1文字も出さない"""
    c = Case("f07-huge-outside", "印刷範囲の外に大量のデータ")
    m = c.sheet("Sheet1")
    m.grid(400, 26)
    m.sh.print_area = "Sheet1!$A$1:$H$30"
    return c


# ───────────────────────── ページの境目 ─────────────────────────


def case_f08():
    """結合セルがページの境目をまたぐ：縦(C37:C42 が39行目と40行目の境目)・横(H10:K10 が9列目と10列目の境目)・大きな結合(A50:D55)"""
    c = Case("f08-merged-boundary", "境目をまたぐ結合セル")
    m = c.sheet("Sheet1")
    m.grid(80, 12)
    merges = [(36, 2, 41, 2), (9, 7, 9, 10), (49, 0, 54, 3)]
    for r1, c1, r2, c2 in merges:
        for r in range(r1, r2 + 1):
            for cc in range(c1, c2 + 1):
                if (r, cc) != (r1, c1):
                    m.markers.pop((r, cc), None)
                    m.sh.cells.pop((r, cc), None)
        m.sh.styles[(r1, c1)] = a.S_VTOP  # 文字は結合範囲の上に置く(始まりのセルのページに出る)
    m.sh.merges = [f"{a.cell(r1, c1)}:{a.cell(r2, c2)}" for r1, c1, r2, c2 in merges]
    return c


def case_f09():
    """長い文章の折り返し：B列(40文字幅)に3〜4行に折り返す文章、行の高さはExcelが保存する値(75pt)。境目で行が分かれないこと"""
    c = Case("f09-wrap-long-text", "長文の折り返し")
    m = c.sheet("Sheet1")
    m.sh.col_widths = {1: 40}
    sentence = "は、セルの中で折り返して表示する長い日本語の文章です。ページの境目でも、行の途中で切れずに次のページへ送られます。"
    for r in range(30):
        m.mark(r, 0)
        t = f"@B{r + 1} {sentence}"
        m.sh.put(r, 1, t, a.S_WRAP)
        m.markers[(r, 1)] = f"@B{r + 1}"
        m.mark(r, 2)
        m.sh.row_heights[r] = 75
    c.extra["texts"] = [sentence]
    # 標準のスタイル(0番、sの無いセル)は「上下中央揃え」：75ptの行の@A1は行の中ほど(上から約30pt)に描かれる
    c.extra["origin"] = {"@A1": {"page": 1, "x": 50.4, "y": 54 + 26}}
    return c


def case_f10():
    """画像：1つのセル基準(大きさ指定)・絶対位置・2つのセル基準で列の境目(9列目と10列目)をまたぐ"""
    c = Case("f10-images-various", "画像の置き方")
    m = c.sheet("Sheet1")
    m.grid(60, 14)
    m.sh.picture(g.one_cell(1, 2, 90, 50), g.png_bytes(60, 40, (112, 48, 160)))
    m.drawings.append(("purple", *cover(m, 54, 2 * 18.75, 90, 50)))
    m.sh.picture(g.absolute(54 * 2, 18.75 * 45, 80, 40), g.png_bytes(60, 40, (255, 128, 0)))
    m.drawings.append(("orange", *cover(m, 108, 18.75 * 45, 80, 40)))
    m.sh.picture(g.two_cell(7, 20, 11, 26, edit_as="oneCell"), g.png_bytes(80, 40, (0, 176, 80)))
    m.drawings.append(("green", 20, 7, 26, 11))
    # 画像の下に隠れるセル(画像が上に描かれるので見えないのが正しい)には目印を置かない
    for d in m.drawings:
        m.clear_under(d[1], d[2], d[3], d[4])
    c.extra["colors"] = {"purple": [112, 48, 160], "orange": [255, 128, 0], "green": [0, 176, 80]}
    return c


def case_f11():
    """グラフ：2×2ページの表に3つ(1ページ目の中・縦の境目をまたぐ・4ページ目の中)"""
    c = Case("f11-charts-multi", "複数のグラフ")
    m = c.sheet("Sheet1")
    m.grid(70, 16)
    m.sh.chart(g.two_cell(1, 3, 6, 15), a.colored_chart("Sheet1", "1ページ目のグラフ", "0070C0"))
    m.drawings.append(("blue", 3, 1, 15, 6))
    m.sh.chart(g.two_cell(2, 30, 7, 48), a.colored_chart("Sheet1", "境目のグラフ", "00B050"))
    m.drawings.append(("green", 30, 2, 48, 7))
    m.sh.chart(g.two_cell(10, 45, 15, 60), a.colored_chart("Sheet1", "4ページ目のグラフ", "C00000"))
    m.drawings.append(("red", 45, 10, 60, 15))
    for d in m.drawings:
        m.clear_under(d[1], d[2], d[3], d[4])
    c.extra["colors"] = {"blue": [0, 112, 192], "green": [0, 176, 80], "red": [192, 0, 0]}
    c.extra["texts"] = ["1ページ目のグラフ", "境目のグラフ", "4ページ目のグラフ"]
    return c


def case_f12():
    """ヘッダー・フッター：先頭ページだけ別(differentFirst)。先頭ページは firstHeader だけ(firstFooter が無いので、フッターは出ない)"""
    c = Case("f12-header-first-page", "先頭ページだけ別のヘッダー")
    m = c.sheet("報告")
    m.grid(100, 6)
    m.sh.header = "&C本文 &P/&N"
    m.sh.first_header = "&C表紙のヘッダー"
    m.sh.footer = "&Rフッター&P"
    c.extra["texts"] = ["表紙のヘッダー", "本文2/3", "本文3/3", "フッター2", "フッター3"]
    c.extra["textsAbsent"] = ["本文1/3", "フッター1"]
    return c


# ───────────────────────── 複数シート・シートごとの設定 ─────────────────────────


def case_f13():
    """複数シート：表が2ページ・1ページ・非表示のシート・3ページ。ページ番号はシートの順に通し"""
    c = Case("f13-multi-sheet-book", "複数シートのブック")
    c.sheet("売上", prefix="S1@").grid(60, 8)
    c.sheet("一覧", prefix="S2@").grid(20, 5)
    hidden = c.sheet("控え", prefix="S3@")
    hidden.grid(10, 3)
    hidden.sh.state = "hidden"
    c.sheet("明細", prefix="S4@").grid(100, 9)
    return c


def case_f14():
    """シートごとに違う印刷設定：A4縦100%・A3横で1×1ページ・レター70%・B5で広い余白と中央配置"""
    c = Case("f14-per-sheet-settings", "シートごとの印刷設定")
    s1 = c.sheet("A4縦", prefix="S1@")
    s1.grid(50, 10)
    s2 = c.sheet("A3横", prefix="S2@")
    s2.grid(80, 30)
    s2.sh.paper = 8
    s2.sh.landscape = True
    s2.sh.fit = (1, 1)
    s3 = c.sheet("レター", prefix="S3@")
    s3.grid(90, 14)
    s3.sh.paper = 1
    s3.sh.scale = 70
    s4 = c.sheet("B5", prefix="S4@")
    s4.grid(30, 5)
    s4.sh.paper = 13
    s4.sh.margins = {"left": 1.2, "right": 1.2, "top": 1.4, "bottom": 1.4, "header": 0.5, "footer": 0.5}
    s4.sh.h_center = True
    return c


def case_f15():
    """非表示の行・列がページの境目にある：39〜41行目と9列目(I列)を非表示。境目は表示されている行・列で決まる"""
    c = Case("f15-hidden-at-boundary", "境目の非表示の行・列")
    m = c.sheet("Sheet1")
    m.grid(90, 20)
    m.sh.hidden_rows = {38, 39, 40}
    m.sh.hidden_cols = {8}
    return c


def case_f16():
    """印刷タイトル(行 $1:$2 と列 $A:$A)を、縦横に分かれるすべてのページに繰り返す"""
    c = Case("f16-titles-rows-cols", "印刷タイトル(行と列)")
    m = c.sheet("Sheet1")
    m.grid(100, 25)
    m.sh.print_title_rows = "$1:$2"
    m.sh.print_title_cols = "$A:$A"
    return c


def case_f17():
    """用紙と余白：リーガル横・狭い余白(0.25インチ)と、A5縦・広い余白(1.5インチ)"""
    c = Case("f17-paper-margins", "用紙と余白の変更")
    s1 = c.sheet("リーガル横", prefix="S1@")
    s1.grid(60, 20)
    s1.sh.paper = 5
    s1.sh.landscape = True
    s1.sh.margins = {"left": 0.25, "right": 0.25, "top": 0.25, "bottom": 0.25, "header": 0.1, "footer": 0.1}
    s2 = c.sheet("A5広い余白", prefix="S2@")
    s2.grid(40, 6)
    s2.sh.paper = 11
    s2.sh.margins = {"left": 1.5, "right": 1.5, "top": 1.5, "bottom": 1.5, "header": 0.5, "footer": 0.5}
    return c


def case_f18():
    """ページに収める設定：横1×縦2(3ページ分を縮小)・横2×縦1(横長を縮小)・横1×縦1(小さい表は拡大しない)"""
    c = Case("f18-fit-variants", "ページ数に合わせる設定")
    s1 = c.sheet("縦2", prefix="S1@")
    s1.grid(110, 9)
    s1.sh.fit = (1, 2)
    s2 = c.sheet("横2", prefix="S2@")
    s2.grid(30, 30)
    s2.sh.fit = (2, 1)
    s3 = c.sheet("小さい表", prefix="S3@")
    s3.grid(5, 3)
    s3.sh.fit = (1, 1)
    return c


def case_f19():
    """ページの順「右へ、次に下へ」(pageOrder=overThenDown)：80行×20列 = 横3×縦3ページの順番"""
    c = Case("f19-page-order-over", "ページの順(右へ、次に下へ)")
    m = c.sheet("Sheet1")
    m.grid(80, 20)
    m.sh.page_order = "overThenDown"
    return c


def case_f20():
    """先頭ページの番号(5から)：ヘッダーの「第&Pページ」が 第5ページ・第6ページ になる"""
    c = Case("f20-first-page-number", "先頭ページの番号")
    m = c.sheet("Sheet1")
    m.grid(70, 6)
    m.sh.first_page_number = 5
    m.sh.header = "&C第&Pページ"
    c.extra["texts"] = ["第5ページ", "第6ページ"]
    c.extra["textsAbsent"] = ["第1ページ", "第7ページ"]
    return c


def case_f21():
    """高い行が境目にかかる：38行目を60pt・70行目を120ptにする。境目にかかる行は丸ごと次のページへ"""
    c = Case("f21-tall-rows-boundary", "境目にかかる高い行")
    m = c.sheet("Sheet1")
    m.grid(100, 6)
    m.sh.row_heights = {37: 60, 69: 120, 80: 45}
    return c


def case_f22():
    """組み合わせ：A4横・印刷範囲・印刷タイトル(行)・手動の改ページ・非表示の行・結合・画像"""
    c = Case("f22-combination", "組み合わせ(境目)")
    m = c.sheet("集計")
    m.grid(150, 16)
    m.sh.landscape = True
    m.sh.print_area = "集計!$A$1:$N$140"
    m.sh.print_title_rows = "$1:$1"
    m.sh.row_breaks = [60]
    m.sh.hidden_rows = {25, 26}
    for r in range(70, 73):
        for cc in range(3, 6):
            if (r, cc) != (70, 3):
                m.markers.pop((r, cc), None)
                m.sh.cells.pop((r, cc), None)
    m.sh.styles[(70, 3)] = a.S_VTOP
    m.sh.merges = ["D71:F73"]
    m.sh.picture(g.two_cell(9, 40, 12, 46, edit_as="oneCell"), g.png_bytes(60, 40, (112, 48, 160)))
    m.drawings.append(("purple", 40, 9, 46, 12))
    c.extra["colors"] = {"purple": [112, 48, 160]}
    return c


CASES = [case_f01, case_f02, case_f03, case_f04, case_f05, case_f06, case_f07, case_f08, case_f09, case_f10, case_f11,
         case_f12, case_f13, case_f14, case_f15, case_f16, case_f17, case_f18, case_f19, case_f20, case_f21, case_f22]


def main():
    os.makedirs(a.OUT, exist_ok=True)
    bad = 0
    for fn in CASES:
        g._uid[0] = 0
        c = fn()
        problems = c.save()
        print(f"{c.name}.xlsx  {'OK' if not problems else '問題あり'}")
        for p in problems:
            print("   -", p)
        bad += len(problems)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
