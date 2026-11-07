#!/usr/bin/env python3
"""
検証用のOfficeファイル(Excel・Word)を LibreOffice でPDFにし、次の3つを比べる(テストとは別に、手元で実行する道具)。

  1. 期待値(*.expect.json。Officeの決まりから計算した値)と LibreOffice の、ページ数・用紙の大きさ・目印の文字のページ
  2. (--ours を付けたとき) Mr.Satto のPDF と LibreOffice のPDF の、目印の文字のページと位置のずれ(pt)
  3. (--ours を付けたとき) ページごとの見た目の差(両方を画像にして、インクのある画素の重なり具合)

LibreOffice は Microsoft Office とは別のソフトなので、LibreOffice と一致しても、Excel・Wordと一致したことにはならない。
結果は「期待値との一致」「LibreOfficeとの一致」を分けて表示する。

使い方:
  python3 compare_with_libreoffice.py <検証用ファイルのフォルダ> [--ours <Mr.SattoのPDFのフォルダ>] [--json 結果.json]
必要なもの: soffice(LibreOffice)、pdftotext・pdfinfo・pdftoppm(poppler)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile


def page_sizes(pdf: str) -> list[tuple[float, float]]:
    out = subprocess.run(["pdfinfo", "-f", "1", "-l", "9999", pdf], capture_output=True, text=True).stdout
    return [(float(m.group(1)), float(m.group(2))) for m in re.finditer(r"Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)", out)]


def words(pdf: str) -> dict[str, list[tuple[int, float, float]]]:
    """文字 → [(ページ, 左, 上)]"""
    out = subprocess.run(["pdftotext", "-bbox", pdf, "-"], capture_output=True, text=True).stdout
    found: dict[str, list[tuple[int, float, float]]] = {}
    page = 0
    for line in out.splitlines():
        if "<page " in line:
            page += 1
            continue
        m = re.search(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)</word>', line)
        if m:
            found.setdefault(m.group(3).replace("&amp;", "&"), []).append((page, float(m.group(1)), float(m.group(2))))
    return found


def ink_pages(pdf: str, dpi: int = 36) -> list[set[tuple[int, int]]]:
    """ページごとの、インク(白でない画素)のある場所(粗い格子)"""
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["pdftoppm", "-r", str(dpi), "-gray", pdf, os.path.join(d, "p")], check=True)
        pages = []
        for f in sorted(glob.glob(os.path.join(d, "p*.pgm")), key=lambda x: int(re.findall(r"(\d+)\.pgm$", x)[0])):
            data = open(f, "rb").read()
            m = re.match(rb"P5\s+(\d+)\s+(\d+)\s+255\s", data)
            w, h = int(m.group(1)), int(m.group(2))
            px = data[m.end():]
            cells = set()
            for y in range(h):
                row = px[y * w:(y + 1) * w]
                for x in range(w):
                    if row[x] < 160:
                        cells.add((x // 4, y // 4))
            pages.append(cells)
        return pages


def to_pdf_with_libreoffice(src: str, out_dir: str) -> str:
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", out_dir, src], capture_output=True, timeout=300)
    return os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + ".pdf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--ours")
    ap.add_argument("--json")
    ap.add_argument("--lo-dir", help="LibreOfficeのPDFを置くフォルダ(既にあれば使い回す)")
    args = ap.parse_args()
    lo_dir = args.lo_dir or tempfile.mkdtemp(prefix="lo-")
    os.makedirs(lo_dir, exist_ok=True)
    results = []
    for src in sorted(glob.glob(os.path.join(args.folder, "*.xlsx")) + glob.glob(os.path.join(args.folder, "*.docx"))):
        name = os.path.splitext(os.path.basename(src))[0]
        lo_pdf = os.path.join(lo_dir, name + ".pdf")
        if not os.path.exists(lo_pdf):
            lo_pdf = to_pdf_with_libreoffice(src, lo_dir)
        exp_path = os.path.join(args.folder, name + ".expect.json")
        e = json.load(open(exp_path, encoding="utf-8")) if os.path.exists(exp_path) else None
        lo_sizes = page_sizes(lo_pdf)
        lo_words = words(lo_pdf)
        r: dict = {"name": name, "lo_pages": len(lo_sizes)}
        if e:
            exp_pages = e["pages"]
            if isinstance(exp_pages, list):  # Excel：ページごとの用紙の大きさ
                r["expected_pages"] = len(exp_pages)
                r["lo_vs_expected_pages"] = len(exp_pages) == len(lo_sizes)
                r["lo_vs_expected_sizes"] = all(abs(a[0] - p["width"]) <= 1.5 and abs(a[1] - p["height"]) <= 1.5 for a, p in zip(lo_sizes, exp_pages))
            else:  # Word：ページ数だけ(自然に流れる文書は null)
                r["expected_pages"] = exp_pages
                r["lo_vs_expected_pages"] = None if exp_pages is None else exp_pages == len(lo_sizes)
                if e.get("pageSizes"):
                    r["lo_vs_expected_sizes"] = all(abs(a[0] - b[0]) <= 1.5 and abs(a[1] - b[1]) <= 1.5 for a, b in zip(lo_sizes, e["pageSizes"]))
            markers = e.get("markers", {})
            same = sum(1 for t, pages in markers.items() if sorted(x[0] for x in lo_words.get(t, [])) == sorted(pages))
            r["lo_vs_expected_markers"] = f"{same}/{len(markers)}"
        if args.ours:
            ours_pdf = os.path.join(args.ours, name + ".pdf")
            if os.path.exists(ours_pdf):
                o_sizes = page_sizes(ours_pdf)
                o_words = words(ours_pdf)
                r["ours_pages"] = len(o_sizes)
                common = [t for t in lo_words if t in o_words and len(lo_words[t]) == 1 and len(o_words[t]) == 1 and t.startswith(("@", "S", "W"))]
                same_page = [t for t in common if lo_words[t][0][0] == o_words[t][0][0]]
                r["ours_vs_lo_same_page"] = f"{len(same_page)}/{len(common)}"
                if same_page:
                    dx = [abs(lo_words[t][0][1] - o_words[t][0][1]) for t in same_page]
                    dy = [abs(lo_words[t][0][2] - o_words[t][0][2]) for t in same_page]
                    dx.sort()
                    dy.sort()
                    r["ours_vs_lo_dx_median"] = round(dx[len(dx) // 2], 1)
                    r["ours_vs_lo_dy_median"] = round(dy[len(dy) // 2], 1)
                    r["ours_vs_lo_dx_max"] = round(dx[-1], 1)
                    r["ours_vs_lo_dy_max"] = round(dy[-1], 1)
                try:
                    li, oi = ink_pages(lo_pdf), ink_pages(ours_pdf)
                    overlaps = []
                    for a_, b_ in zip(li, oi):
                        u = len(a_ | b_)
                        overlaps.append(round(len(a_ & b_) / u, 2) if u else 1.0)
                    r["ink_overlap_per_page"] = overlaps
                except Exception as ex:  # noqa: BLE001
                    r["ink_overlap_error"] = str(ex)
        results.append(r)
        print(json.dumps(r, ensure_ascii=False))
    if args.json:
        json.dump(results, open(args.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.exit(main())
