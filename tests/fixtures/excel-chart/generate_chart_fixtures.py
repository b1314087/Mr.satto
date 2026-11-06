"""
Excel→PDF グラフ再現テスト用の .xlsx を作る（架空のデータのみ。個人情報なし）。

1. openpyxl（Excelと同じ形式で書き出すPythonのライブラリ）でグラフ入りのブックを作る
2. LibreOffice で .xlsx として保存し直す（グラフに値の控え(numCache/strCache)と書式が入り、
   Excelが保存したファイルに近い形になる）
3. 「値の控えが無いグラフ」の確認用に、openpyxl のまま（控えなし）のファイルも1つ残す

作り直すとき（ファイルはリポジトリにコミット済み。通常は実行不要。LibreOfficeが必要）:
  python3 tests/fixtures/excel-chart/generate_chart_fixtures.py
出力先: tests/fixtures/static/excel-chart/*.xlsx
"""
import io
import os
import shutil
import struct
import subprocess
import tempfile
import zlib

from openpyxl import Workbook
from openpyxl.chart import AreaChart, BarChart, BarChart3D, DoughnutChart, LineChart, PieChart, Reference, ScatterChart, Series
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.layout import Layout, ManualLayout
from openpyxl.drawing.image import Image as XlImage
from openpyxl.styles import Border, Side

OUT = os.path.join(os.path.dirname(__file__), "..", "static", "excel-chart")
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp(prefix="xlchart-")
THIN = Side(style="thin", color="000000")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月"]


def sales(ws, start_row=1, start_col=1, n=6, cols=("売上", "費用", "利益")):
    ws.cell(row=start_row, column=start_col, value="月")
    for j, name in enumerate(cols):
        ws.cell(row=start_row, column=start_col + 1 + j, value=name)
    for i in range(n):
        ws.cell(row=start_row + 1 + i, column=start_col, value=MONTHS[i % 6] if n <= 6 else f"{i + 1}日")
        for j in range(len(cols)):
            ws.cell(row=start_row + 1 + i, column=start_col + 1 + j, value=(i + 1) * (100 - j * 30) + j * 10)


def refs(ws, col_from, col_to, rows, start_row=1, cat_col=1):
    data = Reference(ws, min_col=col_from, max_col=col_to, min_row=start_row, max_row=start_row + rows)
    cats = Reference(ws, min_col=cat_col, min_row=start_row + 1, max_row=start_row + rows)
    return data, cats


def sized(chart, w=15, h=7.5):
    chart.width = w
    chart.height = h
    return chart


def png_bytes(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def a4(ws, orientation="portrait"):
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = orientation
    m = ws.page_margins
    m.left, m.right, m.top, m.bottom = 0.7, 0.7, 0.75, 0.75


books = {}

# 01 縦棒（集合）
wb = Workbook(); ws = wb.active; ws.title = "縦棒"; a4(ws); sales(ws)
c = sized(BarChart()); c.type = "col"; c.title = "月別の売上と費用"
d, k = refs(ws, 2, 3, 6); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "F2"); books["01-column"] = wb

# 02 横棒（集合）
wb = Workbook(); ws = wb.active; ws.title = "横棒"; a4(ws); sales(ws, n=4)
c = sized(BarChart()); c.type = "bar"; c.title = "横棒の比較"
d, k = refs(ws, 2, 3, 4); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "F2"); books["02-bar"] = wb

# 03 折れ線（マーカー付き）
wb = Workbook(); ws = wb.active; ws.title = "折れ線"; a4(ws); sales(ws)
c = sized(LineChart()); c.title = "推移"
d, k = refs(ws, 2, 4, 6); c.add_data(d, titles_from_data=True); c.set_categories(k)
for s in c.series:
    s.marker.symbol = "circle"; s.smooth = False
ws.add_chart(c, "F2"); books["03-line"] = wb

# 04 円（割合のデータラベル）
wb = Workbook(); ws = wb.active; ws.title = "円"; a4(ws)
ws.append(["地域", "件数"])
for r in [["東日本", 45], ["西日本", 30], ["九州", 15], ["その他", 10]]:
    ws.append(r)
c = sized(PieChart(), 12, 8); c.title = "地域別の割合"
c.add_data(Reference(ws, min_col=2, min_row=1, max_row=5), titles_from_data=True); c.set_categories(Reference(ws, min_col=1, min_row=2, max_row=5))
c.dataLabels = DataLabelList(); c.dataLabels.showPercent = True
ws.add_chart(c, "D2"); books["04-pie"] = wb

# 05 面（標準）
wb = Workbook(); ws = wb.active; ws.title = "面"; a4(ws); sales(ws, cols=("来店数", "予約数"))
c = sized(AreaChart()); c.title = "来店と予約"
d, k = refs(ws, 2, 3, 6); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "E2"); books["05-area"] = wb

