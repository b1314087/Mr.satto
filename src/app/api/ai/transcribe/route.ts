import { NextResponse } from "next/server";
import { createAssistDeps, getAiAvailability, getCaller } from "@/lib/ai/server";
import { handleTranscribe } from "@/lib/ai/service";
import { TRANSCRIBE_MAX_BODY_BYTES } from "@/lib/ai/transcribe";

/**
 * AIによる文字起こし（Premium限定・利用者が同意した音声だけを処理）。1回の依頼は約1分までの音声1つ。
 * 長い音声は、ブラウザで区切ってから、1つずつ送ってもらう（サーバーには保存しない）。
 * 処理の流れと利用枠の扱いは src/lib/ai/service.ts の handleTranscribe を参照。
 * 音声・文字起こしの結果は、ログにもデータベースにも保存しない。
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" ? v : undefined;
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
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json(415, { error: "unsupported_media_type", message: "リクエストの形式が正しくありません。" });
  }

  // 本文を読む前に、宣言された大きさで断る。読んだあとも、実際の大きさで確かめる
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > TRANSCRIBE_MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る音声が大きすぎます。" });
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return json(400, { error: "invalid_request", message: "リクエストの形式が正しくありません。" });
  }
  if (buffer.byteLength > TRANSCRIBE_MAX_BODY_BYTES) return json(413, { error: "too_large", message: "送る音声が大きすぎます。" });

  let form: FormData;
  try {
    form = await new Response(buffer, { headers: { "content-type": contentType } }).formData();
  } catch {
    return json(400, { error: "invalid_request", message: "リクエストの形式が正しくありません。" });
  }
  const file = form.get("audio");
  const audio = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : null;

  const availability = getAiAvailability();
  const caller = await getCaller();
  const deps = availability.available ? createAssistDeps(caller.aiLimitMicroUsd) : null;
  if (!deps) {
    return json(503, { error: "unavailable", reason: availability.available ? "not_configured" : availability.reason, message: "AIによる文字起こしは、現在ご利用いただけません。" });
  }
  const result = await handleTranscribe(deps, caller, availability, {
    fields: {
      requestId: field(form, "requestId"),
      language: field(form, "language"),
      prompt: field(form, "prompt"),
      consentAccepted: field(form, "consentAccepted"),
      consentVersion: field(form, "consentVersion"),
    },
    audio,
  });
  return json(result.status, result.body);
}
