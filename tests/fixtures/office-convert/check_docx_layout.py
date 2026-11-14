"""
Excel→Word の変換結果（.docx）を、LibreOffice で実際にページへ配置（描画）して、はみ出しを調べる。

使い方: python3 check_docx_layout.py <docx> <作業フォルダ>
出力（JSON）:
  pages: ページごとの {width, height, minX, maxX, minY, maxY, words}
  sections: docx の各セクションの {width, height, left, right, top, bottom}（pt）
  text: 本文全体の文字（表のセルを含む）
"""
import json
import subprocess
import sys
from pathlib import Path

import pdfplumber
from docx import Document

src = Path(sys.argv[1])
work = Path(sys.argv[2])
work.mkdir(parents=True, exist_ok=True)
subprocess.run(
    ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(work), str(src)],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    timeout=180,
)
pdf_path = work / (src.stem + ".pdf")

doc = Document(str(src))
sections = []
for s in doc.sections:
    sections.append({
        "width": s.page_width.pt,
        "height": s.page_height.pt,
        "left": s.left_margin.pt,
        "right": s.right_margin.pt,
        "top": s.top_margin.pt,
        "bottom": s.bottom_margin.pt,
    })

texts = []
for t in doc.tables:
    for row in t.rows:
        for cell in row.cells:
            texts.append(cell.text)
for p in doc.paragraphs:
    texts.append(p.text)

pages = []
with pdfplumber.open(str(pdf_path)) as pdf:
    for page in pdf.pages:
        xs0, xs1, ys0, ys1 = [], [], [], []
        objs = list(page.chars) + list(page.rects) + list(page.lines) + list(page.images) + list(page.curves)
        for o in objs:
            xs0.append(o["x0"]); xs1.append(o["x1"])
            ys0.append(o["top"]); ys1.append(o["bottom"])
        pages.append({
            "width": float(page.width),
            "height": float(page.height),
            "minX": min(xs0) if xs0 else None,
            "maxX": max(xs1) if xs1 else None,
            "minY": min(ys0) if ys0 else None,
            "maxY": max(ys1) if ys1 else None,
            "words": len(page.extract_words()),
            "images": len(page.images),
        })

print(json.dumps({"pages": pages, "sections": sections, "text": "\n".join(texts)}, ensure_ascii=False))
