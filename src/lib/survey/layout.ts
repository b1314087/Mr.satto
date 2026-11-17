import type { Question, Survey } from "./model";

/**
 * アンケート用紙の配置（紙のプレビュー・PDF で共通。2026-11-17）。
 *
 * 用紙の上の位置をすべて mm で計算し、描く部品（文字・線・四角・丸・星）の一覧をページごとに返す。
 * 画面のプレビュー（SVG）と PDF（pdf-lib）は、同じ一覧を描くので、見た目がそろう。
 *
 * ページの分け方：
 * - 1つの質問（質問文・選択肢・記入欄）は、途中でページを分けない（ページに入らないときは、質問ごと次のページへ）。
 * - セクションの見出しは、次の質問と一緒に置く（見出しだけがページの最後に残らない）。
 * - 1ページに収まらないほど大きい質問だけは、選択肢の行の切れ目でページを分ける（最後の手段）。
 * - 長文記述の記入欄は、1ページに収まる高さまでにする（記入欄の途中でページを分けない）。
 */

export const PT = 25.4 / 72; // 1pt = 0.3528mm

export type Prim =
  | { k: "text"; x: number; y: number; size: number; text: string; bold?: boolean; color: string; anchor?: "start" | "middle" | "end" }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; w: number; color: string; dash?: boolean }
  | { k: "rect"; x: number; y: number; w: number; h: number; stroke?: string; fill?: string; lw?: number; r?: number }
  | { k: "circle"; cx: number; cy: number; r: number; stroke: string; lw: number }
  | { k: "star"; cx: number; cy: number; r: number; stroke: string; lw: number };

/** 用紙の上で、各質問が置かれた場所（プレビューで質問を押して編集するため・編集中の質問を目立たせるため） */
export interface Region {
  id: string;
  page: number;
  y: number;
  h: number;
}

export interface LaidOutSurvey {
  width: number;
  height: number;
  pages: Prim[][];
  regions: Region[];
}

/** 文字の幅（mm）を返す。プレビューでは画面のフォント、PDF では埋め込むフォントで測る */
export type Measure = (text: string, sizePt: number) => number;

const INK = "#1f1f24";
const MUTED = "#5a5a64";
const RULE = "#55555f";
const FAINT = "#b9b9c2";

interface Row {
  h: number;
  draw: (y: number) => Prim[];
}

interface Block {
  rows: Row[];
  /** 質問の ID（ヘッダーは無し） */
  id?: string;
  /** 次のまとまりと同じページに置く（セクションの見出し・ヘッダー） */
  keepWithNext?: boolean;
}

function lineHeight(sizePt: number) {
  return sizePt * PT * 1.6;
}

/** 行の上端から、文字の基準線（ベースライン）までの距離 */
function baseline(sizePt: number) {
  const em = sizePt * PT;
  return (lineHeight(sizePt) - em) / 2 + em * 0.86;
}

/** 行の頭に来てはいけない文字（禁則） */
const NO_LINE_START = "、。，．）」』】〕〉》！？・ー…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ)]}!?,.:;";

/** 日本語は1文字ずつ幅を測って折り返す（行の頭に「、」「。」などが来ないようにする） */
export function wrapText(text: string, sizePt: number, maxW: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (para === "") {
      out.push("");
      continue;
    }
    let cur = "";
    for (const ch of Array.from(para)) {
      const cand = cur + ch;
      if (cur !== "" && measure(cand, sizePt) > maxW) {
        if (NO_LINE_START.includes(ch)) {
          // 禁則の文字は、前の行の終わりにぶら下げる（少しはみ出しても、行の頭には置かない）
          cur = cand;
          continue;
        }
        out.push(cur);
        cur = ch;
      } else cur = cand;
    }
    if (cur !== "") out.push(cur);
  }
  return out.length ? out : [""];
}

interface Ctx {
  survey: Survey;
  measure: Measure;
  x0: number;
  W: number;
  top: number;
  bottom: number;
  fs: number;
  lh: number;
  accent: string;
}

