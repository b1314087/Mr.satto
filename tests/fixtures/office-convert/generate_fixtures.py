"""
Excel→Word・Word→Excel 変換のテスト用ファイルを作る（架空のデータだけを使う）。

使い方: python3 generate_fixtures.py <出力フォルダ>
- Excel（指示書7章の18件）: x01〜x18
- Word（指示書7章の12件）: w01〜w12
"""
import io
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.pagebreak import Break, ColBreak, RowBreak
from PIL import Image as PILImage, ImageDraw

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches, Cm

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
OUT.mkdir(parents=True, exist_ok=True)

THIN = Side(style="thin", color="000000")
MEDIUM = Side(style="medium", color="1F4E79")
DOUBLE = Side(style="double", color="000000")
DASHED = Side(style="dashed", color="C00000")
ALL_THIN = Border(top=THIN, bottom=THIN, left=THIN, right=THIN)


def png(w, h, color=(70, 130, 180)):
    img = PILImage.new("RGB", (w, h), color)
    d = ImageDraw.Draw(img)
    d.rectangle([4, 4, w - 5, h - 5], outline=(255, 255, 255), width=3)
    d.line([0, 0, w, h], fill=(255, 220, 0), width=4)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return buf


def a4(ws, landscape=False):
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = "landscape" if landscape else "portrait"


def header_row(ws, row, labels, fill="DDEBF7"):
    for i, label in enumerate(labels, start=1):
        c = ws.cell(row=row, column=i, value=label)
        c.font = Font(bold=True, name="游ゴシック", size=11)
        c.fill = PatternFill("solid", fgColor=fill)
        c.border = ALL_THIN
        c.alignment = Alignment(horizontal="center", vertical="center")


def simple_table(ws, cols, rows, start=1, widths=12):
    header_row(ws, start, [f"項目{i}" for i in range(1, cols + 1)])
    for r in range(rows):
        for c in range(cols):
            cell = ws.cell(row=start + 1 + r, column=c + 1, value=(r + 1) * 100 + c if c % 2 else f"データ{r + 1}-{c + 1}")
            cell.border = ALL_THIN
    for c in range(cols):
        ws.column_dimensions[chr(65 + c) if c < 26 else "A" + chr(65 + c - 26)].width = widths


def save(wb, name):
    wb.save(OUT / name)


# --- Excel ---------------------------------------------------------------
def x01():
    wb = Workbook(); ws = wb.active; ws.title = "A4縦"; a4(ws)
    simple_table(ws, 5, 12)
    save(wb, "x01-a4-portrait-simple.xlsx")


def x02():
    wb = Workbook(); ws = wb.active; ws.title = "A4横"; a4(ws, True)
    simple_table(ws, 8, 10, widths=14)
    save(wb, "x02-a4-landscape-simple.xlsx")


def x03():
    wb = Workbook(); ws = wb.active; ws.title = "列が多い縦"; a4(ws)
    simple_table(ws, 14, 15, widths=11)
    save(wb, "x03-a4-portrait-wide.xlsx")


def x04():
    wb = Workbook(); ws = wb.active; ws.title = "列が多い横"; a4(ws, True)
    simple_table(ws, 22, 12, widths=11)
    save(wb, "x04-a4-landscape-wide.xlsx")


def x05():
    wb = Workbook(); ws = wb.active; ws.title = "長い文章"; a4(ws)
    header_row(ws, 1, ["番号", "内容", "備考"])
    long = "これは長い文章のテストです。セルの中で折り返して表示されることを確かめるため、同じような文を何度も繰り返します。" * 3
    for r in range(2, 8):
        ws.cell(row=r, column=1, value=r - 1).border = ALL_THIN
        c = ws.cell(row=r, column=2, value=long); c.alignment = Alignment(wrap_text=True, vertical="top"); c.border = ALL_THIN
        ws.cell(row=r, column=3, value="改行あり\n2行目").alignment = Alignment(wrap_text=True)
    ws.column_dimensions["B"].width = 60; ws.column_dimensions["C"].width = 14
    save(wb, "x05-long-text.xlsx")


def x06():
    wb = Workbook(); ws = wb.active; ws.title = "結合"; a4(ws)
    ws.merge_cells("A1:F1"); ws["A1"] = "結合セルの多い表（タイトル）"; ws["A1"].font = Font(bold=True, size=14); ws["A1"].alignment = Alignment(horizontal="center")
    header_row(ws, 2, ["区分", "A", "B", "C", "D", "合計"])
    for r in range(3, 11):
        for c in range(1, 7):
            ws.cell(row=r, column=c, value=f"{r}-{c}").border = ALL_THIN
    ws.merge_cells("A3:A5"); ws["A3"] = "第1区分"
    ws.merge_cells("A6:A10"); ws["A6"] = "第2区分"
    ws.merge_cells("B3:C3"); ws.merge_cells("D7:E9")
    save(wb, "x06-merged.xlsx")


def x07():
    wb = Workbook(); ws = wb.active; ws.title = "画像"; a4(ws)
    simple_table(ws, 4, 6)
    img = XLImage(png(900, 500)); img.anchor = "B10"; ws.add_image(img)
    save(wb, "x07-image.xlsx")


