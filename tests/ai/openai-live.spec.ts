import { test, expect } from "@playwright/test";
import { callOpenAi } from "@/lib/ai/openai-client";
import { AI_MODELS, costMicroUsd, type AiModelTier } from "@/lib/ai/pricing";
import { INSTRUCTIONS, OUTPUT_SCHEMA, buildUserInput, parseAssistOutput, type AssistRequest } from "@/lib/ai/calendar-assist";

/**
 * OpenAIへの実接続の確認（任意・手動）。通常のテスト（npm test）では、キーが無いので自動的にスキップされる。
 *
 * 目的: アプリ本体のクライアント(callOpenAi)・指示・出力スキーマ・使用量の読み取り・費用の計算が、
 *       実際のOpenAI APIで通ることを、最小の呼び出し（2行・短い出力）で確かめる。費用は、標準で1円未満、高精度でも数円以下の見込み。
 *
 * 実行できるのは、次の2つが「両方」そろったときだけ（片方だけでは、外部には一切アクセスしない）:
 *   OPENAI_LIVE_KEY=<キー>   と   RUN_OPENAI_LIVE=1
 * CI（環境変数 CI がある実行）では、両方あっても実行しない。失敗しても自動で再実行しない（retries=0）。
 *
 * 実行する場合（本人がMacのターミナルで。キーはチャットに貼らない。画面にも表示されない）:
 *   cd ~/Desktop/Mr-Satto
 *   read -s OPENAI_LIVE_KEY      # ← OpenAIのキーを貼って Enter（入力は表示されない）
 *   export OPENAI_LIVE_KEY RUN_OPENAI_LIVE=1
 *   npx playwright test tests/ai/openai-live.spec.ts --workers=1
 *   unset OPENAI_LIVE_KEY RUN_OPENAI_LIVE
 *
 * キーは、確認専用に新しく作って、確認後に削除するのが安全。
 * リクエスト・応答の本文や、キーは、出力しない（モデル名・件数・トークン数・金額の目安だけを出す）。
 */
const KEY = (process.env.OPENAI_LIVE_KEY ?? "").trim();
const ENABLED = KEY.length > 0 && process.env.RUN_OPENAI_LIVE === "1" && !process.env.CI;

const request: AssistRequest = {
  requestId: "00000000-0000-4000-8000-000000000001",
  model: "standard",
  rangeStart: "2026-04-01",
  rangeEnd: "2027-03-31",
  headers: ["日付", "行事"],
  rows: [
    { row: 2, cells: ["4/8(水)", "入学式 9:30〜11:00"] },
    { row: 3, cells: ["7月20日", "海の日（休み）"] },
  ],
};

test.describe("OpenAI 実接続の確認（OPENAI_LIVE_KEY がある場合だけ）", () => {
  test.skip(!ENABLED, "OPENAI_LIVE_KEY と RUN_OPENAI_LIVE=1 の両方が無い（またはCI）ため、外部には接続せずスキップ");
  // 失敗しても再実行しない（既定の retries=1 だと、外部APIを2回呼んでしまう）
  test.describe.configure({ timeout: 120_000, retries: 0 });

  for (const tier of ["standard", "advanced"] as AiModelTier[]) {
    test(`${AI_MODELS[tier].id}（${AI_MODELS[tier].label}）: 受け付けられ、使用量が読め、出力の検証を通る`, async () => {
      const result = await callOpenAi({
        apiKey: KEY,
        modelId: AI_MODELS[tier].id,
        instructions: INSTRUCTIONS,
        input: buildUserInput({ ...request, model: tier }),
        maxOutputTokens: 2_000,
        schemaName: "calendar_rows",
        schema: OUTPUT_SCHEMA,
        timeoutMs: 90_000,
      });

      // 失敗したときは、分類と（あれば）ステータスだけを出す。本文は出さない。
      expect(result.kind, `結果の分類: ${JSON.stringify({ ...result, text: undefined })}`).toBe("ok");
      if (result.kind !== "ok") return;

      expect(result.usage, "使用量(usage)が読み取れること").not.toBeNull();
      const usage = result.usage!;
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);

      const parsed = parseAssistOutput(result.text, { ...request, model: tier });
      expect(parsed, "出力が、アプリの検証（スキーマ・行番号・日付形式）を通ること").not.toBeNull();
      expect(parsed!.suggestions.length).toBeGreaterThan(0);

      const micro = costMicroUsd(tier, usage);
      console.log(
        `[live] ${AI_MODELS[tier].id}: 入力${usage.inputTokens} / キャッシュ${usage.cachedInputTokens} / 出力${usage.outputTokens} トークン、` +
          `提案${parsed!.suggestions.length}件（捨てた行${parsed!.rejected}）、費用の目安 ${(micro / 1_000_000).toFixed(6)} ドル`
      );
    });
  }

  test("不正なキーは「課金されていない拒否(rejected・401)」と分類される", async () => {
    const result = await callOpenAi({
      apiKey: "sk-invalid-key-for-live-check",
      modelId: AI_MODELS.standard.id,
      instructions: INSTRUCTIONS,
      input: buildUserInput(request),
      maxOutputTokens: 200,
      schemaName: "calendar_rows",
      schema: OUTPUT_SCHEMA,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ kind: "rejected", status: 401 });
  });
});