function textRow(c: Ctx, lines: string[], opts: { x: number; size: number; bold?: boolean; color?: string; align?: "left" | "center"; width?: number }): Row {
  const lh = lineHeight(opts.size);
  return {
    h: lines.length * lh,
    draw: (y) =>
      lines.map((t, i) => ({
        k: "text" as const,
        x: opts.align === "center" ? opts.x + (opts.width ?? c.W) / 2 : opts.x,
        y: y + i * lh + baseline(opts.size),
        size: opts.size,
        text: t,
        bold: opts.bold,
        color: opts.color ?? INK,
        anchor: opts.align === "center" ? ("middle" as const) : ("start" as const),
      })),
  };
}

function gapRow(h: number): Row {
  return { h, draw: () => [] };
}

// ---------------------------------------------------------------------------
// ヘッダー（タイトル・説明・記入欄・案内）
// ---------------------------------------------------------------------------

function headerBlock(c: Ctx): Block {
  const s = c.survey;
  const d = s.design;
  const rows: Row[] = [];
  if (s.title.trim()) {
    const lines = wrapText(s.title, d.titleSize, c.W, c.measure);
    rows.push(textRow(c, lines, { x: c.x0, size: d.titleSize, bold: true, align: d.titleAlign }));
    // タイトルの下の飾り線（テンプレートの色）
    rows.push({
      h: 3.5,
      draw: (y) => {
        if (d.headingStyle === "plain") return [];
        if (d.titleAlign === "center") {
          const w = Math.min(c.W, Math.max(40, Math.max(...lines.map((l) => c.measure(l, d.titleSize))) + 10));
          return [{ k: "line", x1: c.x0 + (c.W - w) / 2, y1: y + 1.4, x2: c.x0 + (c.W + w) / 2, y2: y + 1.4, w: 0.6, color: c.accent }];
        }
        return [{ k: "line", x1: c.x0, y1: y + 1.4, x2: c.x0 + c.W, y2: y + 1.4, w: 0.8, color: c.accent }];
      },
    });
  }
  if (s.description.trim()) {
    rows.push(gapRow(1));
    rows.push(textRow(c, wrapText(s.description, c.fs, c.W, c.measure), { x: c.x0, size: c.fs, color: INK }));
  }
  const fields = s.fields.filter((f) => f.enabled && f.label.trim());
  if (fields.length) {
    rows.push(gapRow(2.5));
    const perRow = d.orientation === "landscape" ? 3 : 2;
    const colGap = 6;
    const colW = (c.W - colGap * (perRow - 1)) / perRow;
    const h = c.lh * 1.9 * Math.max(0.8, d.answerScale);
    for (let i = 0; i < fields.length; i += perRow) {
      const chunk = fields.slice(i, i + perRow);
      rows.push({
        h,
        draw: (y) =>
          chunk.flatMap((f, j) => {
            const x = c.x0 + j * (colW + colGap);
            const label = `${f.label}：`;
            const by = y + h - c.lh * 0.35;
            return [
              { k: "text" as const, x, y: by - 1.2, size: c.fs, text: label, color: INK },
              { k: "line" as const, x1: x + Math.min(colW * 0.6, c.measure(label, c.fs) + 1), y1: by, x2: x + colW, y2: by, w: 0.3, color: RULE },
            ];
          }),
      });
    }
  }
  const boxLines: { text: string; color: string }[] = [];
  const pad = 3;
  const innerW = c.W - pad * 2;
  if (s.guide.trim()) for (const l of wrapText(s.guide, c.fs * 0.95, innerW, c.measure)) boxLines.push({ text: l, color: INK });
  if (s.notes.trim()) for (const l of wrapText(`※ ${s.notes}`, c.fs * 0.9, innerW, c.measure)) boxLines.push({ text: l, color: MUTED });
  if (boxLines.length) {
    rows.push(gapRow(3));
    const lhs = lineHeight(c.fs * 0.95);
    const h = boxLines.length * lhs + pad * 1.4;
    rows.push({
      h,
      draw: (y) => [
        { k: "rect", x: c.x0, y, w: c.W, h, fill: "#f4f4f6", stroke: "#d6d6dc", lw: 0.25, r: 1.5 },
        ...boxLines.map((l, i) => ({
          k: "text" as const,
          x: c.x0 + pad,
          y: y + pad * 0.7 + i * lhs + baseline(c.fs * 0.95),
          size: l.color === MUTED ? c.fs * 0.9 : c.fs * 0.95,
          text: l.text,
          color: l.color,
        })),
      ],
    });
  }
  return { rows, keepWithNext: true };
}

