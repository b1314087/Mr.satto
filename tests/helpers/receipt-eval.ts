import { extractReceipt } from "@/lib/accounting/receipt-extract";
import type { FieldExtraction } from "@/lib/accounting/receipt-types";
import type { CorpusCase } from "../fixtures/receipt-corpus";

/**
 * 合成コーパスに対する、抽出結果の集計（工程9）。実物の領収書の評価ではない。
 *
 * 1項目ごとの結果:
 * - auto-correct        自動入力され、正解と一致した
 * - auto-wrong          自動入力されたが、正解と違った（書類に無い項目を入れた場合を含む）← 最も重大
 * - blank-hit           自動入力されず、候補の中に正解があった（利用者が選べば直せる）
 * - blank-miss          自動入力されず、候補にも正解がなかった（利用者が入力する）
 * - blank-absent        書類にその項目がなく、自動入力もされなかった（正しい挙動）
 */
export type Outcome = "auto-correct" | "auto-wrong" | "blank-hit" | "blank-miss" | "blank-absent";
export type FieldName = "date" | "vendor" | "total";
export const FIELDS: FieldName[] = ["date", "vendor", "total"];

export const OUTCOMES: Outcome[] = ["auto-correct", "auto-wrong", "blank-hit", "blank-miss", "blank-absent"];

const norm = (v: string) => v.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function judge(field: FieldName, result: FieldExtraction, truth: string | null): Outcome {
  const same = (a: string, b: string) => (field === "vendor" ? norm(a) === norm(b) : a === b);
  if (truth === null) return result.value === null ? "blank-absent" : "auto-wrong";
  if (result.value !== null) return same(result.value, truth) ? "auto-correct" : "auto-wrong";
  return result.candidates.some((c) => same(c.value, truth)) ? "blank-hit" : "blank-miss";
}

export interface CaseResult {
  id: string;
  kind: string;
  outcomes: Record<FieldName, Outcome>;
  values: Record<FieldName, string | null>;
}

export function evaluateCorpus(corpus: CorpusCase[]): CaseResult[] {
  return corpus.map((c) => {
    const r = extractReceipt(c.lines.map((text) => ({ text, confidence: null })));
    const truth: Record<FieldName, string | null> = {
      date: c.truth.date,
      vendor: c.truth.vendor,
      total: c.truth.total === null ? null : String(c.truth.total),
    };
    return {
      id: c.id,
      kind: c.kind,
      outcomes: { date: judge("date", r.date, truth.date), vendor: judge("vendor", r.vendor, truth.vendor), total: judge("total", r.total, truth.total) },
      values: { date: r.date.value, vendor: r.vendor.value, total: r.total.value },
    };
  });
}

export function summarize(results: CaseResult[]): Record<FieldName, Record<Outcome, number>> {
  const out = {} as Record<FieldName, Record<Outcome, number>>;
  for (const f of FIELDS) {
    out[f] = { "auto-correct": 0, "auto-wrong": 0, "blank-hit": 0, "blank-miss": 0, "blank-absent": 0 };
    for (const r of results) out[f][r.outcomes[f]]++;
  }
  return out;
}

/** Markdown形式の表（報告書・ログ用） */
export function formatSummary(results: CaseResult[]): string {
  const s = summarize(results);
  const n = results.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;
  const label: Record<FieldName, string> = { date: "日付", vendor: "取引先", total: "合計金額" };
  const rows = FIELDS.map((f) => {
    const o = s[f];
    const auto = o["auto-correct"] + o["auto-wrong"];
    const autoAccuracy = auto === 0 ? "-" : `${((o["auto-correct"] / auto) * 100).toFixed(1)}%（${o["auto-correct"]}/${auto}）`;
    const done = o["auto-correct"] + o["blank-absent"];
    return `| ${label[f]} | ${o["auto-correct"]} | ${o["auto-wrong"]} | ${o["blank-hit"]} | ${o["blank-miss"]} | ${o["blank-absent"]} | ${autoAccuracy} | ${pct(done)} |`;
  });
  return [
    `評価対象 ${n}件（合成）`,
    "| 項目 | 自動入力・正解 | 自動入力・誤り | 空欄・候補に正解あり | 空欄・候補にも無し | 空欄・正しく空 | 自動入力の正解率 | 手直し不要の割合 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