# 06 散布図
wb = Workbook(); ws = wb.active; ws.title = "散布図"; a4(ws)
ws.append(["気温", "販売数"])
for t, v in [(12, 40), (15, 55), (18, 70), (21, 82), (24, 110), (27, 130), (30, 150)]:
    ws.append([t, v])
c = sized(ScatterChart()); c.title = "気温と販売数"; c.style = 13
xs = Reference(ws, min_col=1, min_row=2, max_row=8); ys = Reference(ws, min_col=2, min_row=1, max_row=8)
s = Series(ys, xs, title_from_data=True); s.marker.symbol = "diamond"; s.graphicalProperties.line.noFill = True
c.series.append(s); c.x_axis.title = "気温（℃）"; c.y_axis.title = "販売数"
ws.add_chart(c, "D2"); books["06-scatter"] = wb

# 07 積み上げ（縦棒・100%縦棒・横棒）
wb = Workbook(); ws = wb.active; ws.title = "積み上げ"; a4(ws); sales(ws, n=4)
for i, (typ, grouping, title) in enumerate([("col", "stacked", "積み上げ縦棒"), ("col", "percentStacked", "100%積み上げ縦棒"), ("bar", "stacked", "積み上げ横棒")]):
    c = sized(BarChart(), 12, 6); c.type = typ; c.grouping = grouping; c.overlap = 100; c.title = title
    d, k = refs(ws, 2, 4, 4); c.add_data(d, titles_from_data=True); c.set_categories(k)
    ws.add_chart(c, f"A{8 + i * 13}")
books["07-stacked"] = wb

# 08 ドーナツ
wb = Workbook(); ws = wb.active; ws.title = "ドーナツ"; a4(ws)
ws.append(["項目", "割合"])
for r in [["A", 40], ["B", 35], ["C", 25]]:
    ws.append(r)
c = sized(DoughnutChart(), 10, 8); c.title = "構成比"; c.holeSize = 50
c.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True); c.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))
ws.add_chart(c, "D2"); books["08-doughnut"] = wb

# 09 複合（縦棒＋折れ線・第2軸）
wb = Workbook(); ws = wb.active; ws.title = "複合"; a4(ws)
ws.append(["月", "売上", "達成率"])
for i, m in enumerate(MONTHS):
    ws.append([m, (i + 1) * 150, 0.6 + i * 0.07])
bar = sized(BarChart()); bar.title = "売上と達成率"
bar.add_data(Reference(ws, min_col=2, min_row=1, max_row=7), titles_from_data=True); bar.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
line = LineChart(); line.add_data(Reference(ws, min_col=3, min_row=1, max_row=7), titles_from_data=True)
line.y_axis.axId = 200; line.y_axis.crosses = "max"; line.y_axis.number_format = "0%"
bar += line
ws.add_chart(bar, "E2"); books["09-combo"] = wb

# 10 タイトル・凡例(下)・軸のタイトル・最小値/最大値/目盛り間隔
wb = Workbook(); ws = wb.active; ws.title = "軸と凡例"; a4(ws); sales(ws, cols=("東京", "大阪"))
c = sized(LineChart()); c.title = "店舗別の売上（千円）"
d, k = refs(ws, 2, 3, 6); c.add_data(d, titles_from_data=True); c.set_categories(k)
c.legend.position = "b"; c.x_axis.title = "月"; c.y_axis.title = "売上（千円）"
c.y_axis.scaling.min = 0; c.y_axis.scaling.max = 700; c.y_axis.majorUnit = 100
ws.add_chart(c, "E2"); books["10-title-legend-axes"] = wb

# 11 データラベル（縦棒に値）
wb = Workbook(); ws = wb.active; ws.title = "データラベル"; a4(ws); sales(ws, n=4, cols=("件数",))
c = sized(BarChart(), 12, 7); c.title = "件数"
d, k = refs(ws, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k)
c.dataLabels = DataLabelList(); c.dataLabels.showVal = True; c.legend = None
ws.add_chart(c, "D2"); books["11-data-labels"] = wb

# 12 複数のグラフ（縦棒・折れ線・円）
wb = Workbook(); ws = wb.active; ws.title = "複数"; a4(ws); sales(ws, n=4)
c1 = sized(BarChart(), 9, 6); c1.title = "縦棒"; d, k = refs(ws, 2, 3, 4); c1.add_data(d, titles_from_data=True); c1.set_categories(k); ws.add_chart(c1, "A7")
c2 = sized(LineChart(), 9, 6); c2.title = "折れ線"; c2.add_data(d, titles_from_data=True); c2.set_categories(k); ws.add_chart(c2, "F7")
c3 = sized(PieChart(), 9, 6); c3.title = "円"; c3.add_data(Reference(ws, min_col=2, min_row=1, max_row=5), titles_from_data=True); c3.set_categories(k); ws.add_chart(c3, "A20")
books["12-multiple"] = wb

