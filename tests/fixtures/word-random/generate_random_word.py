#!/usr/bin/env python3
"""
Word→PDFの汎用性の検証用：乱数(シードを固定)で構造を変えたDOCXと、その「性質」の期待値を作る。

特定の文書に合わせた期待値ではなく、どんな文書でも成り立つべき性質を確かめる(tests/tools/word-to-pdf-random-properties.spec.ts)。
  - 内容の欠落・重複が無い：すべての目印の文字が、ちょうど1回ずつ出る
  - 同じファイルを2回変換すると、同じ結果になる(ページ数・目印の文字の位置)
  - 余白を広くする(使える領域を狭くする)と、ページ数は減らない
  - 文字を大きくすると、ページ数は減らない
  - 段落を足しても、前からあった内容は消えず、ページ数は減らない
  - 画像を大きくすると、ページ数は減らない
文書の構造(段落の数・文字数・フォント・文字の大きさ・行間・段落の間隔・表・画像(行の中・浮動配置)・箇条書き・
改ページ・セクション・用紙の向き)は、シードごとに乱数で決める。

使い方:  python3 tests/fixtures/word-random/generate_random_word.py
出力先:  tests/fixtures/static/word-random/*.docx と manifest.json(性質の組)。データはすべて架空。
"""
from __future__ import annotations

import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, "..", "word-page-fidelity"))
import generate_word_fixtures as w  # noqa: E402

w.OUT = os.path.join(HERE, "..", "static", "word-random")
OUT = w.OUT

FONTS = ["Calibri", "Arial", "Times New Roman", "ＭＳ 明朝", "ＭＳ ゴシック", "Noto Sans CJK JP", "游明朝", "Century"]
WORDS_JA = ["検証", "文章", "段落", "ページ", "境目", "表示", "変換", "確認", "印刷", "書式", "配置", "行間", "文字", "画像"]
WORDS_EN = ["layout", "page", "break", "paragraph", "table", "image", "font", "width", "height", "margin", "section"]


def sentence(rng: random.Random, n: int) -> str:
    out = []
    for _ in range(n):
        if rng.random() < 0.6:
            out.append("".join(rng.choice(WORDS_JA) for _ in range(rng.randint(2, 5))) + rng.choice(["、", "。", ""]))
        else:
            out.append(" " + " ".join(rng.choice(WORDS_EN) for _ in range(rng.randint(2, 6))) + " ")
    return "".join(out)


def run_xml(text: str, font: str, size: float, bold=False) -> str:
    rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:eastAsia="{font}" w:hAnsi="{font}"/>{"<w:b/>" if bold else ""}<w:sz w:val="{round(size * 2)}"/></w:rPr>'
    return w.Doc.text_runs(text, rpr)