def x08():
    wb = Workbook(); ws = wb.active; ws.title = "グラフ"; a4(ws)
    ws.append(["月", "売上"])
    for i, v in enumerate([120, 150, 90, 180, 210, 160], start=1):
        ws.append([f"{i}月", v])
    chart = BarChart(); chart.title = "月別の売上"; chart.y_axis.title = "金額"; chart.x_axis.title = "月"
    chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=7), titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
    chart.width = 16; chart.height = 8
    ws.add_chart(chart, "D2")
    save(wb, "x08-chart.xlsx")


def x09():
    wb = Workbook()
    for i in range(3):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = f"シート{i + 1}"; a4(ws, landscape=(i == 1))
        simple_table(ws, 4 + i, 5)
    save(wb, "x09-multi-sheet.xlsx")


def x10():
    wb = Workbook(); ws = wb.active; ws.title = "印刷範囲"; a4(ws)
    simple_table(ws, 8, 20)
    ws["J1"] = "範囲の外"
    ws.print_area = "A1:D10"
    save(wb, "x10-print-area.xlsx")


def x11():
    wb = Workbook(); ws = wb.active; ws.title = "改ページ"; a4(ws)
    simple_table(ws, 4, 30)
    ws.row_breaks.append(Break(id=11))
    ws.row_breaks.append(Break(id=21))
    ws.print_title_rows = "1:1"
    save(wb, "x11-manual-breaks.xlsx")


def x12():
    wb = Workbook(); ws = wb.active; ws.title = "非表示"; a4(ws)
    simple_table(ws, 6, 10)
    ws.row_dimensions[4].hidden = True
    ws.column_dimensions["C"].hidden = True
    save(wb, "x12-hidden.xlsx")


def x13():
    wb = Workbook(); ws = wb.active; ws.title = "フォント"; a4(ws)
    fonts = ["游ゴシック", "游明朝", "メイリオ", "ＭＳ ゴシック", "ＭＳ 明朝", "Noto Sans CJK JP", "Arial"]
    for i, f in enumerate(fonts, start=1):
        ws.cell(row=i, column=1, value=f)
        c = ws.cell(row=i, column=2, value=f"日本語の文字と English 123（{f}）"); c.font = Font(name=f, size=11)
    ws.column_dimensions["A"].width = 20; ws.column_dimensions["B"].width = 50
    save(wb, "x13-japanese-fonts.xlsx")


def x14():
    wb = Workbook(); ws = wb.active; ws.title = "文字サイズ"; a4(ws)
    for i, s in enumerate([8, 9, 10.5, 11, 14, 18, 24], start=1):
        c = ws.cell(row=i, column=1, value=f"{s}ptの文字"); c.font = Font(size=s)
        ws.cell(row=i, column=2, value=s * 10)
    ws.column_dimensions["A"].width = 30
    save(wb, "x14-font-sizes.xlsx")


def x15():
    wb = Workbook(); ws = wb.active; ws.title = "罫線と色"; a4(ws)
    colors = ["FFC7CE", "C6EFCE", "FFEB9C", "BDD7EE", "D9D9D9"]
    sides = [THIN, MEDIUM, DOUBLE, DASHED]
    for r in range(1, 11):
        for c in range(1, 6):
            cell = ws.cell(row=r, column=c, value=f"{r},{c}")
            cell.fill = PatternFill("solid", fgColor=colors[(r + c) % 5])
            s = sides[(r * c) % 4]
            cell.border = Border(top=s, bottom=s, left=THIN, right=THIN)
            cell.font = Font(color="C00000" if c == 3 else "000000", bold=(r == 1), italic=(c == 5), underline="single" if c == 4 else None)
    ws["A12"] = "00123"; ws["B12"] = 0.256; ws["B12"].number_format = "0.0%"; ws["C12"] = 1234567.891; ws["C12"].number_format = "#,##0.00"
    ws["D12"] = 5000; ws["D12"].number_format = '"¥"#,##0'
    import datetime
    ws["E12"] = datetime.date(2026, 11, 14); ws["E12"].number_format = "yyyy/mm/dd"
    save(wb, "x15-borders-colors.xlsx")


def x16():
    wb = Workbook(); ws = wb.active; ws.title = "超横長"; a4(ws)
    simple_table(ws, 40, 8, widths=10)
    save(wb, "x16-very-wide.xlsx")


def x17():
    wb = Workbook(); ws = wb.active; ws.title = "縦に長い"; a4(ws)
    simple_table(ws, 5, 160)
    ws.print_title_rows = "1:1"
    ws.oddHeader.center.text = "&A"
    ws.oddFooter.right.text = "&P / &N"
    save(wb, "x17-long-vertical.xlsx")


def x18():
    wb = Workbook(); ws = wb.active; ws.title = "画像と表"; a4(ws)
    img = XLImage(png(300, 120, (200, 80, 80))); img.anchor = "A1"; ws.add_image(img)
    simple_table(ws, 5, 8, start=8)
    img2 = XLImage(png(1600, 300)); img2.anchor = "A20"; ws.add_image(img2)
    save(wb, "x18-images-and-table.xlsx")


