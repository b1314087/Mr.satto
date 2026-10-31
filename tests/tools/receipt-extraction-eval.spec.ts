import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { extractReceipt, extractTotal } from "@/lib/accounting/receipt-extract";
import { RECEIPT_CORPUS } from "../fixtures/receipt-corpus";
import { FIELDS, evaluateCorpus, formatSummary, summarize } from "../helpers/receipt-eval";

/**
 * 合成コーパス（実在しない書類を手で模したもの）に対する、日付・取引先・合計金額の抽出評価（工程9）。
 * 実物の領収書の評価ではない。最重要の確認は「誤った値を自動入力していないこと」。
 * 環境変数 RECEIPT_EVAL_OUT にファイルパスを指定すると、集計表と、各書類の結果をそのファイルに書き出す。
 */

test("receipt-extraction-eval: 合成コーパスで、日付・取引先・合計金額に誤った値を自動入力しない", () => {
  const results = evaluateCorpus(RECEIPT_CORPUS);
  const summary = summarize(results);

  const wrong = results.flatMap((r) => FIELDS.filter((f) => r.outcomes[f] === "auto-wrong").map((f) => `${r.id}:${f}=${r.values[f]}`));

  const out = process.env.RECEIPT_EVAL_OUT;
  if (out) {
    const detail = results
      .map((r) => `${r.id}\t${r.kind}\t${FIELDS.map((f) => `${f}:${r.outcomes[f]}`).join("\t")}`)
      .join("\n");
    fs.writeFileSync(out, `${formatSummary(results)}\n\n誤入力: ${wrong.join(", ") || "なし"}\n\n${detail}\n`, "utf8");
  }

  expect(RECEIPT_CORPUS.length).toBeGreaterThanOrEqual(80);
  expect(wrong, "誤った値が自動入力された書類").toEqual([]);
  expect(summary.total["auto-wrong"]).toBe(0);
});

