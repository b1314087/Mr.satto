/**
 * 年度カレンダーのAI補助（サーバー側の処理の流れ）。通信・認証・データベースは外から渡す（テストで差し替える）ため、
 * このファイル自体は、環境にも「server-only」にも依存しない。
 *
 * 流れ: 利用できる状態か → 同意があるか → ログイン・Premiumか → 入力の検証 → 利用枠の予約 →
 *       AIの呼び出し → 出力の検証 → 実際の使用量で確定（または、確実に課金されていない失敗だけ解放）。
 *
 * 利用枠の扱い（根拠なく返還しない）:
 *   - 予約できなければ、AIは呼ばない。
 *   - OpenAIが入力を受け付けなかった（400/401/403/404/422/429）ときだけ、予約を解放する。
 *   - タイムアウト・通信断・5xx・不正な応答は、課金されたか分からないので、解放も確定もしない。
 *     予約は期限切れで「使用済み」として扱われ、あとで確かな情報があれば補正できる。
 *   - 処理されたが使用量が読めないときは、予約額で確定する（多めに数える）。
 */
import { AI_MODELS, costMicroUsd, estimateInputTokens, microUsdToAiTokens, reserveMicroUsd, AI_PERIOD_LIMIT_MICRO_USD, type AiModelTier, type TokenUsage } from "./pricing";
import {
  CONSENT_VERSION,
  INSTRUCTIONS,
  OUTPUT_SCHEMA,
  buildUserInput,
  maxOutputTokensFor,
  parseAssistOutput,
  validateAssistRequest,
  type AssistSuggestion,
} from "./calendar-assist";
import type { Ledger, PeriodSnapshot, ReserveOutcome } from "./ledger";
import type { OpenAiCallResult } from "./openai-client";

export const FEATURE_CALENDAR_ASSIST = "calendar-import";

/** 1回の依頼で、予約できる額の上限（期間の上限の何分の1か）。1回で枠の大半を使い切る依頼を、AIを呼ぶ前に断る */
const MAX_SINGLE_RESERVE_MICRO_USD = AI_PERIOD_LIMIT_MICRO_USD / 4;
/** 確定も解放もされなかった予約を「使用済み」にするまでの時間。AIの呼び出しの制限時間より十分に長くする */
const RESERVATION_TTL_SECONDS = 900;

export interface AssistDeps {
  ledger: Ledger;
  callModel(args: { tier: AiModelTier; modelId: string; instructions: string; input: string; maxOutputTokens: number }): Promise<OpenAiCallResult>;
  /** 運用ログ。本文（セルの文字・AIの出力）は渡さない */
  log(event: Record<string, unknown>): void;
}

export interface Caller {
  userId: string | null;
  plan: "free" | "standard" | "premium";
}

export type Availability = { available: true } | { available: false; reason: "not_configured" | "preview" | "billing_off" };

export interface ServiceResponse {
  status: number;
  body: Record<string, unknown>;
}

const respond = (status: number, body: Record<string, unknown>): ServiceResponse => ({ status, body });

function usageBody(period: PeriodSnapshot | null) {
  if (!period) return null;
  return {
    limitAiTokens: microUsdToAiTokens(period.limitMicroUsd),
    usedAiTokens: microUsdToAiTokens(period.spentMicroUsd + period.reservedMicroUsd),
    remainingAiTokens: microUsdToAiTokens(period.remainingMicroUsd),
    periodEnd: period.periodEnd,
  };
}