# --- Word ----------------------------------------------------------------
def set_cell_bg(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd"); shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)


def word_table(doc, rows, cols, header=True, style="Table Grid"):
    t = doc.add_table(rows=rows, cols=cols)
    t.style = style
    for r in range(rows):
        for c in range(cols):
            t.cell(r, c).text = (f"見出し{c + 1}" if (header and r == 0) else f"値{r}-{c + 1}")
    return t


def w01():
    d = Document(); word_table(d, 4, 3); d.save(OUT / "w01-simple.docx")


def w02():
    d = Document(); d.add_heading("売上の表", level=2); word_table(d, 3, 3)
    d.add_paragraph("次の表です。"); d.add_heading("仕入の表", level=2); word_table(d, 5, 4)
    d.save(OUT / "w02-multiple.docx")


def w03():
    d = Document(); t = word_table(d, 5, 4)
    a = t.cell(1, 0).merge(t.cell(3, 0)); a.text = "縦に結合"
    b = t.cell(0, 1).merge(t.cell(0, 3)); b.text = "横に結合"
    d.save(OUT / "w03-merged.docx")


def w04():
    d = Document(); d.add_paragraph("複数ページの表")
    t = word_table(d, 120, 3)
    d.save(OUT / "w04-multipage.docx")


def w05():
    d = Document(); t = word_table(d, 3, 2)
    t.cell(1, 1).text = "長い文章のセルです。" * 30
    p = t.cell(2, 1).paragraphs[0]; p.text = "1つ目の段落"; t.cell(2, 1).add_paragraph("2つ目の段落")
    d.save(OUT / "w05-long-text.docx")


def w06():
    d = Document(); d.add_paragraph("画像の前の文章です。")
    d.add_picture(png(400, 200), width=Inches(3)); d.add_paragraph("画像の後の文章です。")
    t = word_table(d, 2, 2); t.cell(1, 1).paragraphs[0].add_run().add_picture(png(120, 80, (60, 160, 60)), width=Inches(1))
    d.save(OUT / "w06-images.docx")


def w07():
    d = Document(); d.add_heading("文書の題名", level=1)
    d.add_paragraph("はじめに、説明の文章を書きます。")
    d.add_heading("表1：会員の一覧", level=2); word_table(d, 4, 3)
    d.add_heading("表2：料金", level=2); word_table(d, 3, 2)
    d.add_paragraph("おわりの文章。")
    d.save(OUT / "w07-headings.docx")


def w08():
    d = Document(); t = word_table(d, 4, 3)
    t.cell(1, 0).text = "日本語"; t.cell(1, 1).text = "English"; t.cell(1, 2).text = "混在 mixed 123"
    d.save(OUT / "w08-mixed-lang.docx")


def w09():
    d = Document(); t = word_table(d, 4, 3)
    set_cell_bg(t.cell(0, 0), "FFC000"); set_cell_bg(t.cell(1, 1), "BDD7EE")
    run = t.cell(1, 0).paragraphs[0].runs[0]; run.bold = True; run.font.color.rgb = RGBColor(0xC0, 0, 0); run.font.size = Pt(14)
    p = t.cell(2, 2).paragraphs[0]; p.text = ""; r1 = p.add_run("一部だけ"); r1.bold = True; p.add_run("太字"); p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    t.cell(3, 1).paragraphs[0].runs[0].italic = True; t.cell(3, 1).paragraphs[0].runs[0].underline = True
    t.cell(3, 0).paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    d.save(OUT / "w09-complex-format.docx")


def w10():
    d = Document(); t = d.add_table(rows=6, cols=5); t.style = "Table Grid"
    for (r, c) in [(0, 0), (2, 3), (5, 4), (3, 1)]:
        t.cell(r, c).text = f"あり{r}{c}"
    d.save(OUT / "w10-sparse.docx")


def w11():
    d = Document(); t = d.add_table(rows=6, cols=4); t.style = "Table Grid"
    vals = [["品名", "数量", "単価", "日付"], ["りんご", "1,200", "¥150", "2026/11/14"], ["みかん", "35", "12.5%", "2026年1月5日"], ["番号", "00123", "03-1234-5678", "2026/02/30"], ["合計", "-42", "1500円", "R8.1.1"], ["", "3.14", "0", "1/2"]]
    for r, row in enumerate(vals):
        for c, v in enumerate(row):
            t.cell(r, c).text = v
    d.save(OUT / "w11-numbers-dates.docx")


def w12():
    d = Document(); d.add_paragraph("表の前の文章です。説明があります。")
    word_table(d, 3, 3); d.add_paragraph("表の後の文章です。")
    d.add_paragraph("箇条書き1", style="List Bullet"); d.add_paragraph("箇条書き2", style="List Bullet")
    d.save(OUT / "w12-text-around.docx")


for fn in [x01, x02, x03, x04, x05, x06, x07, x08, x09, x10, x11, x12, x13, x14, x15, x16, x17, x18,
           w01, w02, w03, w04, w05, w06, w07, w08, w09, w10, w11, w12]:
    fn()
print("ok", len(list(OUT.iterdir())))
