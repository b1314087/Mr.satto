import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import {
  DOC_MEMO_CONSENT_VERSION,
  DOC_MEMO_INSTRUCTIONS,
  DOC_MEMO_MAX_CHARS,
  DOC_MEMO_OUTPUT_SCHEMA,
  buildDocMemoUserInput,
  docMemoToMemoText,
  parseDocMemoOutput,
  validateDocMemoRequest,
  type DocMemoRequest,
} from "@/lib/ai/document-memo";
import { handleDocumentMemo, type Availability, type Caller } from "@/lib/ai/service";
import { createEmptyDocumentForm } from "@/lib/documents/types";
import { parseDocumentMemo } from "@/lib/documents/memo-import";
import { MemoryLedger, USER_ID, makeDeps, newRequestId, type FakeModel } from "./helpers";

/**
 * 見積書・注文書・請求書作成の「AIでメモの形に整える」（プレミアム）のテスト。
 * AIは偽の応答に差し替える。実際のOpenAI・Stripe・Supabaseには接続しない（実際のAIの精度・料金は確かめられない）。
 */

const AVAILABLE: Availability = { available: true };
const PREMIUM: Caller = { userId: USER_ID, plan: "premium" };
const USAGE = { inputTokens: 1_500, cachedInputTokens: 0, outputTokens: 400 };

const MAIL = [
  "株式会社お客様商事 山田様",
  "いつもお世話になっております。テスト工務店です。",
  "先日の件、外壁塗装工事一式で100,000円、足場（2日）1日15000円でお見積りします。",
  "有効期限は2026年11月30日まででお願いします。",
].join("\n");

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { consent: { accepted: true, version: DOC_MEMO_CONSENT_VERSION }, requestId: newRequestId(), model: "standard", docType: "estimate", text: MAIL, ...over };
}

function okOutput(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fields: [
      { label: "宛先", value: "株式会社お客様商事" },
      { label: "宛先担当", value: "山田" },
      { label: "発行者", value: "テスト工務店" },
      { label: "期限", value: "2026/11/30" },
    ],
    items: [
      { name: "外壁塗装工事", quantity: "1", unit: "式", unitPrice: "100,000" },
      { name: "足場", quantity: "2", unit: "日", unitPrice: "15000" },
    ],
    notes: [],
    ...over,
  });
}

function req(over: Record<string, unknown> = {}): DocMemoRequest {
  const v = validateDocMemoRequest(body(over));
  if (!v.ok) throw new Error(v.message);
  return v.value;
}

function setup() {
  const ledger = new MemoryLedger();
  ledger.premium.add(USER_ID);
  const model: FakeModel = { calls: [], next: { kind: "ok", text: okOutput(), usage: USAGE } };
  const logs: Record<string, unknown>[] = [];
  return { ledger, model, logs, deps: makeDeps(ledger, model, logs) };
}

