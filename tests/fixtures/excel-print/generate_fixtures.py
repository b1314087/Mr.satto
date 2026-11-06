"""
Excel→PDF 再現性テスト用の .xlsx を作る（架空のデータのみ。個人情報なし）。

openpyxl（Excelと同じ形式のファイルを書き出すPythonのライブラリ）で作る。テーマカラー・パレット色・
グラデーション・印刷設定・ヘッダー/フッター・画像・グラフなど、Excelが実際に保存する形で書き出せるため、
アプリの読み取り（src/lib/excel/ooxml-page-settings.ts）を、手組みのXMLより実際に近い形で確かめられる。

作り直すとき（ファイルはリポジトリにコミット済み。通常は実行不要）:
  python3 tests/fixtures/excel-print/generate_fixtures.py
出力先: tests/fixtures/static/excel-print/*.xlsx
"""
import datetime as dt
import io
import os
import struct
import zlib

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.drawing.image import Image as XlImage
from openpyxl.styles import Alignment, Border, Color, Font, GradientFill, PatternFill, Side
from openpyxl.worksheet.pagebreak import Break, ColBreak, RowBreak
from openpyxl.worksheet.properties import PageSetupProperties

OUT = os.path.join(os.path.dirname(__file__), "..", "static", "excel-print")
os.makedirs(OUT, exist_ok=True)

THIN = Side(style="thin", color="000000")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def margins(ws, top=0.75, bottom=0.75, left=0.7, right=0.7, header=0.3, footer=0.3):
    m = ws.page_margins
    m.top, m.bottom, m.left, m.right, m.header, m.footer = top, bottom, left, right, header, footer


def table(ws, rows, cols, start_row=1, start_col=1, header=True, prefix="項目"):
    for c in range(cols):
        cell = ws.cell(row=start_row, column=start_col + c, value=f"{prefix}{c + 1}" if header else c + 1)
        cell.font = Font(bold=True)
        cell.border = BOX
    for r in range(1, rows):
        for c in range(cols):
            cell = ws.cell(row=start_row + r, column=start_col + c, value=(r * 10 + c) if c else f"行{r}")
            cell.border = BOX


def save(wb, name):
    path = os.path.join(OUT, name)
    wb.save(path)
    print("wrote", path)


def png_bytes(w, h, rgb):
    """単色のPNG（画像テスト用。外部の画像を使わない）"""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# 01 A4縦・印刷範囲指定（範囲外にも文字を置く）
wb = Workbook(); ws = wb.active; ws.title = "印刷範囲"
ws.page_setup.paperSize = ws.PAPERSIZE_A4; ws.page_setup.orientation = "portrait"
table(ws, 20, 5, start_row=2, start_col=2)
ws["A1"] = "範囲外の文字（印刷されない）"; ws["H2"] = "範囲外の列（印刷されない）"; ws["B25"] = "範囲外の行（印刷されない）"
ws.print_area = "B2:F21"
margins(ws)
save(wb, "01-a4-portrait-print-area.xlsx")

# 02 A4横・横1ページに収める（縦は自動）
wb = Workbook(); ws = wb.active; ws.title = "横1ページ"
ws.page_setup.paperSize = ws.PAPERSIZE_A4; ws.page_setup.orientation = "landscape"
ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
table(ws, 80, 24)
margins(ws, 0.5, 0.5, 0.4, 0.4)
save(wb, "02-a4-landscape-fit-width.xlsx")

# 03 複数ページ（A4縦・拡大縮小なし・1行目を毎ページ繰り返す）
wb = Workbook(); ws = wb.active; ws.title = "複数ページ"
ws.page_setup.paperSize = ws.PAPERSIZE_A4; ws.page_setup.orientation = "portrait"; ws.page_setup.scale = 100
table(ws, 150, 6)
ws.print_title_rows = "1:1"
margins(ws)
save(wb, "03-multi-page.xlsx")

# 04 背景色・文字色・罫線色（rgb・テーマ色＋明るさ・パレット色・パターン・グラデーション）
wb = Workbook(); ws = wb.active; ws.title = "色と罫線"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.column_dimensions["A"].width = 22
for c in "BCDE":
    ws.column_dimensions[c].width = 16