// ---------------------------------------------------------------------------
// 質問
// ---------------------------------------------------------------------------

function symbolPrims(kind: "circle" | "square", x: number, cy: number, c: Ctx): Prim[] {
  const em = c.fs * PT;
  if (kind === "circle") return [{ k: "circle", cx: x + em * 0.45, cy, r: em * 0.42, stroke: INK, lw: 0.3 }];
  const s = em * 0.8;
  return [{ k: "rect", x: x + em * 0.45 - s / 2, y: cy - s / 2, w: s, h: s, stroke: INK, lw: 0.3 }];
}

function choiceRows(c: Ctx, q: Question, ind: number): Row[] {
  const kind = q.type === "multiple" ? "square" : "circle";
  const em = c.fs * PT;
  const symW = em * 1.4;
  const avail = c.W - ind;
  const items = q.options.filter((o) => o.trim() !== "");
  const otherLabel = "その他（";
  const otherW = Math.min(avail - symW, Math.max(55, avail * 0.45));
  const rows: Row[] = [];
  const cyOf = (y: number) => y + baseline(c.fs) - em * 0.32;

  if (q.direction === "horizontal") {
    // 横に並べる：入りきらないところで次の行へ。1つが長すぎるときは、その選択肢だけ1行にする
    type Item = { w: number; draw: (x: number, y: number) => Prim[] };
    const flow: Item[] = items.map((t) => {
      const tw = c.measure(t, c.fs);
      return {
        w: symW + tw,
        draw: (x, y) => [...symbolPrims(kind, x, cyOf(y), c), { k: "text", x: x + symW, y: y + baseline(c.fs), size: c.fs, text: t, color: INK }],
      };
    });
    if (q.other) {
      flow.push({
        w: symW + otherW,
        draw: (x, y) => otherPrims(c, kind, x, y, otherW, symW, otherLabel, cyOf),
      });
    }
    const gap = em * 2;
    let line: Item[] = [];
    let used = 0;
    const flush = () => {
      if (!line.length) return;
      const items2 = line;
      rows.push({
        h: c.lh * 1.15,
        draw: (y) => {
          let x = c.x0 + ind;
          const out: Prim[] = [];
          for (const it of items2) {
            out.push(...it.draw(x, y));
            x += it.w + gap;
          }
          return out;
        },
      });
      line = [];
      used = 0;
    };
    for (const it of flow) {
      if (it.w > avail) {
        flush();
        // 長い選択肢は、縦並びと同じく折り返して1行に
        rows.push(...verticalChoice(c, kind, ind, symW, items[flow.indexOf(it)] ?? "", cyOf));
        continue;
      }
      if (line.length && used + gap + it.w > avail) flush();
      used += (line.length ? gap : 0) + it.w;
      line.push(it);
    }
    flush();
    return rows;
  }
  for (const t of items) rows.push(...verticalChoice(c, kind, ind, symW, t, cyOf));
  if (q.other) {
    rows.push({ h: c.lh * 1.25, draw: (y) => otherPrims(c, kind, c.x0 + ind, y, otherW, symW, otherLabel, cyOf) });
  }
  return rows;
}

