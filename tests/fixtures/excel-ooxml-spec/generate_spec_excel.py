#!/usr/bin/env python3
"""
Excel→PDF：行の高さの自動の計算(行の高さが保存されていない行)の検証用のブックと、その性質を作る。

Excelは、行の高さを保存していない行を、その行のセルの文字(折り返し・セル内改行・文字の大きさ・回転)に合わせた
高さで印刷する。Excelの高さの数値そのものは計算できないので、期待値は次の「性質」にする(Mr.Sattoの結果に合わせない)。
  - 折り返したセルの文字は、すべて、その行の範囲の中に描かれる(次の行・前の行にはみ出さない、欠けない)
  - 文字の行が多いセルの行ほど、行が高い(行の数が同じなら同じ高さ)
  - 大きな文字の行は、その文字の大きさ以上の高さになる
  - 高さを保存した行は、その高さ。非表示の行は印刷しない
  - 折り返さないセルの改行は、1行のまま(Excelと同じ)
  - 長いシートでも、どの行の文字も欠けず、1回だけ出る。行を増やしても、ページ数は減らない

列Aに折り返す文字(単語の目印 A{行}W{番号})、列Bに行の目印(R{行})を置く。どちらも縦の配置は「上」にして、
行の目印の上端がその行の上端(から決まった余白の位置)になるようにする(次の行の目印までが、その行の高さ)。
フォントはCalibri 11(寸法の表のある、決まった幅のフォント)。

使い方:  python3 tests/fixtures/excel-ooxml-spec/generate_spec_excel.py
出力先:  tests/fixtures/static/excel-ooxml-spec/*.xlsx と *.expect.json。データはすべて架空。
"""
from __future__ import annotations

import json
import os
import random

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

TOP = Alignment(vertical="top")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "excel-ooxml-spec")


def save(wb: Workbook, name: str, expect: dict):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.xlsx")
    wb.save(path)
    with open(os.path.join(OUT, f"{name}.expect.json"), "w", encoding="utf-8") as f:
        json.dump(expect, f, ensure_ascii=False, indent=1)


def e01():
    wb = Workbook()
    ws = wb.active
    ws.title = "Rows"
    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 12
    rows = []  # {"row": n, "words": [...], "kind": ...}
    r = 1
    # 単語の数を1〜8に増やす(折り返して、文字の行が増える)
    for n in range(1, 9):
        words = [f"A{r}W{j}" for j in range(1, n * 2 + 1)]
        ws.cell(r, 1, " ".join(words)).alignment = Alignment(wrap_text=True, vertical="top")
        ws.cell(r, 2, f"R{r}").alignment = TOP
        rows.append({"row": r, "words": words, "lines": None, "kind": "wrap"})
        r += 1
    # 大きな文字(20pt)の行
    big = [f"A{r}W1"]
    c = ws.cell(r, 1, big[0])
    c.font = Font(size=20)
    c.alignment = TOP
    ws.cell(r, 2, f"R{r}").alignment = TOP
    rows.append({"row": r, "words": big, "kind": "big", "minBand": 20})
    r += 1
    # セル内改行(折り返す)：3行
    nl = [f"A{r}W{j}" for j in range(1, 4)]
    ws.cell(r, 1, "\n".join(nl)).alignment = Alignment(wrap_text=True, vertical="top")
    ws.cell(r, 2, f"R{r}").alignment = TOP
    rows.append({"row": r, "words": nl, "kind": "newline", "distinctLines": 3})
    r += 1
    # 折り返さないセルの改行：1行のまま
    one = [f"A{r}W{j}" for j in range(1, 3)]
    ws.cell(r, 1, "\n".join(one)).alignment = TOP
    ws.cell(r, 2, f"R{r}").alignment = TOP
    # Excelは、折り返さないセルの改行を表示しない(2つの語が続いて1行に出る)
    rows.append({"row": r, "words": ["".join(one)], "kind": "nowrap", "distinctLines": 1, "band": None})
    r += 1
    # 高さを保存した行(40pt)
    fixed = [f"A{r}W1"]
    ws.cell(r, 1, fixed[0]).alignment = TOP
    ws.cell(r, 2, f"R{r}").alignment = TOP
    ws.row_dimensions[r].height = 40
    rows.append({"row": r, "words": fixed, "kind": "fixed", "band": 40})
    r += 1
    # 回転した文字(90度)：文字列の長さぶんの高さ
    rot = ws.cell(r, 3, "ROTATEDLONGTEXT")
    rot.alignment = Alignment(text_rotation=90, vertical="top")
    ws.cell(r, 2, f"R{r}").alignment = TOP
    rows.append({"row": r, "words": [], "kind": "rotated", "minBand": 50})
    r += 1
    # 非表示の行
    ws.cell(r, 1, "HIDDENROWMARK")
    ws.cell(r, 2, f"R{r}").alignment = TOP
    ws.row_dimensions[r].hidden = True
    r += 1
    ws.cell(r, 2, f"R{r}").alignment = TOP  # 最後の行の目印(前の行の下端を知るため)
    save(wb, "e01-auto-row-height", {"title": "行の高さの自動の計算(折り返し・改行・文字の大きさ・回転・固定・非表示)", "rows": rows, "lastRow": r, "absent": ["HIDDENROWMARK", f"R{r - 1}"]})


def long_sheet(name: str, n_rows: int, seed: int):
    rng = random.Random(seed)
    wb = Workbook()
    ws = wb.active
    ws.title = "Long"
    ws.column_dimensions["A"].width = rng.choice([14, 18, 24])
    ws.column_dimensions["B"].width = 10
    rows = []
    for r in range(1, n_rows + 1):
        rr = random.Random(seed * 10007 + r)  # 行ごとに決まる(行を足しても、前の行は変わらない)
        words = [f"A{r}W{j}" for j in range(1, rr.randint(1, 9) + 1)]
        c = ws.cell(r, 1, " ".join(words))
        c.alignment = Alignment(wrap_text=True, vertical="top")
        if rr.random() < 0.15:
            c.font = Font(size=rr.choice([8, 14, 16]))
        ws.cell(r, 2, f"R{r}").alignment = TOP
        rows.append({"row": r, "words": words, "kind": "wrap"})
    save(wb, name, {"title": f"長いシートの折り返し({n_rows}行)", "rows": rows, "lastRow": n_rows, "absent": []})


def main():
    e01()
    long_sheet("e02-long-wrap", 120, 7)
    long_sheet("e02-long-wrap-more", 160, 7)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump([{"base": "e02-long-wrap.xlsx", "variants": [{"file": "e02-long-wrap-more.xlsx", "relation": "pages>=base"}]}], f, indent=1)
    print("3件")


if __name__ == "__main__":
    main()
