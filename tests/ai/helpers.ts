import type { Ledger, ReserveArgs, ReserveResult, SettleResult, UsageSnapshot, PeriodSnapshot } from "@/lib/ai/ledger";
import type { OpenAiCallResult } from "@/lib/ai/openai-client";
import type { AssistDeps } from "@/lib/ai/service";
import type { TokenUsage } from "@/lib/ai/pricing";

/**
 * テスト用の台帳（メモリ上）。supabase/migrations/0003_ai_usage_ledger.sql の関数と同じ規則で動く
 * （予約→確定/解放、冪等、期限切れ=使用済み）。SQL自体の検証は scripts/test-ai-ledger-sql.sh が実際のPostgreSQLで行う。
 */
export class MemoryLedger implements Ledger {
  limit: number;
  spent = 0;
  reserved = 0;
  premium = new Set<string>();
  requests = new Map<string, { userId: string; status: "reserved" | "settled" | "released" | "lapsed"; reserved: number; actual: number | null }>();
  calls: string[] = [];
  failReserve = false;
  failSettleTimes = 0;
  maxConcurrent = 3;

  constructor(limit = 3_000_000) {
    this.limit = limit;
  }

  private period(): PeriodSnapshot {
    return {
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      limitMicroUsd: this.limit,
      spentMicroUsd: this.spent,
      reservedMicroUsd: this.reserved,
      remainingMicroUsd: Math.max(this.limit - this.spent - this.reserved, 0),
    };
  }

  async reserve(a: ReserveArgs): Promise<ReserveResult> {
    this.calls.push("reserve");
    if (this.failReserve) throw new Error("db down");
    const existing = this.requests.get(a.requestId);
    if (existing) return { outcome: "duplicate", requestStatus: existing.status, period: this.period() };
    if (!this.premium.has(a.userId)) return { outcome: "not_premium", requestStatus: null, period: null };
    const active = [...this.requests.values()].filter((r) => r.userId === a.userId && r.status === "reserved").length;
    if (active >= this.maxConcurrent) return { outcome: "too_many_concurrent", requestStatus: null, period: this.period() };
    if (this.spent + this.reserved + a.reserveMicroUsd > this.limit) return { outcome: "quota_exceeded", requestStatus: null, period: this.period() };
    this.requests.set(a.requestId, { userId: a.userId, status: "reserved", reserved: a.reserveMicroUsd, actual: null });
    this.reserved += a.reserveMicroUsd;
    return { outcome: "ok", requestStatus: "reserved", period: this.period() };
  }

  async settle(a: { userId: string; requestId: string; actualMicroUsd: number; usage: TokenUsage | null }): Promise<SettleResult> {
    this.calls.push("settle");
    if (this.failSettleTimes > 0) {
      this.failSettleTimes--;
      throw new Error("db down");
    }
    const r = this.requests.get(a.requestId);
    if (!r || r.userId !== a.userId) return { outcome: "not_found", period: null };
    if (r.status === "settled") return { outcome: "already_settled", period: this.period() };
    if (r.status === "reserved") {
      this.reserved -= r.reserved;
      this.spent += a.actualMicroUsd;
    } else if (r.status === "lapsed") this.spent += a.actualMicroUsd - r.reserved;
    else this.spent += a.actualMicroUsd;
    r.status = "settled";
    r.actual = a.actualMicroUsd;
    return { outcome: a.actualMicroUsd > r.reserved ? "ok_over_reservation" : "ok", period: this.period() };
  }

  async release(a: { userId: string; requestId: string; errorCode: string }): Promise<SettleResult> {
    this.calls.push("release");
    const r = this.requests.get(a.requestId);
    if (!r || r.userId !== a.userId) return { outcome: "not_found", period: null };
    if (r.status === "released") return { outcome: "already_released", period: this.period() };
    if (r.status === "settled") return { outcome: "already_settled", period: this.period() };
    if (r.status === "reserved") this.reserved -= r.reserved;
    else this.spent -= r.reserved;
    r.status = "released";
    return { outcome: "ok", period: this.period() };
  }

  async getUsage(): Promise<UsageSnapshot> {
    return { entitled: true, reason: "ok", period: this.period() };
  }

  /** 予約の期限が切れた状態にする（未確定の予約を「使用済み」にする） */
  expireAll() {
    for (const r of this.requests.values()) {
      if (r.status === "reserved") {
        r.status = "lapsed";
        this.reserved -= r.reserved;
        this.spent += r.reserved;
      }
    }
  }
}

export interface FakeModel {
  calls: { modelId: string; input: string; maxOutputTokens: number; mode?: string; imageCount?: number; instructions?: string }[];
  next: OpenAiCallResult | (() => Promise<OpenAiCallResult>);
}

export function makeDeps(ledger: Ledger, model: FakeModel, logs: Record<string, unknown>[] = []): AssistDeps {
  return {
    ledger,
    log: (event) => logs.push(event),
    callModel: async (args) => {
      model.calls.push({ modelId: args.modelId, input: args.input, maxOutputTokens: args.maxOutputTokens, mode: args.mode, imageCount: args.images?.length, instructions: args.instructions });
      return typeof model.next === "function" ? model.next() : model.next;
    },
  };
}

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const RANGE = { rangeStart: "2027-04-01", rangeEnd: "2028-03-31" };

let counter = 0;
export function newRequestId(): string {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

export function assistBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consent: { accepted: true, version: "2026-10-22" },
    requestId: newRequestId(),
    model: "standard",
    ...RANGE,
    headers: ["日付", "予定"],
    rows: [
      { row: 5, cells: ["4/5", "入学式"] },
      { row: 6, cells: ["令和9年4月6日", "始業式"] },
    ],
    ...over,
  };
}

export function okOutput(rows: number[] = [5, 6]): string {
  return JSON.stringify({
    suggestions: rows.map((row) => ({
      row,
      date: row === 5 ? "2027-04-05" : "2027-04-06",
      title: row === 5 ? "入学式" : "始業式",
      start_time: null,
      end_time: null,
      confidence: row === 5 ? "medium" : "high",
      inferred: row === 5,
      note: row === 5 ? "年が書かれていないため、対象年度の2027年と推測しました" : "",
    })),
  });
}
