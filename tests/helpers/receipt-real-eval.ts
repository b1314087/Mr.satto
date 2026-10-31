import { parseCsv } from "@/lib/utils/csv";
import type { FieldName, Outcome } from "./receipt-eval";
import { FIELDS } from "./receipt-eval";

/**
 * 実物の領収書・レシートで、抽出の精度を測るための、純粋な関数（工程12）。
 *
 * 【重要】このファイルは、実物の領収書の評価を行うための「道具」だけを用意するもので、実物での評価を行った結果ではない。
 * 実物の評価は、利用者が自分の領収書（個人情報に注意）で実行して、はじめて行われる。
 *
 * 個人情報の扱い：
 * - このファイルとテストに、実物の取引先名・金額・ファイル名は書かない（テストの値はすべて架空）。
 * - 集計（summarize/format）は、件数だけを出し、取引先名・日付・金額・ファイル名を含めない。そのまま共有・報告書に載せてよい形にする。
 */

export { FIELDS };
export type { FieldName, Outcome };

/** 正解表（truth.csv）の1行。date は YYYY-MM-DD、total は整数の円。書類にその項目がなければ null */
export interface TruthEntry {
  /** truth.csv の行番号（見出しを1行目として数えた番号。集計・詳細で、ファイル名の代わりに使う） */
  rowNumber: number;
  file: string;
  date: string | null;
  vendor: string | null;
  total: number | null;
}

export const TRUTH_HEADER = ["file", "date", "vendor", "total"] as const;

export interface TruthParseResult {
  entries: TruthEntry[];
  errors: string[];
}

/**
 * 正解表（CSV）を読む。見出しは file,date,vendor,total。
 * date：空、または YYYY-MM-DD（実在する日付）。vendor：空でもよい。total：空、または1以上の整数（カンマ・円記号なし）。
 * file は、フォルダ名を含まないファイル名だけ（上位のフォルダへ出る指定を防ぐ）。
 */
export function parseTruthCsv(text: string): TruthParseResult {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  const errors: string[] = [];
  const entries: TruthEntry[] = [];
  if (rows.length === 0) return { entries, errors: ["正解表が空です。"] };
  const header = rows[0].map((h) => h.trim());
  if (header.join(",") !== TRUTH_HEADER.join(",")) {
    return { entries, errors: [`1行目の見出しは「${TRUTH_HEADER.join(",")}」にしてください。`] };
  }
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const rowNumber = i + 2;
    if (r.length !== 4) {
      errors.push(`${rowNumber}行目：列の数が4つではありません。`);
      return;
    }
    const [file, date, vendor, total] = r.map((c) => c.trim());
    if (file === "" || /[\\/]/.test(file) || file === "." || file === ".." || file.includes("\0")) {
      errors.push(`${rowNumber}行目：fileは、フォルダを含まないファイル名だけにしてください。`);
      return;
    }
    if (seen.has(file)) {
      errors.push(`${rowNumber}行目：同じファイル名が2回あります。`);
      return;
    }
    seen.add(file);
    let dateValue: string | null = null;
    if (date !== "") {
      const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
      if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
        errors.push(`${rowNumber}行目：dateは、空か、実在する日付の YYYY-MM-DD 形式にしてください。`);
        return;
      }
      dateValue = date;
    }
    let totalValue: number | null = null;
    if (total !== "") {
      if (!/^[1-9]\d{0,9}$/.test(total)) {
        errors.push(`${rowNumber}行目：totalは、空か、1以上の整数（カンマ・円記号なし）にしてください。`);
        return;
      }
      totalValue = Number(total);
    }
    entries.push({ rowNumber, file, date: dateValue, vendor: vendor === "" ? null : vendor, total: totalValue });
  });
  return { entries, errors };
}

const normVendor = (v: string) => v.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const digitsOnly = (v: string) => v.normalize("NFKC").replace(/\D/g, "");

