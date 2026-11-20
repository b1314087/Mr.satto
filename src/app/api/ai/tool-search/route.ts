import { NextResponse } from "next/server";
import { createAssistDeps, getAiAvailability, getCaller } from "@/lib/ai/server";
import { handleToolSearch } from "@/lib/ai/service";
import { getListedTools } from "@/lib/tools/data";

/**
 * ツール検索の「AIに相談して探す」（Premium限定・利用者が同意した文章だけを処理。2026-11-20）。
 * 利用者の文章と、公開中のツールの一覧（ID・名前・説明だけ）をAIに渡し、合うツールを選んでもらう。
 * 処理の流れと利用枠の扱いは src/lib/ai/service.ts を参照。
 * リクエスト本文・AIの応答は、ログにもデータベースにも保存しない。
 */
export const maxDuration = 60;

/** 本文の上限（300文字までの文章なので小さくてよい） */
const MAX_BODY_BYTES = 8_000;
const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  // 他のサイトからのリクエスト（Cookieつきの不正な送信）を断る
  const origin = request.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === request.headers.get("host");
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return json(403, { error: "forbidden", message: "このリクエストは受け付けられません。" });
  }
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return json(415, { error: "unsupported_media_type", message: "リクエストの形式が正しくありません。" });
  }

  // 本文を読む前に、宣言された大きさで断る（大きすぎる本文をメモリに読み込まない）
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る内容が大きすぎます。" });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る内容が大きすぎます。" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_request", message: "リクエストの形式が正しくありません。" });
  }

  const availability = getAiAvailability();
  const caller = await getCaller();
  const deps = availability.available ? createAssistDeps(caller.aiLimitMicroUsd) : null;
  if (!deps) {
    return json(503, { error: "unavailable", reason: availability.available ? "not_configured" : availability.reason, message: "AIに相談して探す機能は、現在ご利用いただけません。" });
  }
  // AIに渡すのは、公開中（使える）ツールの ID・名前・説明だけ
  const catalog = getListedTools()
    .filter((t) => t.status === "available")
    .map((t) => ({ id: t.id, name: t.name, description: t.description }));
  const result = await handleToolSearch(deps, caller, availability, body, catalog);
  return json(result.status, result.body);
}
