import { test, expect } from "@playwright/test";
import { createRpcLedger, LedgerError, type RpcCall } from "@/lib/ai/ledger";

const period = {
  period_start: "2026-10-01T00:00:00Z",
  period_end: "2026-11-01T00:00:00Z",
  limit_micro_usd: 3_000_000,
  spent_micro_usd: 100,
  reserved_micro_usd: 50,
  remaining_micro_usd: 2_999_850,
};

function recorder(response: unknown, error: { message: string } | null = null) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: RpcCall = async (fn, args) => {
    calls.push({ fn, args });
    return { data: response, error };
  };
  return { calls, rpc };
}

test.describe("利用台帳(RPC)の窓口", () => {
  test("ai_reserve: 引数の名前と上限を渡し、結果を読み取る", async () => {
    const { calls, rpc } = recorder({ outcome: "ok", request_status: "reserved", ...period });
    const r = await createRpcLedger(rpc).reserve({ userId: "u", requestId: "r", feature: "calendar-import", modelId: "gpt-6-luna", reserveMicroUsd: 7150 });
    expect(r.outcome).toBe("ok");
    expect(r.period).toMatchObject({ limitMicroUsd: 3_000_000, spentMicroUsd: 100, reservedMicroUsd: 50, remainingMicroUsd: 2_999_850 });
    expect(calls[0].fn).toBe("ai_reserve");
    expect(calls[0].args).toMatchObject({
      p_user_id: "u",
      p_request_id: "r",
      p_feature: "calendar-import",
      p_model: "gpt-6-luna",
      p_reserve_micro_usd: 7150,
      p_limit_micro_usd: 3_000_000,
      p_price_version: "2026-10-22",
    });
  });

  test("ai_settle / ai_release / ai_get_usage の呼び出し", async () => {
    const s = recorder({ outcome: "ok", ...period });
    const ledger = createRpcLedger(s.rpc);
    await ledger.settle({ userId: "u", requestId: "r", actualMicroUsd: 450, usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50 } });
    expect(s.calls[0]).toEqual({
      fn: "ai_settle",
      args: { p_user_id: "u", p_request_id: "r", p_actual_micro_usd: 450, p_input_tokens: 100, p_cached_input_tokens: 10, p_output_tokens: 50 },
    });
    await ledger.release({ userId: "u", requestId: "r", errorCode: "openai_401" });
    expect(s.calls[1]).toEqual({ fn: "ai_release", args: { p_user_id: "u", p_request_id: "r", p_error_code: "openai_401" } });

    const g = recorder({ entitled: true, reason: "ok", ...period });
    const usage = await createRpcLedger(g.rpc).getUsage("u");
    expect(usage.entitled).toBe(true);
    expect(g.calls[0].args).toEqual({ p_user_id: "u", p_default_limit_micro_usd: 3_000_000 });
  });

  test("Premiumでない人の getUsage は期間なし・entitled=false", async () => {
    const { rpc } = recorder({ entitled: false, reason: "not_premium", period_start: null, period_end: null, limit_micro_usd: 3_000_000, spent_micro_usd: 0, reserved_micro_usd: 0, remaining_micro_usd: 3_000_000 });
    const u = await createRpcLedger(rpc).getUsage("u");
    expect(u).toEqual({ entitled: false, reason: "not_premium", period: null });
  });

  test("RPCのエラー・想定外の応答は LedgerError にする（成功扱いにしない）", async () => {
    await expect(createRpcLedger(recorder(null, { message: "boom" }).rpc).reserve({ userId: "u", requestId: "r", feature: "f", modelId: "m", reserveMicroUsd: 1 })).rejects.toBeInstanceOf(LedgerError);
    await expect(createRpcLedger(recorder({ outcome: "something_new" }).rpc).reserve({ userId: "u", requestId: "r", feature: "f", modelId: "m", reserveMicroUsd: 1 })).rejects.toBeInstanceOf(LedgerError);
    await expect(createRpcLedger(recorder("text").rpc).settle({ userId: "u", requestId: "r", actualMicroUsd: 1, usage: null })).rejects.toBeInstanceOf(LedgerError);
    await expect(createRpcLedger(recorder([]).rpc).getUsage("u")).rejects.toBeInstanceOf(LedgerError);
  });

  test("エラーメッセージに、DBの詳細(error.message)を含めない", async () => {
    try {
      await createRpcLedger(recorder(null, { message: "secret detail" }).rpc).getUsage("u");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret detail");
    }
  });
});