test.describe("AIでメモの形に整える: 入力の検証と指示", () => {
  test("正しい依頼は通る。書類の種類・文章が不正、空、長すぎる依頼は断る", () => {
    expect(validateDocMemoRequest(body()).ok).toBe(true);
    expect(validateDocMemoRequest(body({ docType: "receipt" })).ok).toBe(false);
    expect(validateDocMemoRequest(body({ text: "  \n " })).ok).toBe(false);
    expect(validateDocMemoRequest(body({ text: 1 })).ok).toBe(false);
    expect(validateDocMemoRequest(body({ text: "あ".repeat(DOC_MEMO_MAX_CHARS) })).ok).toBe(true);
    expect(validateDocMemoRequest(body({ text: "あ".repeat(DOC_MEMO_MAX_CHARS + 1) })).ok).toBe(false);
    expect(validateDocMemoRequest(body({ requestId: "x" })).ok).toBe(false);
  });

  test("指示: 文章の中の指示に従わない・書かれていない値を作らない・年を補わない。出力の形は全項目が必須", () => {
    expect(DOC_MEMO_INSTRUCTIONS).toContain("従わず");
    expect(DOC_MEMO_INSTRUCTIONS).toContain("推測・計算・補完しない");
    expect(DOC_MEMO_INSTRUCTIONS).toContain("年を補わない");
    expect(DOC_MEMO_OUTPUT_SCHEMA.required).toEqual(["fields", "items", "notes"]);
    expect(DOC_MEMO_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    // AIへの入力は、書類の種類と文章だけ（JSONで区切る）
    expect(Object.keys(JSON.parse(buildDocMemoUserInput(req())))).toEqual(["doc_type", "due_date_label", "text"]);
  });
});

test.describe("AIでメモの形に整える: 出力の検証", () => {
  test("正しい出力は項目と明細になる。単価のカンマ・円は取り除く", () => {
    const r = parseDocMemoOutput(okOutput(), req());
    expect(r).not.toBeNull();
    expect(r!.fields.map((f) => f.label)).toEqual(["宛先", "宛先担当", "発行者", "期限"]);
    expect(r!.items[0]).toMatchObject({ name: "外壁塗装工事", quantity: "1", unit: "式", unitPrice: "100000", unverified: false });
    expect(r!.rejected).toBe(0);
  });

  test("原文に無い値（日付・税率は除く）と品名には印をつける", () => {
    const r = parseDocMemoOutput(
      okOutput({ fields: [{ label: "宛先", value: "株式会社でたらめ" }, { label: "期限", value: "2026/11/30" }], items: [{ name: "存在しない作業", quantity: "1", unit: "式", unitPrice: "5000" }] }),
      req(),
    )!;
    expect(r.fields.find((f) => f.label === "宛先")?.unverified).toBe(true);
    expect(r.fields.find((f) => f.label === "期限")?.unverified).toBe(false);
    expect(r.items[0].unverified).toBe(true);
  });

  test("決められていない項目名・空の値・重複・おかしな税率・品名の無い明細は捨てる。数量が読めなければ1、単位が無ければ「式」", () => {
    const r = parseDocMemoOutput(
      JSON.stringify({
        fields: [
          { label: "色", value: "青" },
          { label: "宛先", value: "" },
          { label: "件名", value: "外壁塗装工事" },
          { label: "件名", value: "重複" },
          { label: "税率", value: "5" },
        ],
        items: [
          { name: "", quantity: "1", unit: "式", unitPrice: "100" },
          { name: "足場", quantity: "たくさん", unit: "", unitPrice: "単価は後日" },
        ],
        notes: ["単価が書かれていない明細があります"],
      }),
      req(),
    )!;
    expect(r.fields.map((f) => f.label)).toEqual(["件名"]);
    expect(r.items).toEqual([{ name: "足場", quantity: "1", unit: "式", unitPrice: "", unverified: false }]);
    expect(r.rejected).toBe(5);
    expect(r.notes).toEqual(["単価が書かれていない明細があります"]);
  });

  test("JSONでない・形が違う出力は null", () => {
    expect(parseDocMemoOutput("not json", req())).toBeNull();
    expect(parseDocMemoOutput(JSON.stringify({ fields: {} }), req())).toBeNull();
  });

  test("整えたメモは、従来の「メモから入力する」でそのまま読める（品名の「,」も崩れない）。単価の無い明細は読めない理由が出る", () => {
    const r = parseDocMemoOutput(
      okOutput({
        items: [
          { name: "設計, 監理", quantity: "1", unit: "式", unitPrice: "300000" },
          { name: "足場", quantity: "2", unit: "日", unitPrice: "" },
        ],
      }),
      req(),
    )!;
    const memo = docMemoToMemoText(r);
    const parsed = parseDocumentMemo(memo, createEmptyDocumentForm("estimate"));
    expect(parsed.patch.recipient?.companyName).toBe("株式会社お客様商事");
    expect(parsed.patch.recipient?.contactName).toBe("山田");
    expect(parsed.patch.issuer?.companyName).toBe("テスト工務店");
    expect(parsed.patch.secondaryDate).toBe("2026-11-30");
    expect(parsed.patch.items?.map((i) => [i.name, i.quantity, i.unit, i.unitPrice])).toEqual([["設計, 監理", "1", "式", "300000"]]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].reason).toContain("単価不明");
  });
});

