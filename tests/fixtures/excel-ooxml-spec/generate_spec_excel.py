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


def e03():
    """フォント・文字の大きさ・日本語・字下げ・縦書き・非表示の列の組み合わせ"""
    wb = Workbook()
    ws = wb.active
    ws.title = "Fonts"
    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 6
    ws.column_dimensions["D"].width = 20
    ws.column_dimensions["D"].hidden = True
    rows = []
    checks = {"equal": [], "greaterEq": [], "multiple075": []}
    r = 1

    def add(text, font=None, size=11, wrap=True, indent=0, kind="wrap", words=None, rotation=0, col=1):
        nonlocal r
        c = ws.cell(r, col, text)
        c.alignment = Alignment(wrap_text=wrap, vertical="top", indent=indent, text_rotation=rotation)
        c.font = Font(name=font or "Calibri", size=size)
        ws.cell(r, 2, f"R{r}").alignment = TOP
        rows.append({"row": r, "words": words if words is not None else text.split(), "kind": kind})
        checks["multiple075"].append(r)
        r += 1
        return r - 1

    # 同じ内容・同じフォントの行は、同じ高さ
    a1 = add("A1W1 A1W2 A1W3 A1W4 A1W5 A1W6")
    a2 = add("A2W1 A2W2 A2W3 A2W4 A2W5 A2W6")
    checks["equal"].append([a1, a2])
    # 字下げ：同じ文字でも、字下げのある行は低くならない
    a3 = add("A3W1 A3W2 A3W3 A3W4 A3W5 A3W6", indent=3)
    checks["greaterEq"].append([a3, a1])
    # 大きな文字・フォントの違い
    b1 = add("B1W1", size=11)
    b2 = add("B2W1", font="Yu Gothic", size=11)
    b3 = add("B3W1", font="Meiryo", size=11)
    b4 = add("B4W1", size=16)
    b5 = add("B5W1", font="MS PGothic", size=11)
    checks["greaterEq"] += [[b2, b1], [b3, b1], [b4, b1], [b1, b5]]
    # 日本語の折り返し(単語の目印を全角の文の間に置く)
    j1 = add("日本語の文章 J1W1 の折り返し J1W2 を確かめる J1W3 ための文です。", font="Yu Gothic", size=11, words=["J1W1", "J1W2", "J1W3"])
    checks["greaterEq"].append([j1, b2])
    # 縦書き(文字を縦に積む)：文字の数ぶんの高さ
    v1 = add("縦書きの文字", rotation=255, col=3, words=[], kind="vertical")
    rows[-1]["minBand"] = 6 * 11 * 0.8
    # 非表示の列の文字は印刷しない
    ws.cell(r - 1, 4, "HIDDENCOLMARK")
    ws.cell(r, 2, f"R{r}").alignment = TOP
    _ = (a3, v1)
    save(wb, "e03-fonts-indent-vertical", {"title": "フォント・大きさ・日本語・字下げ・縦書き・非表示の列", "rows": rows, "lastRow": r, "absent": ["HIDDENCOLMARK"], "checks": checks})


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
        # フォント・大きさ・字下げも乱数で変える(行の高さの自動の計算の組み合わせ)
        if rr.random() < 0.35:
            c.font = Font(name=rr.choice(["Calibri", "Yu Gothic", "Meiryo", "MS PGothic", "Century"]), size=rr.choice([8, 10, 11, 14, 16]))
        if rr.random() < 0.15:
            c.alignment = Alignment(wrap_text=True, vertical="top", indent=rr.choice([1, 2]))
        ws.cell(r, 2, f"R{r}").alignment = TOP
        rows.append({"row": r, "words": words, "kind": "wrap"})
    save(wb, name, {"title": f"長いシートの折り返し({n_rows}行)", "rows": rows, "lastRow": n_rows, "absent": []})


def main():
    e01()
    e03()
    long_sheet("e02-long-wrap", 120, 7)
    long_sheet("e02-long-wrap-more", 160, 7)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump([{"base": "e02-long-wrap.xlsx", "variants": [{"file": "e02-long-wrap-more.xlsx", "relation": "pages>=base"}]}], f, indent=1)
    print("4件")


if __name__ == "__main__":
    main()