specs = [
    ("rgb 赤背景・白文字", PatternFill("solid", fgColor="FFFF0000"), Font(color="FFFFFFFF", bold=True)),
    ("テーマ色（アクセント1）", PatternFill("solid", fgColor=Color(theme=4)), Font(color=Color(theme=0))),
    ("テーマ色＋明るさ40%", PatternFill("solid", fgColor=Color(theme=5, tint=0.3999755851924192)), Font(color=Color(theme=1))),
    ("テーマ色＋暗さ25%", PatternFill("solid", fgColor=Color(theme=9, tint=-0.249977111117893)), Font(color=Color(theme=0))),
    ("パレット色（indexed 13 黄）", PatternFill("solid", fgColor=Color(indexed=13)), Font(color=Color(indexed=10))),
    ("パレット色（indexed 44 水色）", PatternFill("solid", fgColor=Color(indexed=44)), Font(color=Color(indexed=12))),
    ("パターン（25%灰色）", PatternFill("lightGray", fgColor="FF0000FF", bgColor="FFFFFFFF"), Font()),
    ("グラデーション（青→白）", GradientFill(type="linear", degree=0, stop=("FF4472C4", "FFFFFFFF")), Font()),
    ("グラデーション（緑→黄）", GradientFill(type="linear", degree=90, stop=("FF70AD47", "FFFFC000")), Font(bold=True)),
]
for i, (label, fill, font) in enumerate(specs, start=1):
    ws.cell(row=i, column=1, value=label)
    cell = ws.cell(row=i, column=2, value="見本")
    cell.fill = fill; cell.font = font; cell.border = BOX
border_specs = [
    ("赤の細線", Side(style="thin", color="FFFF0000")),
    ("青の太線", Side(style="thick", color="FF0000FF")),
    ("緑の中線", Side(style="medium", color="FF00B050")),
    ("テーマ色の点線", Side(style="dotted", color=Color(theme=5))),
    ("パレット色の二重線", Side(style="double", color=Color(indexed=10))),
    ("破線（自動の色）", Side(style="dashed")),
]
for i, (label, side) in enumerate(border_specs, start=12):
    ws.cell(row=i, column=1, value=label)
    ws.cell(row=i, column=3, value="罫線").border = Border(left=side, right=side, top=side, bottom=side)
save(wb, "04-colors-borders.xlsx")

# 05 結合セル
wb = Workbook(); ws = wb.active; ws.title = "結合セル"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.merge_cells("A1:F1"); ws["A1"] = "横方向に結合したタイトル（中央揃え）"
ws["A1"].alignment = Alignment(horizontal="center", vertical="center"); ws["A1"].font = Font(size=14, bold=True)
ws.row_dimensions[1].height = 30
ws.merge_cells("A3:A8"); ws["A3"] = "縦に結合"; ws["A3"].alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
ws.merge_cells("B3:D5"); ws["B3"] = "複数行・複数列を結合し、長い文章を折り返して表示するセルです。"
ws["B3"].alignment = Alignment(wrap_text=True, vertical="top")
ws.merge_cells("B6:D8"); ws["B6"] = "右下揃え"; ws["B6"].alignment = Alignment(horizontal="right", vertical="bottom")
for row in ws["A3:F8"]:
    for cell in row:
        cell.border = BOX
for r in range(3, 9):
    ws.cell(row=r, column=5, value=f"E{r}"); ws.cell(row=r, column=6, value=r * 100)
save(wb, "05-merged-cells.xlsx")

# 06 列幅・行高
wb = Workbook(); ws = wb.active; ws.title = "列幅と行高"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
widths = [5, 30, 12, 8, 20]
for i, w in enumerate(widths):
    ws.column_dimensions[chr(65 + i)].width = w
for r, h in enumerate([15, 40, 10, 60, 25], start=1):
    ws.row_dimensions[r].height = h
    for c in range(5):
        cell = ws.cell(row=r, column=c + 1, value=f"{chr(65 + c)}{r}")
        cell.border = BOX
        cell.alignment = Alignment(vertical="center")
save(wb, "06-column-row-sizes.xlsx")

