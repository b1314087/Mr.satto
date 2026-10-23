import { test, expect } from "@playwright/test";
import {
  CONSENT_VERSION,
  IMAGE_OUTPUT_SCHEMA,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  estimateImageInputTokens,
  parseImageAssistOutput,
  validateImageAssistRequest,
  type ImageAssistRequest,
} from "@/lib/ai/calendar-assist";
import { buildImageInput, callOpenAi } from "@/lib/ai/openai-client";
import { handleCalendarAssist, type Availability, type Caller } from "@/lib/ai/service";
import { costMicroUsd, reserveMicroUsd } from "@/lib/ai/pricing";
import { MemoryLedger, RANGE, USER_ID, makeDeps, newRequestId, type FakeModel } from "./helpers";

/**
 * 画像・スキャンPDFの読み取り（画像モード）のテスト。AI（OpenAI）は差し替えたもので、実際のAPIは呼ばない。
 * 実際のOpenAIの画像入力の挙動・トークン消費は、ここでは確認していない（実機で別途確認が必要）。
 */

const AVAILABLE: Availability = { available: true };
const PREMIUM: Caller = { userId: USER_ID, plan: "premium" };
const USAGE = { inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 800 };

/** JPEGの先頭だけを持つ、小さな偽の画像（形式の検査を通る。AIは差し替えているので中身は使われない） */
function fakeJpegBase64(extraBytes = 0): string {
  const bytes = new Uint8Array(8 + extraBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  return Buffer.from(bytes).toString("base64");
}
function fakePngBase64(): string {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
}

function imageBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "image",
    source: "image",
    consent: { accepted: true, version: CONSENT_VERSION },
    requestId: newRequestId(),
    model: "standard",
    ...RANGE,
    images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64() }],
    ...over,
  };
}

const item = (n: number, over: Record<string, unknown> = {}) => ({
  item: n,
  page: 1,
  date: "2027-04-05",
  title: "入学式",
  start_time: "10:00",
  end_time: null,
  weekday: "月",
  source_text: "4/5(月) 入学式",
  confidence: "high",
  inferred: false,
  note: "",
  ...over,
});
const imageOutput = (items: unknown[]) => JSON.stringify({ suggestions: items });

function setup(limit?: number) {
  const ledger = new MemoryLedger(limit);
  ledger.premium.add(USER_ID);
  const model: FakeModel = { calls: [], next: { kind: "ok", text: imageOutput([item(1), item(2, { date: "2027-04-06", title: "始業式" })]), usage: USAGE } };
  return { ledger, model, deps: makeDeps(ledger, model) };
}

test.describe("画像モード: 依頼の検証", () => {
  test("JPEG・PNGの画像を受け付ける", () => {
    const v = validateImageAssistRequest(imageBody({ images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64() }, { mediaType: "image/png", base64: fakePngBase64() }] }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.images).toHaveLength(2);
  });

  test("形式・大きさ・枚数・中身がおかしい依頼は断る", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["画像なし", { images: [] }],
      ["枚数が多すぎる", { images: Array.from({ length: MAX_IMAGES + 1 }, () => ({ mediaType: "image/jpeg", base64: fakeJpegBase64() })) }],
      ["GIF", { images: [{ mediaType: "image/gif", base64: fakeJpegBase64() }] }],
      ["WebP", { images: [{ mediaType: "image/webp", base64: fakeJpegBase64() }] }],
      ["base64でない", { images: [{ mediaType: "image/jpeg", base64: "これは画像ではありません" }] }],
      ["data: の接頭辞つき", { images: [{ mediaType: "image/jpeg", base64: `data:image/jpeg;base64,${fakeJpegBase64()}` }] }],
      ["申告はJPEGだが中身がPNG", { images: [{ mediaType: "image/jpeg", base64: fakePngBase64() }] }],
      ["申告はPNGだが中身がJPEG", { images: [{ mediaType: "image/png", base64: fakeJpegBase64() }] }],
      ["中身が文字", { images: [{ mediaType: "image/jpeg", base64: Buffer.from("<html>script</html>").toString("base64") }] }],
      ["1枚が大きすぎる", { images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64(MAX_IMAGE_BYTES + 100) }] }],
      ["合計が大きすぎる", { images: Array.from({ length: 4 }, () => ({ mediaType: "image/jpeg", base64: fakeJpegBase64(MAX_IMAGE_BYTES - 100) })) }],
      ["種類が不正", { source: "excel" }],
      ["年度の範囲が逆", { rangeStart: "2028-04-01", rangeEnd: "2027-04-01" }],
      ["モデルが不正", { model: "gpt-x" }],
      ["依頼IDが不正", { requestId: "abc" }],
    ];
    for (const [name, over] of bad) {
      expect(validateImageAssistRequest(imageBody(over)).ok, name).toBe(false);
    }
  });
});

