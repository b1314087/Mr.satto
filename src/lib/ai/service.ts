/**
 * 年度カレンダーのAI補助（サーバー側の処理の流れ）。通信・認証・データベースは外から渡す（テストで差し替える）ため、
 * このファイル自体は、環境にも「server-only」にも依存しない。
 *
 * 流れ: 利用できる状態か → ログイン・Premiumか → 同意があるか → 入力の検証 → 利用枠の予約 →
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
  IMAGE_INSTRUCTIONS,
  INSTRUCTIONS,
  OUTPUT_SCHEMA,
  buildImageUserText,
  buildUserInput,
  estimateImageInputTokens,
  maxOutputTokensFor,
  maxOutputTokensForImages,
  parseAssistOutput,
  parseImageAssistOutput,
  validateAssistRequest,
  validateImageAssistRequest,
  type AssistImage,
} from "./calendar-assist";
import {
  FORM_CONSENT_VERSION,
  FORM_INPUT_OVERHEAD_TOKENS,
  FORM_OUTPUT_SCHEMA,
  buildFormUserInput,
  instructionsForPurpose,
  maxOutputTokensForForm,
  parseFormOutput,
  totalFormChars,
  validateFormExtractRequest,
} from "./form-extract";
import {
  PPTX_TEXT_CONSENT_VERSION,
  PPTX_TEXT_INSTRUCTIONS,
  buildPptxTextUserText,
  estimatePptxTextInputTokens,
  maxOutputTokensForPptxText,
  parsePptxTextOutput,
  validatePptxTextRequest,
} from "./pptx-text";
import type { Ledger, PeriodSnapshot, ReserveOutcome } from "./ledger";
import type { OpenAiCallResult } from "./openai-client";

export const FEATURE_CALENDAR_ASSIST = "calendar-import";
/** 記入済みPDF→Excelの、AI読み取り補助（利用台帳に残る機能名。内容は入れない） */
export const FEATURE_FORM_EXTRACT = "form-extract";
/** PDF→Excelの、AI読み取り補助（同上） */
export const FEATURE_TABLE_EXTRACT = "table-extract";
/** PowerPoint白黒反転の、AIによる画像内の文字の読み取り（同上） */
export const FEATURE_PPTX_TEXT = "pptx-text";

/** 1回の依頼で、予約できる額の上限（期間の上限の何分の1か）。1回で枠の大半を使い切る依頼を、AIを呼ぶ前に断る */
const MAX_SINGLE_RESERVE_MICRO_USD = AI_PERIOD_LIMIT_MICRO_USD / 4;
/** 確定も解放もされなかった予約を「使用済み」にするまでの時間。AIの呼び出しの制限時間より十分に長くする */
const RESERVATION_TTL_SECONDS = 900;

export interface AssistDeps {
  ledger: Ledger;
  /** mode が "image" のときは、images（ブラウザで縮小したJPEG/PNG）を input の文字と一緒にAIへ渡す */
  callModel(args: {
    tier: AiModelTier;
    modelId: string;
    instructions: string;
    input: string;
    maxOutputTokens: number;
    mode?: "rows" | "image" | "form" | "pptx";
    images?: AssistImage[];
  }): Promise<OpenAiCallResult>;
  /** 運用ログ。本文（セルの文字・AIの出力）は渡さない */
  log(event: Record<string, unknown>): void;
}

export interface Caller {
  userId: string | null;
  plan: "free" | "standard" | "premium";
  /** 1期間のAI利用枠（マイクロドル）。省略すると通常の枠。無料お試しなど、小さくしたいときだけ指定する */
  aiLimitMicroUsd?: number;
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
  not_premium: { status: 403, error: "not_premium", message: "AIによる読み取り補助は、プレミアムプランの機能です。" },
  period_unknown: { status: 503, error: "period_unknown", message: "契約期間を確認できませんでした。時間をおいて、もう一度お試しください。" },
  invalid: { status: 400, error: "invalid", message: "依頼の内容が正しくありません。" },
};

/**
 * 権限と同意の確認（どのAI補助でも共通）。通らなければ、返す応答を返す。通れば null。
 * 権限の確認が先: ログインしていない人・Premiumでない人には、同意や入力の中身を見ずに断る。
 */
