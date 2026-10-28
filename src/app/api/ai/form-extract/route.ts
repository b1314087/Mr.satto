import { NextResponse } from "next/server";
import { createAssistDeps, getAiAvailability, getCaller } from "@/lib/ai/server";
import { handleFormExtract } from "@/lib/ai/service";

/**
 * 記入済みPDF→Excelの、AI読み取り補助（Premium限定・利用者が同意したPDFの「文字」だけを処理）。
 * 処理の流れと利用枠の扱いは src/lib/ai/service.ts を参照。
 * リクエスト本文・AIの応答は、ログにもデータベースにも保存しない。
 */
export const maxDuration = 120;

/** 本文の上限。送れる文字は6,000文字までで、JSONにしても余裕をもって収まる大きさ */
const MAX_BODY_BYTES = 120_000;
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
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る内容が大きすぎます。ページを減らしてください。" });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る内容が大きすぎます。ページを減らしてください。" });
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
  const result = await handleFormExtract(deps, caller, availability, body);
  return json(result.status, result.body);
}
