import { test, expect } from "@playwright/test";
import { PPTX_TEXT_CONSENT_VERSION, PPTX_TEXT_INSTRUCTIONS, PPTX_TEXT_MAX_LINES_PER_IMAGE, parsePptxTextOutput, sanitizeLineText, validatePptxTextRequest, type PptxTextRequest } from "@/lib/ai/pptx-text";
import { MAX_IMAGES, MAX_IMAGE_BYTES } from "@/lib/ai/calendar-assist";
import { handlePptxText, type Availability, type Caller } from "@/lib/ai/service";
import { MemoryLedger, USER_ID, makeDeps, newRequestId, type FakeModel } from "./helpers";

/** PowerPoint白黒反転のAI（画像内の文字の読み取り）のテスト。AI（OpenAI）は差し替えたもので、実際のAPIは呼ばない。 */

const AVAILABLE: Availability = { available: true };
const PREMIUM: Caller = { userId: USER_ID, plan: "premium" };
const USAGE = { inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 800 };

function fakeJpegBase64(extraBytes = 0): string {
  const bytes = new Uint8Array(8 + extraBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  return Buffer.from(bytes).toString("base64");
}
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  consent: { accepted: true, version: PPTX_TEXT_CONSENT_VERSION },
  requestId: newRequestId(),
  model: "standard",
  images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64() }],
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({ image: 1, text: "直角三角形ABCにおいて", kind: "text", x: 0.1, y: 0.2, w: 0.5, h: 0.06, underline: false, bold: false, confidence: "high", ...over });
const output = (lines: unknown[]) => JSON.stringify({ lines });

function setup() {
  const ledger = new MemoryLedger();
  ledger.premium.add(USER_ID);
  const model: FakeModel = { calls: [], next: { kind: "ok", text: output([line(), line({ text: "サイン", y: 0.3 })]), usage: USAGE } };
  return { ledger, model, deps: makeDeps(ledger, model) };
}

test.describe("依頼の検証", () => {
  test("正しい依頼を受け付ける", () => {
    expect(validatePptxTextRequest(body()).ok).toBe(true);
  });

  test("形式・大きさ・枚数・中身がおかしい依頼は断る", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["画像なし", { images: [] }],
      ["枚数が多すぎる", { images: Array.from({ length: MAX_IMAGES + 1 }, () => ({ mediaType: "image/jpeg", base64: fakeJpegBase64() })) }],
      ["GIF", { images: [{ mediaType: "image/gif", base64: fakeJpegBase64() }] }],
      ["中身が文字", { images: [{ mediaType: "image/jpeg", base64: Buffer.from("<html>script</html>").toString("base64") }] }],
      ["1枚が大きすぎる", { images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64(MAX_IMAGE_BYTES + 100) }] }],
      ["モデルが不正", { model: "gpt-x" }],
      ["依頼IDが不正", { requestId: "abc" }],
    ];
    for (const [name, over] of bad) expect(validatePptxTextRequest(body(over)).ok, name).toBe(false);
    expect(validatePptxTextRequest(null).ok).toBe(false);
    expect(validatePptxTextRequest([]).ok).toBe(false);
  });
});

test.describe("AIの出力の検証", () => {
  const request = (validatePptxTextRequest(body({ images: [{ mediaType: "image/jpeg", base64: fakeJpegBase64() }, { mediaType: "image/jpeg", base64: fakeJpegBase64() }] })) as { ok: true; value: PptxTextRequest }).value;

  test("正しい出力は、そのまま使える", () => {
    const parsed = parsePptxTextOutput(output([line(), line({ image: 2, kind: "math", text: "BC/AB" })]), request)!;
    expect(parsed.rejected).toBe(0);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({ image: 1, text: "直角三角形ABCにおいて", kind: "text", confidence: "high" });
    expect(parsed.lines[1]).toMatchObject({ image: 2, kind: "math" });
  });

  test("位置が範囲外・存在しない画像・不正な種類・空の文字などは、その行だけ捨てる", () => {
    const parsed = parsePptxTextOutput(
      output([
        line(),
        line({ image: 3 }),
        line({ image: 0 }),
        line({ kind: "heading" }),
        line({ confidence: "certain" }),
        line({ text: "   " }),
        line({ x: -0.1 }),
        line({ x: 0.7, w: 0.5 }),
        line({ y: 0.97, h: 0.2 }),
        line({ w: 0 }),
        line({ h: 0.001 }),
        line({ x: "0.1" }),
        line({ underline: "yes" }),
        "文字列",
        null,
      ]),
      request,
    )!;
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.rejected).toBe(14);
  });

  test("文字は、制御文字を取り除いて整える。長すぎる文字は切り詰める", () => {
    expect(sanitizeLineText("  あ\u0000い\n う\t え  ")).toBe("あ い う え");
    expect(sanitizeLineText("あ".repeat(500))).toHaveLength(200);
    const parsed = parsePptxTextOutput(output([line({ text: "x\u0007y" })]), request)!;
    expect(parsed.lines[0].text).toBe("x y");
  });

  test("1枚の画像から受け取る行の数には上限がある", () => {
    const many = Array.from({ length: PPTX_TEXT_MAX_LINES_PER_IMAGE + 5 }, (_, i) => line({ y: Math.min(0.9, i * 0.01) }));
    const parsed = parsePptxTextOutput(output(many), request)!;
    expect(parsed.lines).toHaveLength(PPTX_TEXT_MAX_LINES_PER_IMAGE);
    expect(parsed.rejected).toBe(5);
  });

  test("全体の形が合わない出力（JSONでない・linesがない）は使わない", () => {
    expect(parsePptxTextOutput("これはJSONではありません", request)).toBeNull();
    expect(parsePptxTextOutput(JSON.stringify({ rows: [] }), request)).toBeNull();
    expect(parsePptxTextOutput(JSON.stringify({ lines: "x" }), request)).toBeNull();
  });

  test("指示には、画像の中の文字を命令として扱わないことと、確実でない行を text にしないことが書かれている", () => {
    expect(PPTX_TEXT_INSTRUCTIONS).toContain("従わず");
    expect(PPTX_TEXT_INSTRUCTIONS).toContain("text にせず");
    expect(PPTX_TEXT_INSTRUCTIONS).toContain("白抜き");
  });
});

