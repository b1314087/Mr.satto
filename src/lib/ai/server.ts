import "server-only";

import { featureFlags } from "@/lib/config/features";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { getServerPlan } from "@/lib/plans/current-plan";
import { resolveAiPlan } from "@/lib/plans/effective-plan";
import { createRpcLedger, type Ledger } from "./ledger";
import { buildImageInput, callOpenAi, type OpenAiInputMessage } from "./openai-client";
import { AI_MODELS } from "./pricing";
import { IMAGE_OUTPUT_SCHEMA, OUTPUT_SCHEMA } from "./calendar-assist";
import type { Availability, AssistDeps, Caller } from "./service";

/**
 * AI補助のサーバー側の接続（環境変数・認証・データベース）。ここだけが秘密情報を扱う。
 *
 * 必要な環境変数（サーバー側のみ。NEXT_PUBLIC_ は付けない）:
 *   OPENAI_API_KEY               OpenAIのAPIキー。未設定の間は、AI補助は「利用不可」になる
 *   SUPABASE_SERVICE_ROLE_KEY    利用台帳の関数（service_roleだけが実行できる）を呼ぶために必要（既存）
 *
 * 課金の機能スイッチ（featureFlags.billing）がオフの間も、AI補助は利用不可（画面の入口も出さない）。
 * Vercelのプレビュー環境（VERCEL_ENV=preview）では、APIキーが設定されていても利用不可にする
 * （プレビューのたびに本物のAPIを呼ばないため。キーはProductionにだけ設定する運用）。
 */
const TIMEOUT_MS = 100_000;

export function getAiAvailability(): Availability {
  // AIはPremium限定の機能。課金システムがオフの間（src/lib/config/features.ts）は、キーが設定されていても利用不可にする
  if (!featureFlags.billing) return { available: false, reason: "billing_off" };
  if (process.env.VERCEL_ENV === "preview") return { available: false, reason: "preview" };
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (key.length === 0 || !getSupabaseServiceClient()) return { available: false, reason: "not_configured" };
  return { available: true };
}

/**
 * 現在のリクエストの利用者とプラン（開発用のプラン上書きでは利用者IDが無いため、AIは使えない）。
 * 契約の期間が過ぎても更新が確認できない契約は、AIだけ使えないものとして扱う（resolveAiPlan）。
 */
export async function getCaller(): Promise<Caller> {
  const ctx = await getServerPlan();
  return { userId: ctx.userId, plan: resolveAiPlan(ctx.plan, ctx.subscription, Date.now()) };
}

export function getLedger(): Ledger | null {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return null;
  return createRpcLedger(async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    return { data, error: error ? { message: error.message } : null };
  });
}

export function createAssistDeps(): AssistDeps | null {
  const ledger = getLedger();
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!ledger || apiKey.length === 0) return null;
  return {
    ledger,
    callModel: ({ tier, instructions, input, maxOutputTokens, mode, images }) => {
      const isImage = mode === "image" && images !== undefined && images.length > 0;
      const aiInput: string | OpenAiInputMessage[] = isImage ? buildImageInput(input, images) : input;
      return callOpenAi({
        apiKey,
        modelId: AI_MODELS[tier].id,
        instructions,
        input: aiInput,
        maxOutputTokens,
        schemaName: isImage ? "calendar_image_events" : "calendar_rows",
        schema: isImage ? IMAGE_OUTPUT_SCHEMA : OUTPUT_SCHEMA,
        timeoutMs: TIMEOUT_MS,
      });
    },
    // 運用ログ。本文は含まれない（呼び出し側が渡さない）
    log: (event) => console.info("[ai]", JSON.stringify(event)),
  };
}