const RESERVE_ERRORS: Record<Exclude<ReserveOutcome, "ok">, { status: number; error: string; message: string }> = {
  duplicate: { status: 409, error: "duplicate", message: "同じ依頼がすでに処理されています。画面を更新して、もう一度お試しください。" },
  quota_exceeded: { status: 429, error: "quota_exceeded", message: "今期のAI利用枠を使い切りました。次の更新日にリセットされます。" },
  too_many_concurrent: { status: 429, error: "too_many_concurrent", message: "処理中のAI読み取りがあります。終わってから、もう一度お試しください。" },
  rate_limited: { status: 429, error: "rate_limited", message: "短時間に多く実行されました。少し待ってから、もう一度お試しください。" },
  not_premium: { status: 403, error: "not_premium", message: "AIによる読み取り補助は、Premiumプランの機能です。" },
  period_unknown: { status: 503, error: "period_unknown", message: "契約期間を確認できませんでした。時間をおいて、もう一度お試しください。" },
  invalid: { status: 400, error: "invalid", message: "依頼の内容が正しくありません。" },
};

export async function handleCalendarAssist(
  deps: AssistDeps,
  caller: Caller,
  availability: Availability,
  rawBody: unknown,
): Promise<ServiceResponse> {
  if (!availability.available) {
    return respond(503, { error: "unavailable", reason: availability.reason, message: "AIによる読み取り補助は、現在ご利用いただけません。" });
  }

  // 同意がなければ、何も処理しない（AIは呼ばない）
  const consent = typeof rawBody === "object" && rawBody !== null ? (rawBody as { consent?: unknown }).consent : undefined;
  const consented =
    typeof consent === "object" && consent !== null && (consent as { accepted?: unknown }).accepted === true && (consent as { version?: unknown }).version === CONSENT_VERSION;
  if (!consented) {
    return respond(400, { error: "consent_required", message: "AIへ送信することへの同意が確認できませんでした。送信内容を確認し、同意してから実行してください。" });
  }

  if (!caller.userId) return respond(401, { error: "login_required", message: "ログインが必要です。" });
  if (caller.plan !== "premium") return respond(403, { error: "not_premium", message: "AIによる読み取り補助は、Premiumプランの機能です。" });

  const validated = validateAssistRequest(rawBody);
  if (!validated.ok) return respond(400, { error: "invalid_request", message: validated.message });
  const request = validated.value;

  const modelId = AI_MODELS[request.model].id;
  const instructions = INSTRUCTIONS;
  const input = buildUserInput(request);
  const maxOutputTokens = maxOutputTokensFor(request.rows.length);
  // 入力の見積り（上限）: 指示・スキーマ・本文のすべてのバイト数 + リクエストの枠組みの余裕
  const estimatedInputTokens = estimateInputTokens(instructions + JSON.stringify(OUTPUT_SCHEMA) + input) + 1_000;
  const reserved = reserveMicroUsd(request.model, estimatedInputTokens, maxOutputTokens);
  if (reserved > MAX_SINGLE_RESERVE_MICRO_USD) {
    return respond(400, { error: "too_large", message: "一度に読み取る量が多すぎます。行を減らして、もう一度お試しください。" });
  }

  // ① 利用枠の予約（できなければ、AIは呼ばない）
  const userId = caller.userId;
  let reservation;
  try {
    reservation = await deps.ledger.reserve({
      userId,
      requestId: request.requestId,
      feature: FEATURE_CALENDAR_ASSIST,
      modelId,
      reserveMicroUsd: reserved,
      ttlSeconds: RESERVATION_TTL_SECONDS,
      maxConcurrent: 3,
      maxPerMinute: 10,
    });
  } catch {
    deps.log({ event: "ai_assist", requestId: request.requestId, stage: "reserve", result: "ledger_error" });
    return respond(503, { error: "ledger_unavailable", message: "利用枠を確認できませんでした。時間をおいて、もう一度お試しください。" });
  }
  if (reservation.outcome !== "ok") {
    const info = RESERVE_ERRORS[reservation.outcome];
    deps.log({ event: "ai_assist", requestId: request.requestId, stage: "reserve", result: reservation.outcome });
    return respond(info.status, {
      error: info.error,
      message: info.message,
      ...(reservation.period ? { usage: usageBody(reservation.period), resetAt: reservation.period.periodEnd } : {}),
    });
  }

  // ② AIの呼び出し
  let result: OpenAiCallResult;
  try {
    result = await deps.callModel({ tier: request.model, modelId, instructions, input, maxOutputTokens });
  } catch {
    // 呼び出しの中で想定外の例外が起きた: 課金されたか分からないので、そのままにする
    result = { kind: "unknown", reason: "network" };
  }

  // ③ 結果に応じて、確定・解放・そのまま
  if (result.kind === "rejected") {
    const rejectedStatus = result.status;
    await finalize(deps, () => deps.ledger.release({ userId, requestId: request.requestId, errorCode: `openai_${rejectedStatus}` }), request.requestId, "release");
    deps.log({ event: "ai_assist", requestId: request.requestId, tier: request.model, result: "rejected", status: rejectedStatus });
    const message =
      rejectedStatus === 429
        ? "AIの利用が混み合っています。少し待ってから、もう一度お試しください。"
        : "AIの設定に問題があり、読み取りを実行できませんでした。時間をおいて、もう一度お試しください。";
    return respond(502, { error: "ai_rejected", message });
  }

  if (result.kind === "unknown") {
    deps.log({ event: "ai_assist", requestId: request.requestId, tier: request.model, result: "unknown", reason: result.reason });
    const message =
      result.reason === "timeout"
        ? "AIの応答に時間がかかりすぎたため、読み取りを中止しました。通常の読み取り結果はそのまま使えます。"
        : "AIとの通信で問題が起きました。通常の読み取り結果はそのまま使えます。";
    // 課金されたか分からないため、利用枠は戻さない
    return respond(504, { error: "ai_unknown", message, quotaNote: "通信が不確かだったため、この分の利用枠はすぐには戻りません。" });
  }

  // OpenAIが処理した（ok / refusal / incomplete / failed）: 使用量で確定する。使用量が読めなければ予約額で確定する
  const usage: TokenUsage | null = result.usage;
  const actual = usage ? costMicroUsd(request.model, usage) : reserved;
  const settled = await finalize(
    deps,
    () => deps.ledger.settle({ userId, requestId: request.requestId, actualMicroUsd: actual, usage }),
    request.requestId,
    "settle",
  );
  const usageInfo = usageBody(settled?.period ?? null);

  if (result.kind !== "ok") {
    deps.log({ event: "ai_assist", requestId: request.requestId, tier: request.model, result: result.kind, costMicroUsd: actual });
    const message =
      result.kind === "refusal"
        ? "AIがこの内容の読み取りに応じませんでした。通常の読み取り結果はそのまま使えます。"
        : result.kind === "incomplete"
          ? "AIの応答が途中で切れたため、結果を使えませんでした。行を減らして、もう一度お試しください。"
          : "AIの処理に失敗しました。通常の読み取り結果はそのまま使えます。";
    return respond(502, { error: `ai_${result.kind}`, message, usage: usageInfo });
  }

  const parsed = parseAssistOutput(result.text, request);
  deps.log({ event: "ai_assist", requestId: request.requestId, tier: request.model, result: parsed ? "ok" : "invalid_output", costMicroUsd: actual });
  if (!parsed) {
    return respond(502, { error: "ai_invalid_output", message: "AIの出力の形式が正しくなかったため、結果を使えませんでした。", usage: usageInfo });
  }
  const suggestions: AssistSuggestion[] = parsed.suggestions;
  return respond(200, { ok: true, model: request.model, suggestions, rejected: parsed.rejected, usage: usageInfo });
}

/** 台帳への確定・解放。一時的な失敗に備えて1回だけやり直す。それでも失敗したら、予約は期限切れで「使用済み」になる */
async function finalize<T>(deps: AssistDeps, action: () => Promise<T>, requestId: string, kind: "settle" | "release"): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await action();
    } catch {
      deps.log({ event: "ai_assist", requestId, stage: kind, result: "ledger_error", attempt });
    }
  }
  return null;
}