/**
 * 画面の表示から、1項目の結果を判定する。
 * @param value 入力欄の値（日付は YYYY-MM-DD、金額は数字、取引先は文字。空欄は ""）
 * @param candidates 画面に出ていた候補の文字（日付「2026/09/15」、金額「1,320円」など。表示のまま）
 * @param truth 正解（書類にその項目がなければ null）
 */
export function judgeFromUi(field: FieldName, value: string, candidates: string[], truth: string | null): Outcome {
  const same = (a: string, b: string) => (field === "vendor" ? normVendor(a) === normVendor(b) : digitsOnly(a) === digitsOnly(b) && digitsOnly(a) !== "");
  const auto = value.trim() !== "";
  if (truth === null) return auto ? "auto-wrong" : "blank-absent";
  if (auto) return same(value, truth) ? "auto-correct" : "auto-wrong";
  return candidates.some((c) => same(c, truth)) ? "blank-hit" : "blank-miss";
}

/** 利用者が手で直す必要があったか（自動入力の誤り、または、空欄で正解が出ていない／候補から選ぶ必要がある） */
export function needsManualFix(outcome: Outcome): boolean {
  return outcome === "auto-wrong" || outcome === "blank-hit" || outcome === "blank-miss";
}

/** 1書類の結果（個人情報を含まない。取引先名・日付・金額・ファイル名は持たない） */
export interface RealDocResult {
  /** 正解表の行番号 */
  rowNumber: number;
  /** 読み取りに失敗した（ファイルを読めなかった）。失敗のとき outcomes は無い */
  failed: boolean;
  /** 1つのファイルから、複数の行（PDFの複数ページなど）ができた場合は、評価の対象外 */
  rows: number;
  outcomes?: Record<FieldName, Outcome>;
  /** 値が「文字の認識に自信が低い行から読み取った値」と表示されたか */
  lowConfidence?: Record<FieldName, boolean>;
  ms: number;
}

export interface RealSummary {
  documents: number;
  failed: number;
  /** 1ファイルから複数の行ができたため、評価に含めなかった数 */
  excludedMultiRow: number;
  evaluated: number;
  perField: Record<FieldName, Record<Outcome, number>>;
  /** 項目ごとの「手直しが必要だった書類の数」 */
  manualFix: Record<FieldName, number>;
  /** 自動入力された項目のうち、低信頼の表示が出ていたものの内訳 */
  lowConfidenceAuto: Record<FieldName, { correct: number; wrong: number }>;
  /** 自動入力された項目のうち、低信頼の表示が出ていなかったものの内訳 */
  normalConfidenceAuto: Record<FieldName, { correct: number; wrong: number }>;
  /** 日付・取引先・合計金額のどれか1つでも自動入力が誤っていた書類の数 */
  docsWithAnyWrongAuto: number;
  /** 3項目すべてが、自動入力で正解、または書類に無くて空欄（手直し不要）だった書類の数 */
  docsFullyClean: number;
  averageMs: number;
}

const zeroOutcomes = (): Record<Outcome, number> => ({ "auto-correct": 0, "auto-wrong": 0, "blank-hit": 0, "blank-miss": 0, "blank-absent": 0 });

