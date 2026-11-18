import { formatNumber, hexString, serializeValue, type ContentOperation, type ContentValue } from "./content-tokens";
import type { TextRun } from "./text-runs";

/**
 * 選んだ文字を、ページの描く命令から本当に取り除く（2026-11-18 文字を消す機能）。
 *
 * 文字を描く命令（Tj など）を「残す文字＋空ける幅＋残す文字」の TJ 命令に書き換える。
 * 消した文字のぶんは、文字を描かずに同じ幅だけ進める（TJ の数）ので、残りの文字の位置は1ptも動かない。
 * 消した文字のデータ（文字コード）は、書き換えたあとの命令に残らない。
 * 読み上げ用の文字（ActualText）を持つ囲み（BDC）があれば、その文字も消す（消した文字が読み上げ用の文字に残らないように）。
 */

export class TextEraseError extends Error {}

/** 消す文字：命令の番号ごとに、その命令の中の何文字目か */
export type EraseSelection = Map<number, Set<number>>;

export function eraseGlyphs(bytes: Uint8Array, ops: ContentOperation[], runs: TextRun[], selection: EraseSelection): Uint8Array {
  const runByOp = new Map(runs.map((r) => [r.opIndex, r]));
  const replacements: { start: number; end: number; text: string }[] = [];
  const markedToClean = new Set<number>();

  for (const [opIndex, glyphSet] of selection) {
    if (glyphSet.size === 0) continue;
    const run = runByOp.get(opIndex);
    const op = ops[opIndex];
    if (!run || !op || !run.erasable) throw new TextEraseError("この文字は消せません");
    const items: ContentValue[] =
      op.operator === "TJ" ? (op.operands[0]?.kind === "array" ? op.operands[0].items : []) : op.operator === '"' ? op.operands.slice(2, 3) : op.operands.slice(0, 1);

    const out: string[] = [];
    let pendingGap = 0;
    let glyphIndex = 0;
    const flushGap = () => {
      if (pendingGap !== 0) out.push(formatNumber(-pendingGap));
      pendingGap = 0;
    };
    for (const item of items) {
      if (item.kind === "number") {
        // もとの間隔の数は、そのまま（消した文字の空ける幅とまとめる）
        pendingGap += -item.value;
        continue;
      }
      if (item.kind !== "string") continue;
      let kept: number[] = [];
      const flushKept = () => {
        if (kept.length) {
          flushGap();
          out.push(hexString(Uint8Array.from(kept)));
        }
        kept = [];
      };
      let bp = 0;
      // この文字列に入っている文字の数（run.glyphs の並びを使う）
      while (bp < item.bytes.length) {
        const g = run.glyphs[glyphIndex];
        if (!g) throw new TextEraseError("文字の位置が合いません");
        const len = g.byteLen;
        const codeBytes = Array.from(item.bytes.subarray(bp, bp + len));
        bp += len;
        if (glyphSet.has(glyphIndex)) {
          flushKept();
          // 消した文字のぶん、同じ幅だけ進める（文字間隔・単語間隔も、文字の大きさで割って同じ単位にする）
          const wordSp = len === 1 && g.code === 32 ? run.wordSpacing : 0;
          pendingGap += g.width + (1000 * (run.charSpacing + wordSp)) / run.fontSize;
        } else {
          kept.push(...codeBytes);
        }
        glyphIndex++;
      }
      flushKept();
    }
    flushGap();
    if (glyphIndex !== run.glyphs.length) throw new TextEraseError("文字の位置が合いません");

    // ' と " は「次の行へ移る」も含むので、書き換えたあとも同じ動きになるよう、前に命令を足す
    let prefix = "";
    if (op.operator === "'") prefix = "T* ";
    if (op.operator === '"') prefix = `${formatNumber(numberOf(op.operands[0]))} Tw ${formatNumber(numberOf(op.operands[1]))} Tc T* `;
    replacements.push({ start: op.start, end: op.end, text: `${prefix}[${out.join(" ")}] TJ` });
    for (const m of run.enclosingMarkedContent) markedToClean.add(m);
  }

  // 読み上げ用の文字（ActualText）を、囲みの辞書から取り除く
  for (const m of markedToClean) {
    const op = ops[m];
    if (op.operator !== "BDC") continue;
    const dict = op.operands[1];
    if (!dict || dict.kind !== "dict" || !dict.entries.some((e) => e.key === "ActualText")) continue;
    const cleaned: ContentValue = { ...dict, entries: dict.entries.filter((e) => e.key !== "ActualText") };
    replacements.push({ start: op.start, end: op.end, text: `${serializeValue(op.operands[0])} ${serializeValue(cleaned)} BDC` });
  }

  replacements.sort((a, b) => a.start - b.start);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const r of replacements) {
    if (r.start < cursor) throw new TextEraseError("書き換える場所が重なっています");
    parts.push(bytes.subarray(cursor, r.start));
    parts.push(encoder.encode(r.text));
    cursor = r.end;
  }
  parts.push(bytes.subarray(cursor));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    result.set(part, p);
    p += part.length;
  }
  return result;
}

function numberOf(v: ContentValue | undefined): number {
  return v && v.kind === "number" ? v.value : 0;
}