function checkAccess(caller: Caller, availability: Availability, rawBody: unknown, consentVersion: string): ServiceResponse | null {
  if (!availability.available) {
    return respond(503, { error: "unavailable", reason: availability.reason, message: "AIによる読み取り補助は、現在ご利用いただけません。" });
  }
  if (!caller.userId) return respond(401, { error: "login_required", message: "ログインが必要です。" });
  if (caller.plan !== "premium") return respond(403, { error: "not_premium", message: "AIによる読み取り補助は、プレミアムプランの機能です。" });

  // 同意がなければ、何も処理しない（AIは呼ばない）
  const consent = typeof rawBody === "object" && rawBody !== null ? (rawBody as { consent?: unknown }).consent : undefined;
  const consented =
    typeof consent === "object" && consent !== null && (consent as { accepted?: unknown }).accepted === true && (consent as { version?: unknown }).version === consentVersion;
  if (!consented) {
    return respond(400, { error: "consent_required", message: "AIへ送信することへの同意が確認できませんでした。送信内容を確認し、同意してから実行してください。" });
  }
  return null;
}

export async function handleCalendarAssist(
  deps: AssistDeps,
  caller: Caller,
  availability: Availability,
  rawBody: unknown,
): Promise<ServiceResponse> {
  const denied = checkAccess(caller, availability, rawBody, CONSENT_VERSION);
  if (denied) return denied;
  const plan = buildPlan(rawBody);
  if (!plan.ok) return respond(400, { error: "invalid_request", message: plan.message });
  return execute(deps, caller.userId as string, plan.value);
}

/** 記入済みPDF→Excelの、AI読み取り補助（PDFの文字を、表の行に整理する）。流れは年度カレンダーと同じ */
export async function handleFormExtract(
  deps: AssistDeps,
  caller: Caller,
  availability: Availability,
  rawBody: unknown,
): Promise<ServiceResponse> {
  const denied = checkAccess(caller, availability, rawBody, FORM_CONSENT_VERSION);
  if (denied) return denied;
  const validated = validateFormExtractRequest(rawBody);
  if (!validated.ok) return respond(400, { error: "invalid_request", message: validated.message });
  const request = validated.value;
  const input = buildFormUserInput(request);
  const chars = totalFormChars(request);
  const instructions = instructionsForPurpose(request.purpose);
  return execute(deps, caller.userId as string, {
    mode: "form",
    feature: request.purpose === "table" ? FEATURE_TABLE_EXTRACT : FEATURE_FORM_EXTRACT,
    requestId: request.requestId,
    tier: request.model,
    instructions,
    input,
    maxOutputTokens: maxOutputTokensForForm(chars),
    estimatedInputTokens: estimateInputTokens(instructions + JSON.stringify(FORM_OUTPUT_SCHEMA) + input) + FORM_INPUT_OVERHEAD_TOKENS,
    tooLargeMessage: "一度に読み取る量が多すぎます。ページを減らして、もう一度お試しください。",
    incompleteMessage: "AIの応答が途中で切れたため、結果を使えませんでした。ページを減らして、もう一度お試しください。",
    parse: (text) => {
      const parsed = parseFormOutput(text, request);
      return parsed ? { fields: { rows: parsed.rows, notes: parsed.notes }, rejected: parsed.rejected } : null;
    },
  });
}

/** PowerPoint白黒反転の、画像内の文字の読み取り（画像を行ごとの文字と位置にする）。流れは年度カレンダーの画像の読み取りと同じ */
export async function handlePptxText(
  deps: AssistDeps,
  caller: Caller,
  availability: Availability,
  rawBody: unknown,
): Promise<ServiceResponse> {
  const denied = checkAccess(caller, availability, rawBody, PPTX_TEXT_CONSENT_VERSION);
  if (denied) return denied;
  const validated = validatePptxTextRequest(rawBody);
  if (!validated.ok) return respond(400, { error: "invalid_request", message: validated.message });
  const request = validated.value;
  return execute(deps, caller.userId as string, {
    mode: "pptx",
    feature: FEATURE_PPTX_TEXT,
    requestId: request.requestId,
    tier: request.model,
    instructions: PPTX_TEXT_INSTRUCTIONS,
    input: buildPptxTextUserText(request),
    images: request.images,
    maxOutputTokens: maxOutputTokensForPptxText(request.images.length),
    estimatedInputTokens: estimatePptxTextInputTokens(request),
    tooLargeMessage: "一度に読み取る量が多すぎます。画像の枚数を減らして、もう一度お試しください。",
    incompleteMessage: "AIの応答が途中で切れたため、結果を使えませんでした。文字の多い画像が多すぎる可能性があります。もう一度お試しください。",
    parse: (text) => {
      const parsed = parsePptxTextOutput(text, request);
      return parsed ? { fields: { lines: parsed.lines }, rejected: parsed.rejected } : null;
    },
  });
}