function verticalChoice(c: Ctx, kind: "circle" | "square", ind: number, symW: number, t: string, cyOf: (y: number) => number): Row[] {
  const lines = wrapText(t, c.fs, c.W - ind - symW, c.measure);
  return [
    {
      h: lines.length * c.lh + c.lh * 0.15,
      draw: (y) => [
        ...symbolPrims(kind, c.x0 + ind, cyOf(y), c),
        ...lines.map((l, i) => ({ k: "text" as const, x: c.x0 + ind + symW, y: y + i * c.lh + baseline(c.fs), size: c.fs, text: l, color: INK })),
      ],
    },
  ];
}

function otherPrims(c: Ctx, kind: "circle" | "square", x: number, y: number, w: number, symW: number, label: string, cyOf: (y: number) => number): Prim[] {
  const lw = c.measure(label, c.fs);
  const end = x + symW + w;
  const by = y + baseline(c.fs) + 1;
  return [
    ...symbolPrims(kind, x, cyOf(y), c),
    { k: "text", x: x + symW, y: y + baseline(c.fs), size: c.fs, text: label, color: INK },
    { k: "line", x1: x + symW + lw, y1: by, x2: end - c.measure("）", c.fs), y2: by, w: 0.25, color: RULE },
    { k: "text", x: end, y: y + baseline(c.fs), size: c.fs, text: "）", color: INK, anchor: "end" },
  ];
}

