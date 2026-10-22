/**
 * AI利用台帳（supabase/migrations の 0003_ai_usage_ledger.sql）を呼ぶ窓口。
 * 実際の予約・確定・解放の判定（上限・同時実行・冪等性）はデータベース側の関数が行う。
 * このファイルは、関数の呼び出しと、戻り値（JSON）の読み取りだけを行う。
 * 台帳に渡すのは、利用者ID・依頼ID・機能名・モデル名・金額・トークン数だけで、本文は渡さない。
 */
import { AI_PERIOD_LIMIT_MICRO_USD, PRICE_VERSION, type TokenUsage } from "./pricing";

export type ReserveOutcome =
  | "ok"
  | "duplicate"
  | "quota_exceeded"
  | "too_many_concurrent"
  | "rate_limited"
  | "not_premium"
  | "period_unknown"
  | "invalid";

export interface PeriodSnapshot {
  periodStart: string;
  periodEnd: string;
  limitMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  remainingMicroUsd: number;
}

export interface ReserveResult {
  outcome: ReserveOutcome;
  requestStatus: string | null;
  period: PeriodSnapshot | null;
}

export type SettleOutcome = "ok" | "ok_over_reservation" | "already_settled" | "already_released" | "not_found" | "invalid";

export interface SettleResult {
  outcome: SettleOutcome;
  period: PeriodSnapshot | null;
}

export interface UsageSnapshot {
  entitled: boolean;
  reason: string;
  period: PeriodSnapshot | null;
}

export interface ReserveArgs {
  userId: string;
  requestId: string;
  feature: string;
  modelId: string;
  reserveMicroUsd: number;
  ttlSeconds?: number;
  maxConcurrent?: number;
  maxPerMinute?: number;
}

export interface Ledger {
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  settle(args: { userId: string; requestId: string; actualMicroUsd: number; usage: TokenUsage | null }): Promise<SettleResult>;
  release(args: { userId: string; requestId: string; errorCode: string }): Promise<SettleResult>;
  getUsage(userId: string): Promise<UsageSnapshot>;
}

export class LedgerError extends Error {}

/** SupabaseのRPC呼び出しの最小の形（テストで差し替えられる） */
export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

const REASONS_OUTCOME = new Set<string>(["ok", "duplicate", "quota_exceeded", "too_many_concurrent", "rate_limited", "not_premium", "period_unknown", "invalid"]);
const SETTLE_OUTCOMES = new Set<string>(["ok", "ok_over_reservation", "already_settled", "already_released", "not_found", "invalid"]);

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readPeriod(data: Record<string, unknown>): PeriodSnapshot | null {
  if (typeof data.period_start !== "string" || typeof data.period_end !== "string") return null;
  return {
    periodStart: data.period_start,
    periodEnd: data.period_end,
    limitMicroUsd: asNumber(data.limit_micro_usd),
    spentMicroUsd: asNumber(data.spent_micro_usd),
    reservedMicroUsd: asNumber(data.reserved_micro_usd),
    remainingMicroUsd: asNumber(data.remaining_micro_usd),
  };
}

function asRecord(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new LedgerError("台帳の応答の形式が正しくありません");
  return data as Record<string, unknown>;
}

export function createRpcLedger(rpc: RpcCall, options?: { periodLimitMicroUsd?: number }): Ledger {
  const limit = options?.periodLimitMicroUsd ?? AI_PERIOD_LIMIT_MICRO_USD;

  async function call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data, error } = await rpc(fn, args);
    if (error) throw new LedgerError(`台帳の呼び出しに失敗しました (${fn})`);
    return asRecord(data);
  }

  return {
    async reserve(a) {
      const d = await call("ai_reserve", {
        p_user_id: a.userId,
        p_request_id: a.requestId,
        p_feature: a.feature,
        p_model: a.modelId,
        p_reserve_micro_usd: a.reserveMicroUsd,
        p_limit_micro_usd: limit,
        p_ttl_seconds: a.ttlSeconds ?? 1800,
        p_max_concurrent: a.maxConcurrent ?? 2,
        p_max_per_minute: a.maxPerMinute ?? 10,
        p_price_version: PRICE_VERSION,
      });
      const outcome = typeof d.outcome === "string" && REASONS_OUTCOME.has(d.outcome) ? (d.outcome as ReserveOutcome) : null;
      if (!outcome) throw new LedgerError("台帳の応答の内容が正しくありません");
      return { outcome, requestStatus: typeof d.request_status === "string" ? d.request_status : null, period: readPeriod(d) };
    },

    async settle(a) {
      const d = await call("ai_settle", {
        p_user_id: a.userId,
        p_request_id: a.requestId,
        p_actual_micro_usd: a.actualMicroUsd,
        p_input_tokens: a.usage?.inputTokens ?? null,
        p_cached_input_tokens: a.usage?.cachedInputTokens ?? null,
        p_output_tokens: a.usage?.outputTokens ?? null,
      });
      const outcome = typeof d.outcome === "string" && SETTLE_OUTCOMES.has(d.outcome) ? (d.outcome as SettleOutcome) : null;
      if (!outcome) throw new LedgerError("台帳の応答の内容が正しくありません");
      return { outcome, period: readPeriod(d) };
    },

    async release(a) {
      const d = await call("ai_release", { p_user_id: a.userId, p_request_id: a.requestId, p_error_code: a.errorCode });
      const outcome = d.outcome === "ok" ? "ok" : typeof d.outcome === "string" && SETTLE_OUTCOMES.has(d.outcome) ? (d.outcome as SettleOutcome) : null;
      if (!outcome) throw new LedgerError("台帳の応答の内容が正しくありません");
      return { outcome, period: readPeriod(d) };
    },

    async getUsage(userId) {
      const d = await call("ai_get_usage", { p_user_id: userId, p_default_limit_micro_usd: limit });
      const period =
        typeof d.period_start === "string" && typeof d.period_end === "string"
          ? readPeriod(d)
          : null;
      return { entitled: d.entitled === true, reason: typeof d.reason === "string" ? d.reason : "unknown", period };
    },
  };
}
