#!/usr/bin/env python3
"""
Excel→PDFの汎用性の検証用：乱数(シードを固定)で構造を変えたExcelと、その期待値を作る。

印刷監査(tests/fixtures/excel-print-audit/)の、Excelの印刷の決まりに沿った計算(Mr.Sattoとは別の計算)で、
乱数で作った表の「ページ数・用紙・セルの文字が出るページ」を求める。特定のブックに合わせた期待値ではない。
乱数で変えるもの：表の大きさ・列の幅・行の高さ・用紙・向き・余白・拡大縮小/ページ数に合わせる・手動の改ページ・
印刷範囲・印刷タイトル・非表示の行と列・結合セル・中央配置・ページの順・複数のシート。

性質の確認(manifest.json)：同じブックで余白だけを広くしたもの(使える領域が狭い)は、ページ数が減らない。

使い方:  python3 tests/fixtures/excel-random/generate_random_excel.py
出力先:  tests/fixtures/static/excel-random/*.xlsx と *.expect.json と manifest.json。データはすべて架空。
"""
from __future__ import annotations

import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, "..", "excel-print-audit"))
import generate_print_audit_fixtures as a  # noqa: E402

a.OUT = os.path.join(HERE, "..", "static", "excel-random")
g = a.g


def random_sheet(c: a.Case, rng: random.Random, name: str, prefix: str, margin_add: float):
    m = c.sheet(name, prefix=prefix)
    rows = rng.randint(10, 160)
    cols = rng.randint(3, 34)
    m.grid(rows, cols)
    # 列の幅(文字数)・行の高さ(pt)：一部だけ変える。目印の文字(例 S1@B100。@は幅の広い文字)が、隣のセルに
    # はみ出さず列に収まるよう、幅は10文字以上(8文字だと、Excelでも右端が隣のセルとの境で切れる)
    m.sh.col_widths = {i: rng.choice([10, 11, 12, 14, 16, 22]) for i in range(cols) if rng.random() < 0.35}
    m.sh.row_heights = {i: rng.choice([13.5, 15, 24, 30, 45]) for i in range(rows) if rng.random() < 0.15}
    m.sh.paper = rng.choice([9, 9, 9, 8, 11, 13, 1, 5])
    m.sh.landscape = rng.random() < 0.35
    base = rng.choice([None, {"left": 0.25, "right": 0.25, "top": 0.75, "bottom": 0.75, "header": 0.3, "footer": 0.3}, {"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0, "header": 0.5, "footer": 0.5}])
    marg = dict(base or {"left": 0.7, "right": 0.7, "top": 0.75, "bottom": 0.75, "header": 0.3, "footer": 0.3})
    if margin_add:
        for k in ("left", "right", "top", "bottom"):
            marg[k] = round(marg[k] + margin_add, 3)
    if base is not None or margin_add:
        m.sh.margins = marg
    mode = rng.random()
    if mode < 0.25:
        m.sh.fit = rng.choice([(1, 0), (0, 1), (1, 1), (2, 0), (1, 2), (2, 2)])
    elif mode < 0.55:
        m.sh.scale = rng.choice([50, 70, 85, 100, 120])
    # 手動の改ページ(拡大縮小のときだけ使われる)
    if rng.random() < 0.35:
        m.sh.row_breaks = sorted({rng.randint(2, rows) for _ in range(rng.randint(1, 3))})
    if rng.random() < 0.25:
        m.sh.col_breaks = sorted({rng.randint(2, cols) for _ in range(rng.randint(1, 2))})
    # 非表示の行・列
    if rng.random() < 0.3:
        m.sh.hidden_rows = {rng.randrange(rows) for _ in range(rng.randint(1, 5))}
    if rng.random() < 0.2 and cols > 4:
        m.sh.hidden_cols = {rng.randrange(cols) for _ in range(rng.randint(1, 2))}
    # 印刷範囲
    if rng.random() < 0.3:
        r1, r2 = sorted(rng.sample(range(1, rows + 1), 2))
        c1, c2 = sorted(rng.sample(range(cols), 2))
        m.sh.print_area = f"{name}!${a.cell(0, c1).rstrip('1')}${r1}:${a.cell(0, c2).rstrip('1')}${r2}"
    # 印刷タイトル(行)
    if rng.random() < 0.2 and rows > 30:
        m.sh.print_title_rows = "$1:$1"
    # ページの順
    if rng.random() < 0.2:
        m.sh.page_order = "overThenDown"
    # 結合セル(始まりのセルの目印だけを残す。文字は結合範囲の上に置く)
    merges = []
    for _ in range(rng.randint(0, 3)):
        r0 = rng.randrange(rows - 2)
        c0 = rng.randrange(cols - 2)
        r1, c1 = r0 + rng.randint(0, 2), c0 + rng.randint(1, 2)
        if any(not (r1 < mr0 or r0 > mr1 or c1 < mc0 or c0 > mc1) for mr0, mc0, mr1, mc1 in merges):
            continue
        merges.append((r0, c0, r1, c1))
    for r0, c0, r1, c1 in merges:
        for r in range(r0, r1 + 1):
            for cc in range(c0, c1 + 1):
                if (r, cc) != (r0, c0):
                    m.markers.pop((r, cc), None)
                    m.sh.cells.pop((r, cc), None)
        m.sh.styles[(r0, c0)] = a.S_VTOP
    m.sh.merges = [f"{a.cell(r0, c0)}:{a.cell(r1, c1)}" for r0, c0, r1, c1 in merges]
    return m


def build(seed: int, margin_add: float = 0.0) -> a.Case:
    rng = random.Random(seed)
    c = a.Case(f"x{seed:03d}" + ("-margins" if margin_add else ""), f"乱数のブック {seed}")
    for si in range(rng.choice([1, 1, 2, 3])):
        random_sheet(c, rng, f"S{si + 1}", f"S{si + 1}@", margin_add)
    return c


def main():
    os.makedirs(a.OUT, exist_ok=True)
    manifest = []
    bad = 0
    for seed in [5, 14, 23, 31, 46, 52, 63, 70, 88, 99]:
        for margin_add in (0.0, 0.6):
            g._uid[0] = 0
            c = build(seed, margin_add)
            problems = c.save()
            bad += len(problems)
            for p in problems:
                print(f"{c.name}: {p}")
        manifest.append({"seed": seed, "base": f"x{seed:03d}.xlsx", "variants": [{"file": f"x{seed:03d}-margins.xlsx", "relation": "pages>=base"}]})
    with open(os.path.join(a.OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"{len(manifest)}組 ({len(manifest) * 2}ファイル)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
