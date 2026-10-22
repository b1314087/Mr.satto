import { NextResponse } from "next/server";
import { createAssistDeps, getAiAvailability, getCaller } from "@/lib/ai/server";
import { handleCalendarAssist } from "@/lib/ai/service";

/**
 * 年度カレンダーの予定表を、AIで読み取る補助（Premium限定・利用者が同意した行だけを処理）。
 * 処理の流れと利用枠の扱いは src/lib/ai/service.ts を参照。
 * リクエスト本文・AIの応答は、ログにもデータベースにも保存しない。
 */
export const maxDuration = 120;

const MAX_BODY_BYTES = 400_000;
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

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る内容が大きすぎます。行や列を減らしてください。" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_request", message: "リクエストの形式が正しくありません。" });
  }

  const availability = getAiAvailability();
  const deps = availability.available ? createAssistDeps() : null;
  if (!deps) {
    return json(503, { error: "unavailable", reason: availability.available ? "not_configured" : availability.reason, message: "AIによる読み取り補助は、現在ご利用いただけません。" });
  }
  const caller = await getCaller();
  const result = await handleCalendarAssist(deps, caller, availability, body);
  return json(result.status, result.body);
}