test.describe("画像モード: AIの出力の検証", () => {
  const request = (validateImageAssistRequest(imageBody({ images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64() }, { mediaType: "image/png", base64: fakePngBase64() }] })) as { ok: true; value: ImageAssistRequest }).value;

  test("正しい出力は、そのまま使える（曜日・元の文字・ページも保つ）", () => {
    const parsed = parseImageAssistOutput(imageOutput([item(1), item(2, { page: 2, weekday: null })]), request)!;
    expect(parsed.rejected).toBe(0);
    expect(parsed.suggestions).toHaveLength(2);
    expect(parsed.suggestions[0]).toMatchObject({ row: 1, date: "2027-04-05", title: "入学式", startTime: "10:00", weekday: "月", sourceText: "4/5(月) 入学式", page: 1 });
    expect(parsed.suggestions[1].page).toBe(2);
  });

  test("形式の誤り・重複・範囲外の番号・存在しないページ・不正な曜日は、その予定だけ捨てる", () => {
    const parsed = parseImageAssistOutput(
      imageOutput([
        item(1),
        item(1, { title: "重複" }),
        item(0),
        item(101),
        item(3, { date: "2027-02-30" }),
        item(4, { start_time: "25:00" }),
        item(5, { page: 3 }),
        item(6, { weekday: "月曜日" }),
        item(7, { confidence: "certain" }),
        item(8, { title: "あ".repeat(201) }),
        "文字列",
        null,
        item(9, { date: "2027-04-09", title: "給食開始", weekday: "金" }),
      ]),
      request,
    )!;
    expect(parsed.suggestions.map((s) => s.row)).toEqual([1, 9]);
    expect(parsed.rejected).toBe(11);
  });

  test("日付か予定名が読めていない予定は、確度を低くして返す（確実なものとして扱わない）", () => {
    const parsed = parseImageAssistOutput(imageOutput([item(1, { date: null }), item(2, { title: null })]), request)!;
    expect(parsed.suggestions.map((s) => s.confidence)).toEqual(["low", "low"]);
  });

  test("全体が壊れている出力は null", () => {
    expect(parseImageAssistOutput("not json", request)).toBeNull();
    expect(parseImageAssistOutput(JSON.stringify({ other: [] }), request)).toBeNull();
    expect(parseImageAssistOutput(JSON.stringify({ suggestions: "x" }), request)).toBeNull();
  });

  test("出力のスキーマ(strict)は、全項目が必須で追加の項目を許さない", () => {
    const props = Object.keys(IMAGE_OUTPUT_SCHEMA.properties.suggestions.items.properties);
    expect([...IMAGE_OUTPUT_SCHEMA.properties.suggestions.items.required].sort()).toEqual([...props].sort());
    expect(IMAGE_OUTPUT_SCHEMA.properties.suggestions.items.additionalProperties).toBe(false);
  });
});