# 13 グラフとセルの重なり（表の上にグラフ）
wb = Workbook(); ws = wb.active; ws.title = "重なり"; a4(ws)
for r in range(1, 21):
    for col in range(1, 9):
        ws.cell(row=r, column=col, value=f"R{r}C{col}").border = BOX
sales(ws, start_row=22, n=4, cols=("値",))
c = sized(BarChart(), 8, 5); c.title = "重なり"; d, k = refs(ws, 2, 2, 4, start_row=22); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "C4"); books["13-overlap-cells"] = wb

# 14 グラフと画像
wb = Workbook(); ws = wb.active; ws.title = "グラフと画像"; a4(ws); sales(ws, n=4, cols=("値",))
img = XlImage(io.BytesIO(png_bytes(120, 60, (255, 120, 0)))); img.anchor = "D2"; ws.add_image(img)
c = sized(BarChart(), 10, 6); c.title = "画像の下のグラフ"; d, k = refs(ws, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "D7"); books["14-chart-and-image"] = wb

# 15 印刷範囲の中のグラフ（範囲外のグラフは印刷されない）
wb = Workbook(); ws = wb.active; ws.title = "印刷範囲"; a4(ws); sales(ws, n=4, cols=("値",))
c = sized(BarChart(), 9, 5); c.title = "範囲の中"; d, k = refs(ws, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k); ws.add_chart(c, "A7")
c2 = sized(LineChart(), 9, 5); c2.title = "範囲の外"; c2.add_data(d, titles_from_data=True); c2.set_categories(k); ws.add_chart(c2, "L7")
ws.print_area = "A1:H20"; books["15-print-area"] = wb

# 16 改ページ付近のグラフ（1ページ目と2ページ目にまたがる）
wb = Workbook(); ws = wb.active; ws.title = "改ページ"; a4(ws)
for r in range(1, 81):
    ws.cell(row=r, column=1, value=f"行{r}")
sales(ws, start_row=1, start_col=3, n=4, cols=("値",))
c = sized(BarChart(), 10, 6); c.title = "ページをまたぐ"; d, k = refs(ws, 4, 4, 4, start_row=1, cat_col=3); c.add_data(d, titles_from_data=True); c.set_categories(k)
ws.add_chart(c, "C42"); books["16-page-break"] = wb

# 17 複数シートにグラフ（A4縦・A4横）
wb = Workbook()
s1 = wb.active; s1.title = "シート1"; a4(s1); sales(s1, n=4, cols=("値",))
c = sized(BarChart(), 9, 5); c.title = "シート1のグラフ"; d, k = refs(s1, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k); s1.add_chart(c, "D2")
s2 = wb.create_sheet("シート2"); a4(s2, "landscape"); sales(s2, n=4, cols=("値",))
c = sized(LineChart(), 9, 5); c.title = "シート2のグラフ"; d, k = refs(s2, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k); s2.add_chart(c, "D2")
books["17-multi-sheet"] = wb

# 18 グラフが印刷範囲の外だけにある
wb = Workbook(); ws = wb.active; ws.title = "範囲外"; a4(ws); sales(ws, n=4, cols=("値",))
c = sized(BarChart(), 9, 5); c.title = "印刷されないグラフ"; d, k = refs(ws, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k); ws.add_chart(c, "J2")
ws.print_area = "A1:C6"; books["18-outside-print-area"] = wb

# 19 対応していない種類（3-D 縦棒）
wb = Workbook(); ws = wb.active; ws.title = "3D"; a4(ws); sales(ws, n=4, cols=("値",))
c = sized(BarChart3D(), 10, 6); c.title = "3-D 縦棒"; d, k = refs(ws, 2, 2, 4); c.add_data(d, titles_from_data=True); c.set_categories(k); ws.add_chart(c, "D2")
books["19-unsupported-3d"] = wb

raw_paths = []
for name, wb in books.items():
    p = os.path.join(TMP, f"{name}.xlsx")
    wb.save(p)
    raw_paths.append(p)

# LibreOfficeで保存し直す（グラフの値の控えが入る）
subprocess.run(["soffice", "--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", OUT] + raw_paths, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# 値の控えが無いグラフ（openpyxlのまま）
shutil.copy(os.path.join(TMP, "01-column.xlsx"), os.path.join(OUT, "01b-column-no-cache.xlsx"))
for f in sorted(os.listdir(OUT)):
    print("wrote", f)