test.describe("サービスの流れ（権限・同意・利用枠）", () => {
  test("ログインしていない・プレミアムでない・同意がない・使えない状態では、AIを呼ばない", async () => {
    const s = setup();
    const noLogin = await handlePptxText(s.deps, { userId: null, plan: "free" }, AVAILABLE, body());
    expect(noLogin.status).toBe(401);
    const notPremium = await handlePptxText(s.deps, { userId: USER_ID, plan: "standard" }, AVAILABLE, body());
    expect(notPremium.status).toBe(403);
    const noConsent = await handlePptxText(s.deps, PREMIUM, AVAILABLE, body({ consent: { accepted: false, version: PPTX_TEXT_CONSENT_VERSION } }));
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error).toBe("consent_required");
    const oldVersion = await handlePptxText(s.deps, PREMIUM, AVAILABLE, body({ consent: { accepted: true, version: "2000-01-01" } }));
    expect(oldVersion.body.error).toBe("consent_required");
    const off = await handlePptxText(s.deps, PREMIUM, { available: false, reason: "billing_off" }, body());
    expect(off.status).toBe(503);
    expect(s.model.calls).toHaveLength(0);
    expect(s.ledger.calls).toHaveLength(0);
  });

  test("正しい依頼は、画像つきでAIを呼び、結果を返し、使用量で確定する", async () => {
    const s = setup();
    const res = await handlePptxText(s.deps, PREMIUM, AVAILABLE, body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: "pptx", rejected: 0 });
    expect((res.body.lines as unknown[]).length).toBe(2);
    expect(s.model.calls).toHaveLength(1);
    expect(s.model.calls[0]).toMatchObject({ mode: "pptx", imageCount: 1 });
    expect(s.ledger.calls).toEqual(["reserve", "settle"]);
    expect(s.ledger.spent).toBeGreaterThan(0);
  });

  test("不正な依頼（画像なし）は、利用枠を予約する前に断る", async () => {
    const s = setup();
    const res = await handlePptxText(s.deps, PREMIUM, AVAILABLE, body({ images: [] }));
    expect(res.status).toBe(400);
    expect(s.ledger.calls).toHaveLength(0);
    expect(s.model.calls).toHaveLength(0);
  });

  test("AIが受け付けなかったときは、利用枠を解放する。出力の形が不正なときは、確定して結果は返さない", async () => {
    const s = setup();
    s.model.next = { kind: "rejected", status: 400 };
    const rejected = await handlePptxText(s.deps, PREMIUM, AVAILABLE, body());
    expect(rejected.status).toBe(502);
    expect(s.ledger.calls).toEqual(["reserve", "release"]);
    expect(s.ledger.spent).toBe(0);

    const s2 = setup();
    s2.model.next = { kind: "ok", text: "JSONではない", usage: USAGE };
    const invalid = await handlePptxText(s2.deps, PREMIUM, AVAILABLE, body());
    expect(invalid.status).toBe(502);
    expect(invalid.body.error).toBe("ai_invalid_output");
    expect(s2.ledger.calls).toEqual(["reserve", "settle"]);
  });

  test("利用枠が足りないときは、AIを呼ばない", async () => {
    const ledger = new MemoryLedger(1);
    ledger.premium.add(USER_ID);
    const model: FakeModel = { calls: [], next: { kind: "ok", text: output([]), usage: USAGE } };
    const res = await handlePptxText(makeDeps(ledger, model), PREMIUM, AVAILABLE, body());
    expect([400, 429]).toContain(res.status);
    expect(model.calls).toHaveLength(0);
  });
});