test("receipt-extraction-eval: コーパスの書類IDは重複しない", () => {
  const ids = RECEIPT_CORPUS.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ---------------------------------------------------------------------------
// 乱れの注入（ファズ）：OCRで起きやすい金額の乱れを、決まった乱数で大量に作り、「誤った合計を自動入力しない」ことを確かめる。
// 数字そのものが別の数字に読み間違えられた場合（3→8 など）は、文字からは見分けられないため、対象外（利用者の確認で防ぐ）。
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOOKALIKE: Record<string, string[]> = { "0": ["O", "o", "D"], "1": ["l", "I", "i", "|"], "2": ["Z", "z"], "5": ["S", "s"], "6": ["G", "b"], "7": ["T"], "8": ["B"], "9": ["g", "q"] };

function mutateAmount(token: string, rand: () => number, kind: number): string {
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  switch (kind) {
    case 0: {
      // 桁の途中に空白を入れる
      const pos = 1 + Math.floor(rand() * (token.length - 1));
      return token.slice(0, pos) + " " + token.slice(pos);
    }
    case 1: {
      // 数字の1文字を、似た文字に置き換える
      const digitPositions = [...token].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
      const pos = pick(digitPositions);
      return token.slice(0, pos) + pick(LOOKALIKE[token[pos]] ?? ["?"]) + token.slice(pos + 1);
    }
    case 2:
      // 桁区切りの読み間違い
      return token.replace(",", pick([".", " ", ", ", " ,", "", "，", "'", "`", ";"]));
    case 3: {
      // 桁の一部が欠ける（末尾・先頭の数字が読めない）
      return rand() < 0.5 ? token.slice(0, -1) : token.slice(1);
    }
    default:
      return token;
  }
}

test("receipt-extraction-eval: 金額の乱れを大量に注入しても、誤った合計を自動入力しない（ファズ）", () => {
  const rand = mulberry32(20261031);
  const bases = RECEIPT_CORPUS.filter((c) => c.truth.total !== null && c.truth.total >= 1000 && c.lines.some((l) => /合計|お会計|ご請求額|ご利用金額|領収金額|お支払合計|TOTAL/.test(l)));
  expect(bases.length).toBeGreaterThanOrEqual(15);
  let trials = 0;
  const violations: string[] = [];
  for (const base of bases) {
    const truth = base.truth.total as number;
    const formatted = truth.toLocaleString("en-US"); // 1,320
    const lineIndex = base.lines.findIndex((l) => l.includes(formatted) && /合計|お会計|ご請求額|ご利用金額|領収金額|TOTAL/.test(l));
    if (lineIndex < 0) continue;
    for (let kind = 0; kind < 4; kind++) {
      for (let n = 0; n < 40; n++) {
        const mutated = mutateAmount(formatted, rand, kind);
        // 乱れのあとも、本来の金額と同じ文字列になってしまった場合は、乱れていない
        if (mutated === formatted) continue;
        // 円記号まわりの乱れ
        const yen = ["¥", "Y", "\\", "￥", "羊", "", "¥ "][Math.floor(rand() * 7)];
        const lines = base.lines.map((l, i) => (i === lineIndex ? l.replace(`¥${formatted}`, `${yen}${mutated}`).replace(formatted, mutated) : l));
        trials++;
        const value = extractTotal(lines.map((text) => ({ text, confidence: null }))).value;
        // 数字が欠けた結果が、たまたま別の正しそうな金額になる場合（先頭・末尾の欠落）は、文字からは検出できない
        const undetectable = kind === 3;
        if (value !== null && value !== String(truth) && !undetectable) violations.push(`${base.id}: 「${lines[lineIndex]}」 → ${value}`);
        // 欠落（kind 3）のうち、末尾が欠けて桁区切りの途中で途切れた形（「14,72」）のときは、自動入力されない。先頭の数字が欠けただけの場合（「4,720」）は、正しい金額に見えるため、文字からは検出できない
        if (undetectable && value !== null && value !== String(truth) && /[,.]\d{1,2}$/.test(mutated)) violations.push(`${base.id}（欠落）: 「${lines[lineIndex]}」 → ${value}`);
      }
    }
  }
  expect(trials).toBeGreaterThan(1500);
  expect(violations.slice(0, 20)).toEqual([]);
});

test("receipt-extraction-eval: 日付の乱れ（区切り・数字の誤読）を注入しても、誤った日付を自動入力しない（ファズ）", () => {
  const rand = mulberry32(20261101);
  const bases = RECEIPT_CORPUS.filter((c) => c.truth.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(c.truth.date));
  const violations: string[] = [];
  let trials = 0;
  for (const base of bases) {
    const [y, m, d] = (base.truth.date as string).split("-");
    const lineIndex = base.lines.findIndex((l) => l.includes(`${y}/${m}/${d}`) || l.includes(`${y}-${m}-${d}`) || l.includes(`${y}年${Number(m)}月${Number(d)}日`));
    if (lineIndex < 0) continue;
    for (let n = 0; n < 60; n++) {
      const letters = ["O", "l", "I", "S", "B"];
      const mutations = [
        `${y.slice(0, 2)}O${y.slice(3)}/${m}/${d}`, // 年の数字が文字に
        `${y}/${m.replace("0", "O")}/${d}`, // 月の数字が文字に
        `${y} ${m} ${d}`, // 区切りが空白だけ
        `${y}/${m}/${letters[Math.floor(rand() * letters.length)]}${d.slice(1)}`, // 日の数字が文字に
        `${y.slice(2)}/${m}/${d}`, // 年が2桁
        `${y}${m}${d}`, // 区切りがない
      ];
      const mutated = mutations[Math.floor(rand() * mutations.length)];
      const lines = base.lines.map((l, i) => (i === lineIndex ? mutated : l));
      trials++;
      const value = extractReceipt(lines.map((text) => ({ text, confidence: null }))).date.value;
      if (value !== null && value !== base.truth.date) violations.push(`${base.id}: 「${mutated}」 → ${value}`);
    }
  }
  expect(trials).toBeGreaterThan(1000);
  expect(violations.slice(0, 20)).toEqual([]);
});