def build(seed: int, *, margin_add: float = 0, size_mul: float = 1.0, extra_paras: int = 0, image_mul: float = 1.0) -> w.Doc:
    """シードで決まる文書を作る。引数は性質の確認のための変化(余白を足す・文字を大きく・段落を足す・画像を大きく)"""
    rng = random.Random(seed)
    name = f"r{seed:03d}"
    d = w.Doc(name, f"乱数の文書 {seed}", "D")
    d.numbering = True
    margins = tuple(rng.choice([54, 72, 90]) + margin_add for _ in range(4))
    landscape = rng.random() < 0.2
    n_blocks = rng.randint(14, 34)
    marker_no = 0

    def mark() -> str:
        nonlocal marker_no
        marker_no += 1
        t = f"Q{seed:03d}M{marker_no:03d}"
        d.mark(t, 1)
        return t

    for bi in range(n_blocks + extra_paras):
        if bi >= n_blocks:
            # 足した段落(前からある段落と、同じ乱数の並びを乱さないよう、別の乱数で作る)
            r2 = random.Random(seed * 1000 + bi)
            font = r2.choice(FONTS)
            d.p("", runs_xml=run_xml(mark() + " " + sentence(r2, r2.randint(2, 8)), font, 10.5 * size_mul), after=6)
            continue
        kind = rng.choices(["para", "list", "table", "image", "float", "break", "section"], weights=[60, 8, 8, 6, 4, 3, 2])[0]
        font = rng.choice(FONTS)
        size = rng.choice([9, 10, 10.5, 11, 12, 14]) * size_mul
        if kind == "para":
            rule = rng.random()
            kw = {"before": rng.choice([0, 0, 6, 12]), "after": rng.choice([0, 6, 8, 12])}
            if rule < 0.15:
                kw["exact"] = round(size * rng.uniform(1.2, 1.8), 1)
            elif rule < 0.4:
                kw["line"] = rng.choice([1.15, 1.5, 2.0])
            d.p("", runs_xml=run_xml(mark() + " " + sentence(rng, rng.randint(1, 12)), font, size, bold=rng.random() < 0.1),
                keep_next=rng.random() < 0.08, align=rng.choice([None, None, "center", "right", "both"]), **kw)
        elif kind == "list":
            num_id = rng.choice([1, 2])
            for _ in range(rng.randint(2, 5)):
                d.p("", runs_xml=run_xml(mark() + " " + sentence(rng, rng.randint(1, 3)), font, size), num=(num_id, rng.choice([0, 0, 1])))
        elif kind == "table":
            cols = rng.randint(2, 4)
            rows_n = rng.randint(2, 14)
            total = 400 - margin_add * 2
            widths = [total / cols] * cols
            header = 1 if rng.random() < 0.5 else 0
            rows = []
            for ri in range(rows_n):
                # 繰り返す見出しの行には、目印を置かない(ページごとに繰り返して出るのが正しいため)
                rows.append([("見出し" if ri < header else mark() + " ") + sentence(rng, rng.randint(0, 2)) for _ in range(cols)])
            d.table(rows, widths, header_rows=header)
        elif kind == "image":
            iw = rng.choice([60, 120, 200]) * image_mul
            ih = rng.choice([40, 80, 140]) * image_mul
            d.p("", runs_xml=run_xml(mark() + " ", font, size) + d.image_xml((rng.randint(0, 200), rng.randint(0, 200), rng.randint(0, 200)), iw, ih) + run_xml(" " + mark(), font, size))
        elif kind == "float":
            iw = rng.choice([60, 90]) * image_mul
            d.p("", runs_xml=d.image_xml((rng.randint(0, 200), 120, 60), iw, iw, floating=True) + run_xml(mark() + " " + sentence(rng, rng.randint(4, 10)), font, size))
        elif kind == "break":
            d.page_break()
        elif kind == "section":
            d.p("", runs_xml=run_xml(mark() + " セクションの終わり", font, size), sect=w.sect_pr(margins=margins, landscape=landscape, brk=rng.choice([None, "continuous"])))
    d.final_sect = w.sect_pr(margins=margins, landscape=landscape)
    d.pages = None
    return d


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for seed in [3, 11, 27, 42, 58, 77]:
        base = build(seed)
        base.save()
        group = {"seed": seed, "base": f"{base.name}.docx", "variants": []}
        for suffix, kwargs, relation in [
            ("margins", {"margin_add": 36}, "pages>=base"),
            ("bigger", {"size_mul": 1.3}, "pages>=base"),
            ("more", {"extra_paras": 8}, "pages>=base,keeps-base-markers"),
            ("bigimg", {"image_mul": 1.6}, "pages>=base"),
        ]:
            v = build(seed, **kwargs)
            v.name = f"r{seed:03d}-{suffix}"
            v.save()
            group["variants"].append({"file": f"{v.name}.docx", "relation": relation})
        manifest.append(group)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"{len(manifest)}組 ({len(manifest) * 5}ファイル)")


if __name__ == "__main__":
    main()
