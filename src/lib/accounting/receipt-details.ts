import { compactCjkSpaces, normalizeLineText } from "./receipt-extract";
import type { TextLine } from "./receipt-types";

/**
 * 領収書・レシートの詳しい項目の読み取りと確認（工程4）。純粋な関数だけ（画面・通信に依存しない）。
 *
 * 読み取る項目：税率・消費税額・登録番号（適格請求書発行事業者の登録番号）・品目。
 * 利用者が入力する項目：摘要・税区分・借方勘定科目・貸方勘定科目（このツールは推測して入れない）。
 *
 * 方針（工程8から変えない）:
 * - 読み取れない・判断できない項目は空欄のまま（「不明」と表示する）。推測で埋めない。
 * - 税区分・勘定科目は、書類の内容から自動で決めない（初期値なし。利用者が行ごとに選ぶ・入力する）。
 * - 金額と税額が合わないときは、注意を表示する（直すかどうかは利用者が決める。自動では直さない）。
 */

/** 利用者が確認・編集する、詳しい項目（入力欄の文字そのまま） */
export interface ReceiptDetailValues {
  /** "10" | "8" | "mixed"（10%と8%の混在） | ""（不明） */
  taxRate: string;
  /** 消費税額（数字だけ。不明は空欄） */
  taxAmount: string;
  /** 登録番号（T＋13桁。不明は空欄） */
  registrationNumber: string;
  /** 品目（読み取れた品名を「、」でつないだもの） */
  items: string;
  /** 摘要（利用者が入力する） */
  memo: string;
  /** 税区分（利用者が選ぶ・入力する。初期値なし） */
  taxCategory: string;
  /** 借方勘定科目（利用者が入力する。初期値なし） */
  debitAccount: string;
  /** 貸方勘定科目（利用者が入力する。初期値なし） */
  creditAccount: string;
}

export const EMPTY_RECEIPT_DETAILS: ReceiptDetailValues = {
  taxRate: "",
  taxAmount: "",
  registrationNumber: "",
  items: "",
  memo: "",
  taxCategory: "",
  debitAccount: "",
  creditAccount: "",
};

/** 税率の選択肢（読み取った値の確認・修正用） */
export const TAX_RATE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "不明" },
  { value: "10", label: "10%" },
  { value: "8", label: "8%（軽減税率）" },
  { value: "mixed", label: "10%と8%の混在" },
];


/** 品目として読み取る品名の数の上限 */
const MAX_ITEMS = 5;
/** 文字の長さの上限（品目・摘要・勘定科目・税区分） */
export const RECEIPT_DETAIL_TEXT_MAX = 200;

function prepared(lines: readonly TextLine[]): string[] {
  return lines.map((l) => compactCjkSpaces(normalizeLineText(l.text))).filter((t) => t !== "");
}

/** 登録番号（T＋13桁）を探す。途中の空白・ハイフンは除いて読む。見つからない・複数あって決められないときは null */
export function extractRegistrationNumber(lines: readonly TextLine[]): string | null {
  const found = new Set<string>();
  for (const text of prepared(lines)) {
    const compact = text.replace(/[\s\-‐ー－―]/g, "");
    for (const m of compact.matchAll(/(?:^|[^A-Za-z0-9])T(\d{13})(?!\d)/g)) found.add(`T${m[1]}`);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** 税率（10%・8%・混在）を探す。見つからないときは null */
export function extractTaxRate(lines: readonly TextLine[]): "10" | "8" | "mixed" | null {
  let has10 = false;
  let has8 = false;
  for (const text of prepared(lines)) {
    if (/(^|[^\d.])10\s*%/.test(text)) has10 = true;
    if (/(^|[^\d.])8\s*%/.test(text) || /軽減税率/.test(text)) has8 = true;
  }
  if (has10 && has8) return "mixed";
  if (has10) return "10";
  if (has8) return "8";
  return null;
}

function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:¥\s*)?(\d{1,3}(?:,\d{3})+|\d+)\s*円?/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isSafeInteger(n)) out.push(n);
  }
  return out;
}

/**
 * 消費税額を探す。「消費税」「内税」「税額」などの行の金額を使う。
 * - 「消費税計」「税額合計」のような合計の行があれば、それを使う
 * - なければ、税率ごとの行（10%・8%）の金額を足す
 * - 税率の書かれていない税の行が複数あって決められないときは null（推測しない）
 * total（合計金額）が分かっているときは、合計金額以上の値は税額とみなさない
 */
export function extractTaxAmount(lines: readonly TextLine[], total: number | null): number | null {
  const candidates: { amount: number; isTotal: boolean; rate: "10" | "8" | null }[] = [];
  for (const text of prepared(lines)) {
    if (!/(消費税|内税|外税|税額|内消費税|\(税\)|（税）|税\s*等)/.test(text)) continue;
    // 「10%対象 ¥1,100」のような、税の対象額の行は除く（税額の行は「税」の言葉と一緒に書かれる）
    if (/対象/.test(text) && !/(消費税|税額)/.test(text)) continue;
    if (/(税込|税抜|込み|抜き)\s*(合計|金額)/.test(text) && !/(消費税|税額)/.test(text)) continue;
    // 税率の数字（10%・8%）は金額として読まない
    const amounts = amountsIn(text.replace(/\d+\s*%/g, " ")).filter((n) => n > 0 && (total === null || n < total));
    if (amounts.length === 0) continue;
    candidates.push({
      amount: amounts[amounts.length - 1],
      isTotal: /(計|合計)/.test(text.replace(/消費税/g, "")),
      rate: /(^|[^\d.])10\s*%/.test(text) ? "10" : /(^|[^\d.])8\s*%/.test(text) || /軽減/.test(text) ? "8" : null,
    });
  }
  if (candidates.length === 0) return null;
  const totals = candidates.filter((c) => c.isTotal);
  if (totals.length > 0) return totals[0].amount;
  const byRate = candidates.filter((c) => c.rate !== null);
  if (byRate.length > 0 && byRate.length === candidates.length) {
    // 同じ税率の行が2回出てくる（重複して読んだ）ときは1回だけ数える
    const per = new Map<string, number>();
    for (const c of byRate) if (!per.has(c.rate!)) per.set(c.rate!, c.amount);
    return [...per.values()].reduce((a, b) => a + b, 0);
  }
  const distinct = new Set(candidates.map((c) => c.amount));
  return distinct.size === 1 ? candidates[0].amount : null;
}

