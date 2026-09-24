import type { LineItemInput, ParsedLineItem, TaxRatePercent, TaxRounding } from "./types";

/**
 * 帳票の金額計算（Phase 2-C ■21対応）。
 *
 * 数量 × 単価 → 明細金額 → 小計 → 消費税 → 合計 という計算の過程で
 * JavaScript の浮動小数点誤差（0.1 + 0.2 の類）が金額へ出ないよう、
 * できる限り整数（円 / 数量は小数第2位までを整数化した単位）で計算する。
 *
 * - 数量: 小数第2位まで許容し、内部では ×100 した整数として扱う
 * - 単価: 円単位（内部では整数に丸めて扱う）
 * - 明細金額 = round(数量units × 単価円 / 100) （常に整数円）
 * - 小計   = 明細金額（すべて整数円）の合計 → 整数の加算のみなので誤差が出ない
 * - 消費税 = 小計 × 税率 ÷ 100 を端数処理方式で丸めた整数円
 * - 合計   = 小計 + 消費税（どちらも整数円）
 */

const QUANTITY_DECIMALS = 2;
const QUANTITY_SCALE = 10 ** QUANTITY_DECIMALS;

/** 数量の入力文字列を検証する。空・非数値・負数・NaNは無効として null を返す */
export function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** 単価の入力文字列を検証する。空・非数値・負数・NaNは無効として null を返す（0円は許可） */
export function parseUnitPrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * 数量 × 単価 を整数円の明細金額に変換する。
 * 数量・単価のどちらかが不正な場合は 0 を返す（プレビュー用の安全側フォールバック。
 * 実際の生成前バリデーションは validation.ts が別途行う）。
 */
export function computeLineAmount(quantity: number | null, unitPrice: number | null): number {
  if (quantity === null || unitPrice === null) return 0;
  const quantityUnits = Math.round(quantity * QUANTITY_SCALE);
  const unitPriceYen = Math.round(unitPrice);
  return Math.round((quantityUnits * unitPriceYen) / QUANTITY_SCALE);
}

/** LineItemInput（文字列）を計算・PDF生成用の ParsedLineItem（数値）へ変換する */
export function parseLineItem(input: LineItemInput): ParsedLineItem {
  const quantity = parseQuantity(input.quantity) ?? 0;
  const unitPrice = parseUnitPrice(input.unitPrice) ?? 0;
  return {
    id: input.id,
    name: input.name,
    quantity,
    unit: input.unit,
    unitPrice,
    amount: computeLineAmount(quantity, unitPrice),
  };
}

export function computeSubtotal(items: ParsedLineItem[]): number {
  return items.reduce((sum, item) => sum + item.amount, 0);
}

export function computeTax(
  subtotal: number,
  taxRatePercent: TaxRatePercent,
  rounding: TaxRounding
): number {
  if (taxRatePercent <= 0 || subtotal <= 0) return 0;
  const raw = (subtotal * taxRatePercent) / 100;
  switch (rounding) {
    case "ceil":
      return Math.ceil(raw);
    case "round":
      return Math.round(raw);
    case "floor":
    default:
      return Math.floor(raw);
  }
}

export interface DocumentTotals {
  subtotal: number;
  tax: number;
  total: number;
}

export function computeDocumentTotals(
  items: ParsedLineItem[],
  taxRatePercent: TaxRatePercent,
  rounding: TaxRounding
): DocumentTotals {
  const subtotal = computeSubtotal(items);
  const tax = computeTax(subtotal, taxRatePercent, rounding);
  return { subtotal, tax, total: subtotal + tax };
}

/** 表示用: 3桁区切り + 円記号（例: ¥12,345） */
export function formatYen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}