/** 1回の依頼の中身（文字の読み取り・画像の読み取りで共通の流れに渡す形） */
interface Plan {
  mode: "rows" | "image" | "form" | "pptx";
  /** 利用台帳に残る機能名 */
  feature: string;
  requestId: string;
  tier: AiModelTier;
  instructions: string;
  input: string;
  images?: AssistImage[];
  maxOutputTokens: number;
  estimatedInputTokens: number;
  tooLargeMessage: string;
  /** AIの応答が途中で切れたときの案内 */
  incompleteMessage: string;
  /** AIの出力を検証して、画面に返す項目にする。全体が不正なら null */
  parse(text: string): { fields: Record<string, unknown>; rejected: number } | null;
}

function buildPlan(rawBody: unknown): { ok: true; value: Plan } | { ok: false; message: string } {
  const isImage = typeof rawBody === "object" && rawBody !== null && (rawBody as { mode?: unknown }).mode === "image";
  if (isImage) {
    const v = validateImageAssistRequest(rawBody);
    if (!v.ok) return v;
    const request = v.value;
    return {
      ok: true,
      value: {
        mode: "image",
        feature: FEATURE_CALENDAR_ASSIST,
        requestId: request.requestId,
        tier: request.model,
        instructions: IMAGE_INSTRUCTIONS,
        input: buildImageUserText(request),
        images: request.images,
        maxOutputTokens: maxOutputTokensForImages(request.images.length),
        estimatedInputTokens: estimateImageInputTokens(request),
        tooLargeMessage: "一度に読み取る量が多すぎます。画像の枚数（ページ数）を減らして、もう一度お試しください。",
        incompleteMessage:
          "AIの応答が途中で切れたため、結果を使えませんでした。予定が多すぎる可能性があります。画像の枚数（ページ数）を減らすか、文字として読めるPDFなら、画像ではなくPDFのまま読み込んでください。",
        parse: (text) => {
          const parsed = parseImageAssistOutput(text, request);
          return parsed ? { fields: { suggestions: parsed.suggestions, source: request.source }, rejected: parsed.rejected } : null;
        },
      },
    };
  }
  const validated = validateAssistRequest(rawBody);
  if (!validated.ok) return validated;
  const request = validated.value;
  const input = buildUserInput(request);
  return {
    ok: true,
    value: {
      mode: "rows",
      feature: FEATURE_CALENDAR_ASSIST,
      requestId: request.requestId,
      tier: request.model,
      instructions: INSTRUCTIONS,
      input,
      maxOutputTokens: maxOutputTokensFor(request.rows.length),
      // 入力の見積り（上限）: 指示・スキーマ・本文のすべてのバイト数 + リクエストの枠組みの余裕
      estimatedInputTokens: estimateInputTokens(INSTRUCTIONS + JSON.stringify(OUTPUT_SCHEMA) + input) + 1_000,
      tooLargeMessage: "一度に読み取る量が多すぎます。行を減らして、もう一度お試しください。",
      incompleteMessage: "AIの応答が途中で切れたため、結果を使えませんでした。行を減らして、もう一度お試しください。",
      parse: (text) => {
        const parsed = parseAssistOutput(text, request);
        return parsed ? { fields: { suggestions: parsed.suggestions }, rejected: parsed.rejected } : null;
      },
    },
  };
}