/** 品目でない行（合計・税・支払い・お店の情報など）の言葉 */
const NOT_ITEM_RE =
  /(合計|小計|総計|計$|税|対象|お?預|釣|現金|カード|クレジット|電子マネー|ポイント|値引|割引|点数|個数|数量|No\.?|NO\.?|TEL|電話|登録|領収|日付|日時|担当|レジ|伝票|〒|住所|様|ありがとう|又は|但し|但)/;

/** 品目（品名と金額が並んだ行の品名）を探す。見つからないときは null */
export function extractItems(lines: readonly TextLine[]): string | null {
  const names: string[] = [];
  for (const text of prepared(lines)) {
    const m = text.match(/^(.+?)\s*(?:[x×]\s*\d+\s*)?[¥]\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?\s*(?:※|軽|\*)?$/) ??
      text.match(/^(.+?)\s+(\d{1,3}(?:,\d{3})+|\d+)\s*円\s*(?:※|軽|\*)?$/);
    if (!m) continue;
    const name = m[1].replace(/[※*]+$/, "").trim();
    if (name.length < 1 || name.length > 30) continue;
    if (NOT_ITEM_RE.test(name)) continue;
    if (/^[\d\s.,:/\-¥]+$/.test(name)) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length >= MAX_ITEMS) break;
  }
  return names.length > 0 ? names.join("、") : null;
}

/** 書類の文字から、詳しい項目の自動で入れる値を作る（読み取れないものは空欄） */
export function extractReceiptDetails(lines: readonly TextLine[], total: number | null): ReceiptDetailValues {
  const taxAmount = extractTaxAmount(lines, total);
  return {
    ...EMPTY_RECEIPT_DETAILS,
    taxRate: extractTaxRate(lines) ?? "",
    taxAmount: taxAmount === null ? "" : String(taxAmount),
    registrationNumber: extractRegistrationNumber(lines) ?? "",
    items: extractItems(lines) ?? "",
  };
}

/** 税額の入力文字を整数の円にする（0円も可）。空欄は null、読めないときは NaN */
export function parseTaxAmountInput(raw: string): number | null {
  const text = raw.normalize("NFKC").replace(/[¥\\,\s円]/g, "");
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return Number.NaN;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** 合計金額（税込）から、税率 r% の内税の税額として考えられる値（端数の切り捨て・四捨五入・切り上げ） */
export function expectedInclusiveTax(total: number, ratePercent: number): number[] {
  const exact = (total * ratePercent) / (100 + ratePercent);
  return [...new Set([Math.floor(exact), Math.round(exact), Math.ceil(exact)])];
}

/**
 * 詳しい項目の確認（注意だけ。出力は止めない）。
 * total は検証を通った合計金額（不明なら null）
 */
export function checkReceiptDetails(details: ReceiptDetailValues, total: number | null): string[] {
  const warnings: string[] = [];
  const tax = parseTaxAmountInput(details.taxAmount);
  if (tax !== null && Number.isNaN(tax)) {
    warnings.push("消費税額が正しくありません（0以上の整数の円で入力してください）。");
  } else if (tax !== null && total !== null) {
    if (tax >= total) {
      warnings.push("消費税額が合計金額以上になっています。読み取りの誤りがないか確認してください。");
    } else if (details.taxRate === "10" || details.taxRate === "8") {
      const rate = Number(details.taxRate);
      const expected = expectedInclusiveTax(total, rate);
      if (!expected.includes(tax)) {
        warnings.push(
          `合計金額と消費税額が合いません（合計${total.toLocaleString("ja-JP")}円が税率${rate}%の税込なら、消費税額は約${expected[0].toLocaleString("ja-JP")}円です）。読み取りの誤り・税率・値引きなどを確認してください。`,
        );
      }
    } else if (details.taxRate === "mixed") {
      // 10%と8%の混在：税額は、8%だけのときと10%だけのときの間に入るはず
      const low = expectedInclusiveTax(total, 8)[0];
      const high = expectedInclusiveTax(total, 10).at(-1)!;
      if (tax < low - 1 || tax > high + 1) {
        warnings.push(`合計金額と消費税額が合いません（10%と8%の混在なら、消費税額はおよそ${low.toLocaleString("ja-JP")}〜${high.toLocaleString("ja-JP")}円の間です）。`);
      }
    }
  }
  const reg = details.registrationNumber.normalize("NFKC").replace(/[\s\-]/g, "");
  if (reg !== "" && !/^T\d{13}$/.test(reg)) {
    warnings.push("登録番号の形が正しくありません（「T」と13桁の数字です）。");
  }
  const cat = details.taxCategory.normalize("NFKC");
  if (cat !== "" && (details.taxRate === "10" || details.taxRate === "8")) {
    const other = details.taxRate === "10" ? /8\s*%|軽/ : /10\s*%/;
    if (other.test(cat)) warnings.push(`税区分（${details.taxCategory}）と、読み取った税率（${details.taxRate}%）が合っていません。`);
  }
  return warnings;
}

/** 税率の表示 */
export function taxRateLabel(value: string): string {
  return TAX_RATE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