function answerRows(c: Ctx, q: Question, ind: number): Row[] {
  const d = c.survey.design;
  const avail = c.W - ind;
  const x = c.x0 + ind;
  const em = c.fs * PT;
  const widthOf = (w: Question["width"]) => (w === "short" ? Math.min(avail, 40) : w === "medium" ? Math.min(avail, avail * 0.6) : avail);
  switch (q.type) {
    case "single":
    case "multiple":
      return choiceRows(c, q, ind);
    case "short": {
      const h = c.lh * 1.7 * d.answerScale;
      const w = widthOf(q.width);
      return [{ h, draw: (y) => [{ k: "line", x1: x, y1: y + h - 1, x2: x + w, y2: y + h - 1, w: 0.3, color: RULE }] }];
    }
    case "long": {
      const step = c.lh * 1.35 * d.answerScale;
      const maxH = c.bottom - c.top - c.lh * 4;
      const h = Math.max(step * 1.5, Math.min(maxH, q.lines * step + 2));
      const n = Math.max(1, Math.floor((h - 2) / step));
      return [
        {
          h: h + 1,
          draw: (y) => {
            const out: Prim[] = [{ k: "rect", x, y: y + 0.5, w: avail, h, stroke: RULE, lw: 0.3, r: 0.8 }];
            if (d.ruledLines) for (let i = 1; i < n; i++) out.push({ k: "line", x1: x + 2, y1: y + 0.5 + i * step + 1, x2: x + avail - 2, y2: y + 0.5 + i * step + 1, w: 0.2, color: FAINT, dash: true });
            return out;
          },
        },
      ];
    }
    case "rating": {
      const n = q.ratingMax;
      const r = q.ratingStyle === "star" ? em * 1.0 : em * 0.85;
      const step = r * 2 + em * (q.ratingStyle === "star" ? 1.2 : 1.6);
      const low = q.ratingLow.trim();
      const high = q.ratingHigh.trim();
      const lowW = low ? c.measure(low, c.fs * 0.9) + em : 0;
      const highW = high ? c.measure(high, c.fs * 0.9) + em : 0;
      const itemsW = n * step - (step - r * 2);
      const oneLine = lowW + itemsW + highW <= avail;
      const h = r * 2 + 3;
      const draw = (y: number, sx: number): Prim[] => {
        const out: Prim[] = [];
        const cy = y + h / 2;
        for (let i = 0; i < n; i++) {
          const cx = sx + r + i * step;
          if (q.ratingStyle === "star") out.push({ k: "star", cx, cy, r, stroke: INK, lw: 0.3 });
          else {
            out.push({ k: "circle", cx, cy, r, stroke: INK, lw: 0.3 });
            out.push({ k: "text", x: cx, y: cy + c.fs * 0.9 * PT * 0.35, size: c.fs * 0.9, text: String(i + 1), color: INK, anchor: "middle" });
          }
        }
        return out;
      };
      if (oneLine) {
        return [
          {
            h,
            draw: (y) => [
              ...(low ? [{ k: "text" as const, x, y: y + h / 2 + c.fs * 0.9 * PT * 0.35, size: c.fs * 0.9, text: low, color: MUTED }] : []),
              ...draw(y, x + lowW),
              ...(high ? [{ k: "text" as const, x: x + lowW + itemsW + em, y: y + h / 2 + c.fs * 0.9 * PT * 0.35, size: c.fs * 0.9, text: high, color: MUTED }] : []),
            ],
          },
        ];
      }
      const rows: Row[] = [];
      if (low || high) rows.push(textRow(c, [`${low || "低い"} ← → ${high || "高い"}`], { x, size: c.fs * 0.9, color: MUTED }));
      rows.push({ h, draw: (y) => draw(y, x) });
      return rows;
    }
    case "scale": {
      const steps = q.scale.filter((s) => s.trim() !== "");
      if (steps.length === 0) return [];
      const colW = Math.min(30, avail / steps.length);
      if (colW < 15) {
        // 横に並べる幅がないときは、縦に並べる
        return choiceRows(c, { ...q, type: "single", options: steps, other: false, direction: "vertical" }, ind);
      }
      const size = c.fs * 0.9;
      const lhs = lineHeight(size);
      const labels = steps.map((s) => wrapText(s, size, colW - 1.5, c.measure));
      const maxLines = Math.max(...labels.map((l) => l.length));
      const r = em * 0.48;
      const h = maxLines * lhs + r * 2 + 3;
      return [
        {
          h,
          draw: (y) =>
            labels.flatMap((ls, i) => {
              const cx = x + colW * i + colW / 2;
              return [
                ...ls.map((l, j) => ({ k: "text" as const, x: cx, y: y + (maxLines - ls.length + j) * lhs + baseline(size), size, text: l, color: INK, anchor: "middle" as const })),
                { k: "circle" as const, cx, cy: y + maxLines * lhs + r + 1.5, r, stroke: INK, lw: 0.3 },
              ];
            }),
        },
      ];
    }
    case "number": {
      const bw = q.width === "full" ? Math.min(avail * 0.6, 90) : q.width === "medium" ? 55 : 32;
      const h = c.lh * 1.5 * d.answerScale;
      return [
        {
          h: h + 1,
          draw: (y) => [
            { k: "rect", x, y: y + 0.5, w: bw, h, stroke: RULE, lw: 0.3, r: 0.6 },
            ...(q.unit.trim() ? [{ k: "text" as const, x: x + bw + em * 0.6, y: y + 0.5 + h / 2 + em * 0.35, size: c.fs, text: q.unit, color: INK }] : []),
          ],
        },
      ];
    }
    case "date": {
      const h = c.lh * 1.6 * d.answerScale;
      const parts: { label?: string; blank?: number }[] =
        q.dateStyle === "wareki"
          ? [{ blank: 14 }, { label: "年" }, { blank: 12 }, { label: "月" }, { blank: 12 }, { label: "日" }, { label: "（元号：" }, { blank: 14 }, { label: "）" }]
          : [{ blank: 20 }, { label: "年" }, { blank: 12 }, { label: "月" }, { blank: 12 }, { label: "日" }];
      return [
        {
          h,
          draw: (y) => {
            const out: Prim[] = [];
            let cx = x;
            const by = y + h - c.lh * 0.35;
            for (const p of parts) {
              if (p.blank) {
                out.push({ k: "line", x1: cx, y1: by + 0.8, x2: cx + p.blank, y2: by + 0.8, w: 0.3, color: RULE });
                cx += p.blank + 0.8;
              } else if (p.label) {
                out.push({ k: "text", x: cx, y: by, size: c.fs, text: p.label, color: INK });
                cx += c.measure(p.label, c.fs) + 1.2;
              }
            }
            return out;
          },
        },
      ];
    }
    case "section":
      return [];
  }
}