test.describe("画像モード: サービスの流れ（権限・同意・利用枠）", () => {
  test("Premium: 予約→AI呼び出し1回（画像つき）→実際の使用量で確定。提案が返る", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody({ source: "scanned-pdf" }));
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ modelId: "gpt-6-luna", mode: "image", imageCount: 1 });
    // 画像そのものは、AIへの文字の入力には混ぜない（画像は別の入力として渡る）
    expect(model.calls[0].input).not.toContain(fakeJpegBase64());
    expect(model.calls[0].input).toContain("range_start");
    expect(ledger.calls).toEqual(["reserve", "settle"]);
    expect(ledger.spent).toBe(costMicroUsd("standard", USAGE));
    expect(ledger.reserved).toBe(0);
    const body = res.body as { mode: string; source: string; suggestions: { row: number }[]; usage: { usedAiTokens: number } };
    expect(body.mode).toBe("image");
    expect(body.source).toBe("scanned-pdf");
    expect(body.suggestions.map((s) => s.row)).toEqual([1, 2]);
    expect(JSON.stringify(res.body)).not.toMatch(/micro|usd|円/i);
  });

  test("高精度は gpt-6.1-sol で呼び、その単価で確定する", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody({ model: "advanced" }));
    expect(res.status).toBe(200);
    expect(model.calls[0].modelId).toBe("gpt-6.1-sol");
    expect(ledger.spent).toBe(costMicroUsd("advanced", USAGE));
  });

  test("未ログイン・Free・Standardは、画像を見る前に断る（予約もAI呼び出しもしない）", async () => {
    const { ledger, model, deps } = setup();
    expect((await handleCalendarAssist(deps, { userId: null, plan: "free" }, AVAILABLE, imageBody())).status).toBe(401);
    for (const plan of ["free", "standard"] as const) {
      expect((await handleCalendarAssist(deps, { userId: USER_ID, plan }, AVAILABLE, imageBody())).status, plan).toBe(403);
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("同意が無い・版が違う場合は、何も処理せずAIを呼ばない", async () => {
    const { ledger, model, deps } = setup();
    for (const consent of [undefined, { accepted: false, version: CONSENT_VERSION }, { accepted: true, version: "2020-01-01" }]) {
      const body = imageBody();
      if (consent === undefined) delete body.consent;
      else body.consent = consent;
      const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("consent_required");
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("不正な画像は、予約もAI呼び出しもしない", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody({ images: [{ mediaType: "image/jpeg", base64: fakePngBase64() }] }));
    expect(res.status).toBe(400);
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("APIキー未設定・プレビュー環境・課金オフでは利用不可（AIを呼ばない）", async () => {
    const { ledger, model, deps } = setup();
    for (const reason of ["not_configured", "preview", "billing_off"] as const) {
      expect((await handleCalendarAssist(deps, PREMIUM, { available: false, reason }, imageBody())).status).toBe(503);
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("利用枠が足りないときは、AIを呼ばない（429）", async () => {
    const { ledger, model, deps } = setup(1_000);
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody());
    expect(res.status).toBe(429);
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toEqual(["reserve"]);
  });

  test("同じ依頼IDの再送は、AIを二重に呼ばない（409）", async () => {
    const { ledger, model, deps } = setup();
    const body = imageBody();
    expect((await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body)).status).toBe(200);
    const again = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
    expect(again.status).toBe(409);
    expect(model.calls).toHaveLength(1);
    expect(ledger.spent).toBe(costMicroUsd("standard", USAGE));
  });

  test("OpenAIが入力を受け付けなかったとき（400）だけ、予約を解放する", async () => {
    const { ledger, model, deps } = setup();
    model.next = { kind: "rejected", status: 400 };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody());
    expect(res.status).toBe(502);
    expect(ledger.calls).toEqual(["reserve", "release"]);
    expect(ledger.spent).toBe(0);
    expect(ledger.reserved).toBe(0);
  });

  test("タイムアウトは、解放も確定もしない（課金されたか分からないため）", async () => {
    const { ledger, model, deps } = setup();
    model.next = { kind: "unknown", reason: "timeout" };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody());
    expect(res.status).toBe(504);
    expect(ledger.calls).toEqual(["reserve"]);
    expect(ledger.reserved).toBeGreaterThan(0);
  });

  test("AIの出力が不正でも、使用量は確定する（処理はされているため）", async () => {
    const { ledger, model, deps } = setup();
    model.next = { kind: "ok", text: "これはJSONではありません", usage: USAGE };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody());
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("ai_invalid_output");
    expect(ledger.calls).toEqual(["reserve", "settle"]);
  });

  test("途中で切れた応答は、枚数を減らす案内を出す", async () => {
    const { model, deps } = setup();
    model.next = { kind: "incomplete", usage: USAGE };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, imageBody());
    expect(res.status).toBe(502);
    expect((res.body as { message: string }).message).toContain("画像");
  });

  test("予約額: 画像1枚あたりの見積りが入り、4枚でも1回の上限（期間の1/4）に収まる", () => {
    const req = (n: number) =>
      (validateImageAssistRequest(imageBody({ images: Array.from({ length: n }, () => ({ mediaType: "image/jpeg", base64: fakeJpegBase64() })) })) as { ok: true; value: ImageAssistRequest }).value;
    expect(estimateImageInputTokens(req(4))).toBeGreaterThan(estimateImageInputTokens(req(1)) + 3 * 5_000);
    const reserved = reserveMicroUsd("advanced", estimateImageInputTokens(req(4)), 15_000);
    expect(reserved).toBeLessThan(3_000_000 / 4);
  });
});

test.describe("画像モード: OpenAIへの渡し方", () => {
  test("画像は input_image（data: URL・detail=high）で渡し、保存はさせない。キーはヘッダーだけ", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
    }) as typeof fetch;
    const input = buildImageInput('{"range_start":"2027-04-01"}', [{ mediaType: "image/jpeg", base64: "QUJD" }]);
    await callOpenAi({ apiKey: "sk-test-secret", modelId: "gpt-6-luna", instructions: "指示", input, maxOutputTokens: 3000, schemaName: "calendar_image_events", schema: IMAGE_OUTPUT_SCHEMA, timeoutMs: 1000, fetchImpl });
    expect(captured).not.toBeNull();
    const body = JSON.parse(String((captured as unknown as { init: RequestInit }).init.body));
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: '{"range_start":"2027-04-01"}' }, { type: "input_image", image_url: "data:image/jpeg;base64,QUJD", detail: "high" }] },
    ]);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "calendar_image_events", strict: true });
    expect(String((captured as unknown as { init: RequestInit }).init.body)).not.toContain("sk-test-secret");
  });
});