# 07 日付・数値・通貨・パーセント
wb = Workbook(); ws = wb.active; ws.title = "表示形式"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.column_dimensions["A"].width = 26; ws.column_dimensions["B"].width = 24
fmts = [
    ("日付 yyyy/m/d", dt.datetime(2026, 11, 6), "yyyy/m/d"),
    ("日付 yyyy年m月d日", dt.datetime(2026, 11, 6), 'yyyy"年"m"月"d"日"'),
    ("和暦 ggge年m月d日", dt.datetime(2026, 11, 6), '[$-ja-JP]ggge"年"m"月"d"日"'),
    ("曜日つき", dt.datetime(2026, 11, 6), 'm"月"d"日"(aaa)'),
    ("時刻 h:mm", dt.time(9, 5), "h:mm"),
    ("日時", dt.datetime(2026, 11, 6, 14, 30), "yyyy/mm/dd hh:mm"),
    ("通貨（円）", 1234567, '"¥"#,##0'),
    ("通貨（ドル）", 1234.5, '"$"#,##0.00'),
    ("負数を赤で", -2500, '#,##0;[Red]-#,##0'),
    ("桁区切り", 9876543.21, "#,##0.00"),
    ("パーセント", 0.256, "0%"),
    ("パーセント小数1桁", 0.1234, "0.0%"),
    ("文字列", "0123", "@"),
]
for i, (label, value, fmt) in enumerate(fmts, start=1):
    ws.cell(row=i, column=1, value=label)
    c = ws.cell(row=i, column=2, value=value); c.number_format = fmt; c.border = BOX
save(wb, "07-number-formats.xlsx")

# 08 手動改ページ（行と列）
wb = Workbook(); ws = wb.active; ws.title = "手動改ページ"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
table(ws, 30, 6)
ws.row_breaks.append(Break(id=10)); ws.row_breaks.append(Break(id=20))
ws.col_breaks.append(Break(id=3))
save(wb, "08-manual-breaks.xlsx")

# 09 複数シートで異なる印刷設定（非表示シート・枠線の印刷を含む）
wb = Workbook()
s1 = wb.active; s1.title = "A4縦"; s1.page_setup.paperSize = s1.PAPERSIZE_A4; s1.page_setup.orientation = "portrait"; table(s1, 10, 4)
s2 = wb.create_sheet("A3横"); s2.page_setup.paperSize = s2.PAPERSIZE_A3; s2.page_setup.orientation = "landscape"; table(s2, 10, 4)
s3 = wb.create_sheet("非表示"); s3["A1"] = "このシートは非表示（印刷されない）"; s3.sheet_state = "hidden"
s4 = wb.create_sheet("B5縦（JIS）"); s4.page_setup.paperSize = 13; s4.page_setup.orientation = "portrait"; table(s4, 10, 4)
s5 = wb.create_sheet("Letter枠線"); s5.page_setup.paperSize = s5.PAPERSIZE_LETTER; s5.print_options.gridLines = True
for r in range(1, 11):
    for c in range(1, 5):
        s5.cell(row=r, column=c, value=r * c)
s6 = wb.create_sheet("B4横（JIS）"); s6.page_setup.paperSize = 12; s6.page_setup.orientation = "landscape"; table(s6, 10, 4)
save(wb, "09-multi-sheet-settings.xlsx")

# 10 非表示行・非表示列
wb = Workbook(); ws = wb.active; ws.title = "非表示"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
table(ws, 12, 6)
for r in (4, 5, 9):
    ws.row_dimensions[r].hidden = True
ws.column_dimensions["C"].hidden = True
ws.column_dimensions["E"].hidden = True
save(wb, "10-hidden-rows-cols.xlsx")

# 11 ヘッダー・フッター
wb = Workbook(); ws = wb.active; ws.title = "ヘッダーフッター"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
table(ws, 90, 4)
ws.oddHeader.left.text = "&F"; ws.oddHeader.center.text = "&A"; ws.oddHeader.right.text = "&D"
ws.oddFooter.center.text = "&P / &N ページ"; ws.oddFooter.right.text = "社外秘（架空）"
margins(ws, 1.0, 1.0, 0.7, 0.7, 0.4, 0.4)
save(wb, "11-header-footer.xlsx")

# 12 画像・グラフ
wb = Workbook(); ws = wb.active; ws.title = "画像とグラフ"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws["A1"] = "月"; ws["B1"] = "売上（架空）"
for i, m in enumerate(["1月", "2月", "3月", "4月", "5月", "6月"], start=2):
    ws.cell(row=i, column=1, value=m); ws.cell(row=i, column=2, value=(i - 1) * 120)
img = XlImage(io.BytesIO(png_bytes(120, 60, (255, 120, 0))))
img.anchor = "D2"
ws.add_image(img)
chart = BarChart(); chart.title = "売上（架空）"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=7), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
ws.add_chart(chart, "D10")
save(wb, "12-image-chart.xlsx")