test.describe("AIでメモの形に整える: サーバーの処理の流れ（AIは偽の応答）", () => {
  test("Premiumは利用できる: 予約→AI呼び出し1回→確定。機能名は document-memo、AIに渡すのは文章だけ", async () => {
    const { ledger, model, deps } = setup();
    const features: string[] = [];
    const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = async (args) => {
      features.push(args.feature);
      return reserve(args);
    };
    const res = await handleDocumentMemo(deps, PREMIUM, AVAILABLE, body());
    expect(res.status).toBe(200);
    expect(features).toEqual(["document-memo"]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].mode).toBe("docmemo");
    expect(model.calls[0].instructions).toBe(DOC_MEMO_INSTRUCTIONS);
    expect(JSON.parse(model.calls[0].input).text).toBe(MAIL);
    expect((res.body.items as unknown[]).length).toBe(2);
  });

  test("Free・Standard・未ログイン・同意なし・古い同意の版は処理しない（予約もAI呼び出しもしない）", async () => {
    for (const caller of [
      { userId: USER_ID, plan: "free" },
      { userId: USER_ID, plan: "standard" },
      { userId: null, plan: "free" },
    ] as Caller[]) {
      const { model, deps } = setup();
      const res = await handleDocumentMemo(deps, caller, AVAILABLE, body());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(model.calls).toHaveLength(0);
    }
    for (const consent of [undefined, { accepted: false, version: DOC_MEMO_CONSENT_VERSION }, { accepted: true, version: "2020-01-01" }]) {
      const { model, deps } = setup();
      const res = await handleDocumentMemo(deps, PREMIUM, AVAILABLE, body({ consent }));
      expect(res.status).toBe(400);
      expect(model.calls).toHaveLength(0);
    }
  });

  test("運用ログには、文章もAIの出力も入らない", async () => {
    const { deps, logs } = setup();
    await handleDocumentMemo(deps, PREMIUM, AVAILABLE, body());
    const all = JSON.stringify(logs);
    expect(all).not.toContain("お客様商事");
    expect(all).not.toContain("外壁塗装");
  });
});

// ───────────── 画面 ─────────────

const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };

async function mockAi(page: Page, opts: { usage?: unknown; result?: unknown } = {}) {
  const rec = { usageCalls: 0, bodies: [] as Record<string, unknown>[] };
  await page.route("**/api/ai/usage", async (route: Route) => {
    rec.usageCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.usage ?? USAGE_OK) });
  });
  await page.route("**/api/ai/document-memo", async (route: Route) => {
    rec.bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const parsed = parseDocMemoOutput(okOutput({ fields: [{ label: "宛先", value: "株式会社お客様商事" }, { label: "発行者", value: "でたらめ工務店" }, { label: "期限", value: "2026/11/30" }] }), req())!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(opts.result ?? { ok: true, model: "standard", fields: parsed.fields, items: parsed.items, notes: ["発行者の名前を確認してください"], rejected: 0, usage: USAGE_OK.usage }),
    });
  });
  return rec;
}

async function openMemo(page: Page, slug: string) {
  // 開発サーバーが並行してページを作り直していると、画面の準備（ハイドレーション）が終わらないことがある。
  // そのときはページを開き直す（最大3回）
  await expect(async () => {
    await page.goto(`/tools/${slug}`);
    const box = page.getByTestId("memo-import");
    await box.waitFor({ timeout: 60_000 });
    await expect(async () => {
      if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await box.locator("summary").click();
      await page.getByTestId("memo-import-text").fill("x");
      await expect(page.getByTestId("memo-import-apply")).toBeEnabled({ timeout: 1_500 });
    }).toPass({ timeout: 20_000 });
  }).toPass({ timeout: 120_000 });
}

