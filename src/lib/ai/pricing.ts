/**
 * AI（OpenAI API）の料金計算と、AI利用枠の単位（このファイルは純粋な計算だけで、通信も保存もしない）。
 *
 * 単価は 2026-10-22 時点のOpenAI公式資料（モデル紹介ページ）に基づく。価格が変わったら、
 * 下の表と PRICE_VERSION を更新する（利用記録には単価表の版が残るため、いつの単価で計算したか追える）。
 *
 * 内部の金額は「µUSD（1ドルの100万分の1）」の整数で扱い、画面には金額を出さない。
 * 画面には「AIトークン」だけを出す。1 AIトークン = 0.1 µUSD（標準モデルの入力1トークン相当）。
 * この換算の係数は固定で、モデルや単価が変わっても変えない（残量の単位が不用意に変わらないように）。
 */

/** 単価表の版（単価を更新したら日付を変える） */
export const PRICE_VERSION = "2026-10-22";

/** 1ドルあたりの円（上限を決めるときの換算。四半期ごとに見直す。画面には出さない） */
export const JPY_PER_USD = 165;

/** 1請求期間あたりの内部の上限（µUSD）。3.00ドル ≒ 495円（165円/ドル）で、500円相当を超えない */
export const AI_PERIOD_LIMIT_MICRO_USD = 3_000_000;

/** 1 µUSD あたりのAIトークン数（1 AIトークン = 0.1 µUSD）。固定 */
export const AI_TOKENS_PER_MICRO_USD = 10;

/** 推論モデルの利用料の目安に使う: 入力がこのトークン数を超えると、入力は2倍・出力は1.5倍（リクエスト全体に適用） */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export type AiModelTier = "standard" | "advanced";

interface ModelPricing {
  /** OpenAI APIのモデルID（公式資料で確認したもの） */
  id: string;
  /** 画面に出す名前（モデル名は出さず、役割で表す） */
  label: string;
  /** 単価。nUSD（1ドルの10億分の1）/トークン。1M トークンあたりのドル額 × 1000 に等しい */
  inputNano: number;
  cachedInputNano: number;
  cacheWriteNano: number;
  outputNano: number;
}

export const AI_MODELS: Record<AiModelTier, ModelPricing> = {
  // gpt-6-luna: 入力 $0.10 / キャッシュ入力 $0.01 / キャッシュ書き込み $0.125 / 出力 $0.50（100万トークンあたり）
  standard: { id: "gpt-6-luna", label: "標準", inputNano: 100, cachedInputNano: 10, cacheWriteNano: 125, outputNano: 500 },
  // gpt-6.1-sol: 入力 $2.00 / キャッシュ入力 $0.10 / キャッシュ書き込み $2.50 / 出力 $10.00（100万トークンあたり）
  advanced: { id: "gpt-6.1-sol", label: "高精度", inputNano: 2000, cachedInputNano: 100, cacheWriteNano: 2500, outputNano: 10000 },
};

export function isModelTier(value: unknown): value is AiModelTier {
  return value === "standard" || value === "advanced";
}

export interface TokenUsage {
  inputTokens: number;
  /** 入力のうち、キャッシュから読まれたトークン（inputTokens の内数） */
  cachedInputTokens: number;
  /** 出力トークン（推論トークンを含む。推論トークンも出力として課金される） */
  outputTokens: number;
}

/**
 * 実際の使用量から、費用（µUSD、整数）を求める。端数は切り上げる。
 *
 * 安全側（多めに数える）の仮定: キャッシュから読まれなかった入力は、通常の入力単価と
 * キャッシュ書き込み単価の高いほうで数える（応答の使用量にはキャッシュ書き込みの内訳が無いため）。
 * 実APIでの測定（工程4F）で、この仮定を見直す。
 */
export function costMicroUsd(tier: AiModelTier, usage: TokenUsage): number {
  const p = AI_MODELS[tier];
  const input = Math.max(0, Math.floor(usage.inputTokens));
  const cached = Math.min(Math.max(0, Math.floor(usage.cachedInputTokens)), input);
  const output = Math.max(0, Math.floor(usage.outputTokens));
  const fresh = input - cached;
  const long = input > LONG_CONTEXT_THRESHOLD_TOKENS;
  const inputNano = (fresh * Math.max(p.inputNano, p.cacheWriteNano) + cached * p.cachedInputNano) * (long ? 2 : 1);
  const outputNano = output * p.outputNano * (long ? 1.5 : 1);
  return Math.ceil((inputNano + outputNano) / 1000);
}

/** 予約額に掛ける余裕（%）。見積りの誤差・単価の端数のための余裕 */
export const RESERVE_MARGIN_PERCENT = 110;

/**
 * 呼び出し前に予約する額（µUSD）。「入力は見積りの上限、出力は max_output_tokens ぴったり、キャッシュなし」の最悪ケース。
 * 実際の使用量はこれを超えない（入力は見積り以下、出力は上限以下）ため、確定額が予約額を超えることは通常ない。
 */
export function reserveMicroUsd(tier: AiModelTier, estimatedInputTokens: number, maxOutputTokens: number): number {
  const worst = costMicroUsd(tier, { inputTokens: estimatedInputTokens, cachedInputTokens: 0, outputTokens: maxOutputTokens });
  return Math.ceil((worst * RESERVE_MARGIN_PERCENT) / 100);
}

const encoder = new TextEncoder();

/**
 * 入力トークン数の見積り（上限）。1トークンは必ず1バイト以上なので、UTF-8のバイト数は、
 * どのモデルのトークナイザーでも「実際のトークン数以上」になる（日本語では実際より大きめになる）。
 */
export function estimateInputTokens(text: string): number {
  return encoder.encode(text).length;
}

/** µUSD → AIトークン（画面に出す単位）。係数は固定 */
export function microUsdToAiTokens(microUsd: number): number {
  return Math.round(Math.max(0, microUsd) * AI_TOKENS_PER_MICRO_USD);
}

/** AIトークンを画面用に整える（1万以上は「万」単位）。残量は切り捨て、使用量は切り上げで、多めに見せない */
export function formatAiTokens(tokens: number, rounding: "floor" | "ceil" = "floor"): string {
  const n = Math.max(0, Math.round(tokens));
  if (n >= 10_000) {
    const man = rounding === "floor" ? Math.floor(n / 10_000) : Math.ceil(n / 10_000);
    return `${man.toLocaleString("ja-JP")}万`;
  }
  return n.toLocaleString("ja-JP");
}