export function summarizeReal(results: RealDocResult[]): RealSummary {
  const perField = {} as RealSummary["perField"];
  const manualFix = {} as RealSummary["manualFix"];
  const lowConfidenceAuto = {} as RealSummary["lowConfidenceAuto"];
  const normalConfidenceAuto = {} as RealSummary["normalConfidenceAuto"];
  for (const f of FIELDS) {
    perField[f] = zeroOutcomes();
    manualFix[f] = 0;
    lowConfidenceAuto[f] = { correct: 0, wrong: 0 };
    normalConfidenceAuto[f] = { correct: 0, wrong: 0 };
  }
  let failed = 0;
  let excluded = 0;
  let evaluated = 0;
  let anyWrong = 0;
  let clean = 0;
  let msSum = 0;
  for (const r of results) {
    msSum += r.ms;
    if (r.failed) {
      failed++;
      continue;
    }
    if (r.rows !== 1 || !r.outcomes) {
      excluded++;
      continue;
    }
    evaluated++;
    let wrong = false;
    let allClean = true;
    for (const f of FIELDS) {
      const o = r.outcomes[f];
      perField[f][o]++;
      if (needsManualFix(o)) {
        manualFix[f]++;
        allClean = false;
      }
      if (o === "auto-wrong") wrong = true;
      if (o === "auto-correct" || o === "auto-wrong") {
        const bucket = r.lowConfidence?.[f] ? lowConfidenceAuto[f] : normalConfidenceAuto[f];
        if (o === "auto-correct") bucket.correct++;
        else bucket.wrong++;
      }
    }
    if (wrong) anyWrong++;
    if (allClean) clean++;
  }
  return {
    documents: results.length,
    failed,
    excludedMultiRow: excluded,
    evaluated,
    perField,
    manualFix,
    lowConfidenceAuto,
    normalConfidenceAuto,
    docsWithAnyWrongAuto: anyWrong,
    docsFullyClean: clean,
    averageMs: results.length === 0 ? 0 : Math.round(msSum / results.length),
  };
}

const LABEL: Record<FieldName, string> = { date: "日付", vendor: "取引先", total: "合計金額" };

/** 集計をMarkdownにする。件数だけで、個人情報（取引先名・日付・金額・ファイル名）を含まない */
export function formatRealSummary(s: RealSummary): string {
  const pct = (a: number, b: number) => (b === 0 ? "-" : `${((a / b) * 100).toFixed(1)}%`);
  const rows = FIELDS.map((f) => {
    const o = s.perField[f];
    const auto = o["auto-correct"] + o["auto-wrong"];
    const clean = o["auto-correct"] + o["blank-absent"];
    return `| ${LABEL[f]} | ${o["auto-correct"]} | ${o["auto-wrong"]} | ${o["blank-hit"]} | ${o["blank-miss"]} | ${o["blank-absent"]} | ${pct(o["auto-correct"], auto)}（${o["auto-correct"]}/${auto}） | ${pct(clean, s.evaluated)} | ${s.manualFix[f]} |`;
  });
  const conf = FIELDS.map((f) => {
    const low = s.lowConfidenceAuto[f];
    const norm = s.normalConfidenceAuto[f];
    return `| ${LABEL[f]} | ${low.correct} | ${low.wrong} | ${norm.correct} | ${norm.wrong} |`;
  });
  return [
    "# 実物の領収書・レシートの評価結果（集計のみ。個人情報は含みません）",
    "",
    `- ファイル数：${s.documents}（読み取り失敗：${s.failed}、複数の行ができたため対象外：${s.excludedMultiRow}、評価した書類：${s.evaluated}）`,
    `- 自動入力が1つでも誤っていた書類：${s.docsWithAnyWrongAuto}件`,
    `- 3項目とも手直し不要だった書類：${s.docsFullyClean}件`,
    `- 1ファイルあたりの平均処理時間：${s.averageMs}ミリ秒`,
    "",
    "| 項目 | 自動入力・正解 | 自動入力・誤り | 空欄・候補に正解あり | 空欄・候補にも無し | 空欄・正しく空 | 自動入力の正解率 | 手直し不要の割合 | 手直しが必要だった書類 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "自動入力された値のうち、「文字の認識に自信が低い」表示が出ていたものと、出ていなかったものの内訳：",
    "",
    "| 項目 | 低信頼表示あり・正解 | 低信頼表示あり・誤り | 表示なし・正解 | 表示なし・誤り |",
    "|---|---|---|---|---|",
    ...conf,
    "",
    "注意：この結果は、この評価に使った書類だけについてのものです。ほかの書類の精度を保証するものではありません。",
  ].join("\n");
}