function sectionBlock(c: Ctx, q: Question): Block {
  const d = c.survey.design;
  const size = c.fs * 1.2;
  const lhs = lineHeight(size);
  const title = q.title.trim() || "セクション";
  const pad = d.headingStyle === "bar" || d.headingStyle === "box" ? 2.2 : 0;
  const lines = wrapText(title, size, c.W - pad * 2 - 2, c.measure);
  const h = lines.length * lhs + pad * 2 + (d.headingStyle === "underline" ? 1.5 : 0);
  const rows: Row[] = [
    {
      h,
      draw: (y) => {
        const out: Prim[] = [];
        const textColor = d.headingStyle === "bar" ? "#ffffff" : d.headingStyle === "plain" ? INK : c.accent;
        if (d.headingStyle === "bar") out.push({ k: "rect", x: c.x0, y, w: c.W, h, fill: c.accent, r: 1 });
        if (d.headingStyle === "box") out.push({ k: "rect", x: c.x0, y, w: c.W, h, stroke: c.accent, lw: 0.5, r: 1 });
        if (d.headingStyle === "underline") out.push({ k: "line", x1: c.x0, y1: y + h - 0.6, x2: c.x0 + c.W, y2: y + h - 0.6, w: 0.6, color: c.accent });
        lines.forEach((l, i) =>
          out.push({ k: "text", x: c.x0 + pad + (pad ? 1 : 0), y: y + pad + i * lhs + baseline(size), size, text: l, bold: true, color: textColor }),
        );
        return out;
      },
    },
  ];
  if (q.description.trim()) {
    rows.push(gapRow(1.2));
    rows.push(textRow(c, wrapText(q.description, c.fs * 0.95, c.W, c.measure), { x: c.x0, size: c.fs * 0.95, color: MUTED }));
  }
  return { rows, keepWithNext: true };
}

