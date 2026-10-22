import { test, expect } from "@playwright/test";
import {
  AI_MODELS,
  AI_PERIOD_LIMIT_MICRO_USD,
  JPY_PER_USD,
  costMicroUsd,
  estimateInputTokens,
  formatAiTokens,
  microUsdToAiTokens,
  reserveMicroUsd,
} from "@/lib/ai/pricing";

/** 期待値はこのファイルに直接書く（実装から作らない）。単価は2026-10-22時点のOpenAI公式資料。 */
test.describe("AI料金計算", () => {
  test("モデルID（公式資料で確認したもの）", () => {
    expect(AI_MODELS.standard.id).toBe("gpt-6-luna");
    expect(AI_MODELS.advanced.id).toBe("gpt-6.1-sol");
  });

  test("標準モデル: 入力2万・出力8千 = 6,500 µUSD（キャッシュ書き込み単価で多めに数える）", () => {
    // 入力 20,000 × 0.125µ + 出力 8,000 × 0.5µ = 2,500 + 4,000
    expect(costMicroUsd("standard", { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 8_000 })).toBe(6_500);
  });

  test("高精度モデル: 入力2万・出力8千 = 130,000 µUSD", () => {
    // 20,000 × 2.5µ + 8,000 × 10µ = 50,000 + 80,000
    expect(costMicroUsd("advanced", { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 8_000 })).toBe(130_000);
  });

  test("キャッシュ入力は安い単価で数える", () => {
    // 10,000 × 0.125µ + 10,000 × 0.01µ + 8,000 × 0.5µ = 1,250 + 100 + 4,000
    expect(costMicroUsd("standard", { inputTokens: 20_000, cachedInputTokens: 10_000, outputTokens: 8_000 })).toBe(5_350);
  });

  test("端数は切り上げる", () => {
    expect(costMicroUsd("standard", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 })).toBe(1);
    expect(costMicroUsd("standard", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  test("入力が272Kを超えると、入力2倍・出力1.5倍（リクエスト全体）", () => {
    // 300,000 × 0.125µ × 2 + 1,000 × 0.5µ × 1.5 = 75,000 + 750
    expect(costMicroUsd("standard", { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 1_000 })).toBe(75_750);
    // ちょうど272,000は割増しなし
    expect(costMicroUsd("standard", { inputTokens: 272_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(34_000);
  });

  test("不正な値（負・小数・キャッシュが入力より多い）でも、負やNaNにならない", () => {
    const c = costMicroUsd("standard", { inputTokens: -5, cachedInputTokens: 100, outputTokens: 2.9 });
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(costMicroUsd("standard", { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 })).toBe(1); // キャッシュは入力を超えない
  });

  test("予約額は、最悪ケース（キャッシュなし・出力は上限いっぱい）の1.1倍", () => {
    expect(reserveMicroUsd("standard", 20_000, 8_000)).toBe(7_150);
    expect(reserveMicroUsd("advanced", 20_000, 8_000)).toBe(143_000);
  });

  test("確定額は、見積りの範囲内の使用量であれば、予約額を超えない", () => {
    for (const tier of ["standard", "advanced"] as const) {
      for (const [est, maxOut] of [[5_000, 2_000], [50_000, 8_000], [120_000, 16_000]]) {
        const reserve = reserveMicroUsd(tier, est, maxOut);
        for (const input of [0, est / 2, est]) {
          for (const cached of [0, input / 2, input]) {
            for (const out of [0, maxOut / 2, maxOut]) {
              expect(costMicroUsd(tier, { inputTokens: input, cachedInputTokens: cached, outputTokens: out })).toBeLessThanOrEqual(reserve);
            }
          }
        }
      }
    }
  });

  test("入力トークンの見積りは、UTF-8のバイト数（実際のトークン数以上になる上限）", () => {
    expect(estimateInputTokens("abc")).toBe(3);
    expect(estimateInputTokens("あ")).toBe(3);
    expect(estimateInputTokens("")).toBe(0);
  });

  test("上限: 3.00ドル = 495円（165円/ドル）で、500円相当を超えない", () => {
    expect(AI_PERIOD_LIMIT_MICRO_USD).toBe(3_000_000);
    expect((AI_PERIOD_LIMIT_MICRO_USD / 1_000_000) * JPY_PER_USD).toBeLessThanOrEqual(500);
  });
});

test.describe("AIトークン（画面に出す単位）", () => {
  test("1 AIトークン = 0.1 µUSD: 3,000,000 µUSD = 3,000万 AIトークン", () => {
    expect(microUsdToAiTokens(3_000_000)).toBe(30_000_000);
    expect(microUsdToAiTokens(1)).toBe(10);
    expect(microUsdToAiTokens(-5)).toBe(0);
  });

  test("標準モデルの入力1トークン（0.1µUSD）= 1 AIトークン", () => {
    // 100 nUSD = 0.1 µUSD → 1 AIトークン
    expect(AI_MODELS.standard.inputNano / 1000 / 0.1).toBe(1);
  });

  test("万単位の表示: 残量は切り捨て、使用量は切り上げ", () => {
    expect(formatAiTokens(30_000_000)).toBe("3,000万");
    expect(formatAiTokens(29_997_500, "floor")).toBe("2,999万");
    expect(formatAiTokens(29_997_500, "ceil")).toBe("3,000万");
    expect(formatAiTokens(9_999)).toBe("9,999");
    expect(formatAiTokens(0)).toBe("0");
    expect(formatAiTokens(-3)).toBe("0");
  });

  test("モデルや単価が変わっても、換算の係数は変わらない（定数）", () => {
    expect(microUsdToAiTokens(AI_MODELS.advanced.inputNano)).toBe(microUsdToAiTokens(AI_MODELS.standard.inputNano * 20));
  });
});