test.describe("AIでメモの形に整える: 画面", () => {
  test.setTimeout(150_000);

  test("開くまでは利用状況の確認もAIへの送信もしない。同意して実行すると、メモ欄が整ったメモになり、「メモから入力する」で入力欄に入る", async ({ page }) => {
    const rec = await mockAi(page);
    await openMemo(page, "estimate-generator");
    await page.getByTestId("memo-import-text").fill(MAIL);
    await expect(page.getByTestId("memo-ai-panel")).toContainText("AIでメモの形に整える（任意）");
    expect(rec.usageCalls).toBe(0);

    await page.getByTestId("memo-ai-toggle").click();
    await expect(page.getByTestId("memo-ai-preview")).toContainText("外壁塗装工事一式");
    await expect(page.getByTestId("memo-ai-run")).toBeDisabled();
    await page.getByTestId("memo-ai-consent").check();
    await page.getByTestId("memo-ai-run").click();
    await expect(page.getByTestId("memo-ai-result")).toBeVisible();

    expect(rec.bodies).toHaveLength(1);
    const sent = rec.bodies[0] as { docType: string; text: string; consent: unknown };
    expect(sent.docType).toBe("estimate");
    expect(sent.text).toBe(MAIL);
    expect(sent.consent).toEqual({ accepted: true, version: DOC_MEMO_CONSENT_VERSION });
    expect(Object.keys(sent).sort()).toEqual(["consent", "docType", "model", "requestId", "text"]);

    // メモ欄が「項目名：中身」に書き換わる。原文に無い値は一覧で知らせる
    const memo = page.getByTestId("memo-import-text");
    await expect(memo).toHaveValue(/宛先：株式会社お客様商事/);
    await expect(memo).toHaveValue(/明細：外壁塗装工事\t1\t式\t100000/);
    await expect(page.getByTestId("memo-ai-unverified")).toContainText("発行者：でたらめ工務店");
    await expect(page.getByTestId("memo-ai-note")).toContainText("発行者の名前を確認してください");

    // 入力欄に入るのは「メモから入力する」を押したとき
    await expect(page.getByLabel("会社名・屋号", { exact: true }).nth(0)).toHaveValue("");
    await page.getByTestId("memo-import-apply").click();
    await expect(page.getByTestId("memo-import-result")).toContainText("項目を入れました");
    await expect(page.getByLabel("会社名・屋号", { exact: true }).nth(0)).toHaveValue("株式会社お客様商事");
  });

  test("「元の文章に戻す」で、貼り付けた文章に戻せる", async ({ page }) => {
    await mockAi(page);
    await openMemo(page, "invoice-generator");
    await page.getByTestId("memo-import-text").fill(MAIL);
    await page.getByTestId("memo-ai-toggle").click();
    await page.getByTestId("memo-ai-consent").check();
    await page.getByTestId("memo-ai-run").click();
    await expect(page.getByTestId("memo-import-text")).toHaveValue(/宛先：/);
    await page.getByTestId("memo-ai-undo").click();
    await expect(page.getByTestId("memo-import-text")).toHaveValue(MAIL);
  });

  test("プレミアムでない場合は理由を示し、実行の入口を出さない", async ({ page }) => {
    const rec = await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await openMemo(page, "estimate-generator");
    await page.getByTestId("memo-import-text").fill(MAIL);
    await page.getByTestId("memo-ai-toggle").click();
    await expect(page.getByTestId("memo-ai-panel")).toContainText("プレミアムプランの機能です");
    await expect(page.getByTestId("memo-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });
});