function questionBlock(c: Ctx, q: Question, no: number): Block {
  const d = c.survey.design;
  const em = c.fs * PT;
  const num = d.numbering ? `Q${no}` : "";
  const numW = num ? c.measure(num, c.fs) + em * 0.6 : 0;
  const req = d.showRequired && q.required ? "必須" : "";
  const reqSize = c.fs * 0.75;
  const reqW = req ? c.measure(req, reqSize) + 2.4 : 0;
  const prefix = numW + (req ? reqW + em * 0.4 : 0);
  const title = q.title.trim() || "（質問文）";
  const lines = wrapText(title, c.fs, c.W - prefix, c.measure);
  const ind = Math.max(numW, em * 1.2);
  const rows: Row[] = [
    {
      h: lines.length * c.lh,
      draw: (y) => {
        const out: Prim[] = [];
        if (num) out.push({ k: "text", x: c.x0, y: y + baseline(c.fs), size: c.fs, text: num, bold: true, color: d.headingStyle === "plain" ? INK : c.accent });
        if (req) {
          const bx = c.x0 + numW;
          const bh = reqSize * PT * 1.35;
          const by = y + baseline(c.fs) - em * 0.36 - bh / 2;
          out.push({ k: "rect", x: bx, y: by, w: reqW, h: bh, stroke: "#c62828", lw: 0.3, r: 0.6 });
          out.push({ k: "text", x: bx + reqW / 2, y: by + bh / 2 + reqSize * PT * 0.36, size: reqSize, text: req, color: "#c62828", anchor: "middle" });
        }
        lines.forEach((l, i) => out.push({ k: "text", x: c.x0 + prefix, y: y + i * c.lh + baseline(c.fs), size: c.fs, text: l, bold: true, color: INK }));
        return out;
      },
    },
  ];
  if (q.description.trim()) {
    rows.push(textRow(c, wrapText(q.description, c.fs * 0.9, c.W - ind, c.measure), { x: c.x0 + ind, size: c.fs * 0.9, color: MUTED }));
  }
  const answers = answerRows(c, q, ind);
  if (answers.length) {
    rows.push(gapRow(1.2));
    rows.push(...answers);
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// ページ分け
// ---------------------------------------------------------------------------

export function layoutSurvey(survey: Survey, measure: Measure): LaidOutSurvey {
  const d = survey.design;
  const portrait = d.orientation === "portrait";
  const width = portrait ? 210 : 297;
  const height = portrait ? 297 : 210;
  const m = d.margin;
  const c: Ctx = {
    survey,
    measure,
    x0: m,
    W: width - m * 2,
    top: m,
    bottom: height - m,
    fs: d.fontSize,
    lh: lineHeight(d.fontSize),
    accent: d.accent,
  };

  const blocks: Block[] = [];
  const header = headerBlock(c);
  if (header.rows.length) blocks.push(header);
  let no = 0;
  for (const q of survey.questions) {
    if (q.type === "section") blocks.push({ ...sectionBlock(c, q), id: q.id });
    else blocks.push({ ...questionBlock(c, q, ++no), id: q.id });
  }

  const pages: Prim[][] = [[]];
  const regions: Region[] = [];
  let y = c.top;
  let firstOnPage = true;
  const newPage = () => {
    pages.push([]);
    y = c.top;
    firstOnPage = true;
  };
  const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.h, 0);

  blocks.forEach((b, i) => {
    const total = sum(b.rows);
    const gap = firstOnPage ? 0 : d.spacing;
    // 見出しは、次のまとまりの頭と一緒に置けるか（置けないときは、見出しから次のページへ）
    // 質問はページの途中で分けないので、見出しのあとの質問は、まるごと同じページに置けるかで判断する
    const area = c.bottom - c.top;
    let need = total;
    for (let j = i; blocks[j]?.keepWithNext && j + 1 < blocks.length; j++) need += d.spacing + Math.min(sum(blocks[j + 1].rows), area);
    if (!firstOnPage && y + gap + Math.min(need, area) > c.bottom) newPage();
    else y += gap;
    let regionStart = { page: pages.length - 1, y };
    const closeRegion = () => {
      if (b.id) regions.push({ id: b.id, page: regionStart.page, y: regionStart.y, h: y - regionStart.y });
    };
    if (y + total <= c.bottom) {
      for (const r of b.rows) {
        pages[pages.length - 1].push(...r.draw(y));
        y += r.h;
      }
    } else {
      // 1ページに収まらないほど大きい質問：行の切れ目でページを分ける（最後の手段）
      for (const r of b.rows) {
        if (y + r.h > c.bottom && y > c.top) {
          closeRegion();
          newPage();
          regionStart = { page: pages.length - 1, y };
        }
        pages[pages.length - 1].push(...r.draw(y));
        y += r.h;
      }
    }
    closeRegion();
    firstOnPage = false;
  });

  if (d.pageNumbers) {
    const n = pages.length;
    pages.forEach((p, i) => {
      p.push({ k: "text", x: width / 2, y: height - Math.max(5, m / 2) + d.fontSize * 0.85 * PT * 0.35, size: d.fontSize * 0.85, text: `${i + 1} / ${n}`, color: MUTED, anchor: "middle" });
    });
  }
  return { width, height, pages, regions };
}

/** 等幅の近似で幅を測る（テスト・フォントの読み込み前の仮の配置に使う） */
export const approxMeasure: Measure = (text, sizePt) => {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += code < 0x2000 ? (/[A-Z0-9]/.test(ch) ? 0.62 : /[il.,:;'|!]/.test(ch) ? 0.28 : 0.52) : code >= 0xff61 && code <= 0xff9f ? 0.5 : 1;
  }
  return w * sizePt * PT;
};

/** 星の頂点（中心 cx,cy・外側の半径 r）。SVG・PDF の両方で使う */
export function starPoints(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  const inner = r * 0.45;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : inner;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return pts;
}