async function execute(deps: AssistDeps, userId: string, plan: Plan): Promise<ServiceResponse> {
  const { requestId, tier, instructions, input, maxOutputTokens } = plan;
  const modelId = AI_MODELS[tier].id;
  const reserved = reserveMicroUsd(tier, plan.estimatedInputTokens, maxOutputTokens);
  if (reserved > MAX_SINGLE_RESERVE_MICRO_USD) {
    return respond(400, { error: "too_large", message: plan.tooLargeMessage });
  }

  // ① 利用枠の予約（できなければ、AIは呼ばない）
  let reservation;
  try {
    reservation = await deps.ledger.reserve({
      userId,
      requestId,
      feature: plan.feature,
      modelId,
      reserveMicroUsd: reserved,
      ttlSeconds: RESERVATION_TTL_SECONDS,
      maxConcurrent: 3,
      maxPerMinute: 10,
    });
  } catch {
    deps.log({ event: "ai_assist", requestId, stage: "reserve", result: "ledger_error" });
    return respond(503, { error: "ledger_unavailable", message: "利用枠を確認できませんでした。時間をおいて、もう一度お試しください。" });
  }
  if (reservation.outcome !== "ok") {
    const info = RESERVE_ERRORS[reservation.outcome];
    deps.log({ event: "ai_assist", requestId, stage: "reserve", result: reservation.outcome });
    return respond(info.status, {
      error: info.error,
      message: info.message,
      ...(reservation.period ? { usage: usageBody(reservation.period), resetAt: reservation.period.periodEnd } : {}),
    });
  }

  // ② AIの呼び出し
  let result: OpenAiCallResult;
  try {
    result = await deps.callModel({
      tier,
      modelId,
      instructions,
      input,
      maxOutputTokens,
      ...(plan.mode === "image" ? { mode: "image" as const, images: plan.images } : {}),
      ...(plan.mode === "pptx" ? { mode: "pptx" as const, images: plan.images } : {}),
      ...(plan.mode === "form" ? { mode: "form" as const } : {}),
    });
  } catch {
    // 呼び出しの中で想定外の例外が起きた: 課金されたか分からないので、そのままにする
    result = { kind: "unknown", reason: "network" };
  }

  // ③ 結果に応じて、確定・解放・そのまま
  if (result.kind === "rejected") {
    const rejectedStatus = result.status;
    await finalize(deps, () => deps.ledger.release({ userId, requestId, errorCode: `openai_${rejectedStatus}` }), requestId, "release");
    deps.log({ event: "ai_assist", requestId, tier, result: "rejected", status: rejectedStatus });
    const message =
      rejectedStatus === 429
        ? "AIの利用が混み合っています。少し待ってから、もう一度お試しください。"
        : "AIの設定に問題があり、読み取りを実行できませんでした。時間をおいて、もう一度お試しください。";
    return respond(502, { error: "ai_rejected", message });
  }

  if (result.kind === "unknown") {
    deps.log({ event: "ai_assist", requestId, tier, result: "unknown", reason: result.reason });
    const message =
      result.reason === "timeout"
        ? "AIの応答に時間がかかりすぎたため、読み取りを中止しました。通常の読み取り結果はそのまま使えます。"
        : "AIとの通信で問題が起きました。通常の読み取り結果はそのまま使えます。";
    // 課金されたか分からないため、利用枠は戻さない
    return respond(504, { error: "ai_unknown", message, quotaNote: "通信が不確かだったため、この分の利用枠はすぐには戻りません。" });
  }

  // OpenAIが処理した（ok / refusal / incomplete / failed）: 使用量で確定する。使用量が読めなければ予約額で確定する
  const usage: TokenUsage | null = result.usage;
  const actual = usage ? costMicroUsd(tier, usage) : reserved;
  const settled = await finalize(deps, () => deps.ledger.settle({ userId, requestId, actualMicroUsd: actual, usage }), requestId, "settle");
  const usageInfo = usageBody(settled?.period ?? null);

  if (result.kind !== "ok") {
    deps.log({ event: "ai_assist", requestId, tier, result: result.kind, costMicroUsd: actual });
    const message =
      result.kind === "refusal"
        ? "AIがこの内容の読み取りに応じませんでした。通常の読み取り結果はそのまま使えます。"
        : result.kind === "incomplete"
          ? plan.incompleteMessage
          : "AIの処理に失敗しました。通常の読み取り結果はそのまま使えます。";
    return respond(502, { error: `ai_${result.kind}`, message, usage: usageInfo });
  }

  const parsed = plan.parse(result.text);
  deps.log({ event: "ai_assist", requestId, tier, result: parsed ? "ok" : "invalid_output", costMicroUsd: actual });
  if (!parsed) {
    return respond(502, { error: "ai_invalid_output", message: "AIの出力の形式が正しくなかったため、結果を使えませんでした。", usage: usageInfo });
  }
  return respond(200, { ok: true, model: tier, ...(plan.mode === "image" ? { mode: "image" } : {}), ...(plan.mode === "form" ? { mode: "form" } : {}), ...(plan.mode === "pptx" ? { mode: "pptx" } : {}), ...parsed.fields, rejected: parsed.rejected, usage: usageInfo });
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
