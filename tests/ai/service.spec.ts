import { test, expect } from "@playwright/test";
import { handleCalendarAssist, type Availability, type Caller } from "@/lib/ai/service";
import { costMicroUsd } from "@/lib/ai/pricing";
import { MemoryLedger, USER_ID, assistBody, makeDeps, newRequestId, okOutput, type FakeModel } from "./helpers";

const AVAILABLE: Availability = { available: true };
const PREMIUM: Caller = { userId: USER_ID, plan: "premium" };
const USAGE = { inputTokens: 3_000, cachedInputTokens: 0, outputTokens: 400 };

function setup(limit?: number) {
  const ledger = new MemoryLedger(limit);
  ledger.premium.add(USER_ID);
  const model: FakeModel = { calls: [], next: { kind: "ok", text: okOutput(), usage: USAGE } };
  const logs: Record<string, unknown>[] = [];
  return { ledger, model, logs, deps: makeDeps(ledger, model, logs) };
}

test.describe("AI補助: 利用できる人・同意", () => {
  test("Premiumは利用できる: 予約→AI呼び出し1回→実際の使用量で確定", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].modelId).toBe("gpt-6-luna");
    expect(ledger.calls).toEqual(["reserve", "settle"]);
    const actual = costMicroUsd("standard", USAGE);
    expect(ledger.spent).toBe(actual);
    expect(ledger.reserved).toBe(0);
    const body = res.body as { suggestions: { row: number; inferred: boolean }[]; usage: { usedAiTokens: number; remainingAiTokens: number; limitAiTokens: number } };
    expect(body.suggestions.map((s) => s.row)).toEqual([5, 6]);
    expect(body.suggestions[0].inferred).toBe(true);
    // 画面に返すのはAIトークンだけ（1µUSD = 10 AIトークン）
    expect(body.usage).toMatchObject({ limitAiTokens: 30_000_000, usedAiTokens: actual * 10, remainingAiTokens: (3_000_000 - actual) * 10 });
    expect(JSON.stringify(res.body)).not.toMatch(/micro|usd|円/i);
  });

  test("高精度モデルを選ぶと gpt-6.1-sol で呼び、その単価で確定する", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody({ model: "advanced" }));
    expect(res.status).toBe(200);
    expect(model.calls[0].modelId).toBe("gpt-6.1-sol");
    expect(ledger.spent).toBe(costMicroUsd("advanced", USAGE));
  });

  test("Freeは利用できない（予約もAI呼び出しもしない）", async () => {
    const { ledger, model, deps } = setup();
    for (const plan of ["free", "standard"] as const) {
      const res = await handleCalendarAssist(deps, { userId: USER_ID, plan }, AVAILABLE, assistBody());
      expect(res.status).toBe(403);
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("ログインしていない人は利用できない", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, { userId: null, plan: "free" }, AVAILABLE, assistBody());
    expect(res.status).toBe(401);
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("未ログイン・Freeは、同意が無くても同意の案内ではなく、ログイン／Premiumの案内を返す（権限の確認が先）", async () => {
    const { ledger, model, deps } = setup();
    const noConsent = () => {
      const body = assistBody();
      delete body.consent;
      return body;
    };
    const anon = await handleCalendarAssist(deps, { userId: null, plan: "free" }, AVAILABLE, noConsent());
    expect(anon.status).toBe(401);
    expect((anon.body as { error: string }).error).toBe("login_required");
    for (const plan of ["free", "standard"] as const) {
      const res = await handleCalendarAssist(deps, { userId: USER_ID, plan }, AVAILABLE, noConsent());
      expect(res.status, plan).toBe(403);
      expect((res.body as { error: string }).error, plan).toBe("not_premium");
    }
    // 本文が壊れていても、権限が無ければ入力の検証より先に断る
    expect((await handleCalendarAssist(deps, { userId: null, plan: "free" }, AVAILABLE, "not an object")).status).toBe(401);
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("DB側でPremiumでないと判定された場合も、AIを呼ばない", async () => {
    const { ledger, model, deps } = setup();
    ledger.premium.clear();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(403);
    expect(model.calls).toHaveLength(0);
  });

  test("同意が無い・版が違う・trueでない場合は、何も処理せずAIを呼ばない", async () => {
    const { ledger, model, deps } = setup();
    const bad: unknown[] = [
      undefined,
      { accepted: false, version: "2026-10-22" },
      { accepted: "true", version: "2026-10-22" },
      { accepted: true, version: "2020-01-01" },
      { accepted: true },
      "yes",
    ];
    for (const consent of bad) {
      const body = assistBody();
      if (consent === undefined) delete body.consent;
      else body.consent = consent;
      const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
      expect(res.status, JSON.stringify(consent)).toBe(400);
      expect((res.body as { error: string }).error).toBe("consent_required");
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("APIキー未設定・プレビュー環境では、利用不可（AIを呼ばない）", async () => {
    const { ledger, model, deps } = setup();
    for (const reason of ["not_configured", "preview", "billing_off"] as const) {
      const res = await handleCalendarAssist(deps, PREMIUM, { available: false, reason }, assistBody());
      expect(res.status).toBe(503);
      expect((res.body as { reason: string }).reason).toBe(reason);
    }
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("入力が不正なら、予約もAI呼び出しもしない", async () => {
    const { ledger, model, deps } = setup();
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody({ rows: [] }));
    expect(res.status).toBe(400);
    expect(model.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });
});

test.describe("AI補助: 利用枠", () => {
  test("上限を超える場合は、AIを呼ばない（429・リセット日を返す）", async () => {
    const { ledger, model, deps } = setup(1_000); // 上限 1,000 µUSD
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(429);
    expect((res.body as { error: string; resetAt: string }).error).toBe("quota_exceeded");
    expect((res.body as { resetAt: string }).resetAt).toBe("2026-11-01T00:00:00.000Z");
    expect(model.calls).toHaveLength(0);
    expect(ledger.reserved).toBe(0);
    expect(ledger.spent).toBe(0);
  });

  test("枠を使い切った状態（残り0）では、AIを呼ばず、予約もしない。画面には残量0と更新日を返す", async () => {
    const { ledger, model, deps } = setup(3_000_000);
    ledger.spent = 3_000_000; // 上限ちょうどまで使用済み
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(429);
    const body = res.body as { error: string; usage: { remainingAiTokens: number; usedAiTokens: number; limitAiTokens: number }; resetAt: string };
    expect(body.error).toBe("quota_exceeded");
    expect(body.usage.remainingAiTokens).toBe(0);
    expect(body.usage.usedAiTokens).toBe(body.usage.limitAiTokens);
    expect(body.resetAt).toBe("2026-11-01T00:00:00.000Z");
    expect(JSON.stringify(body)).not.toMatch(/micro|usd|円/i);
    expect(model.calls).toHaveLength(0);
    expect(ledger.reserved).toBe(0);
    expect(ledger.spent).toBe(3_000_000);
  });

  test("同時に2件の依頼が来て、枠に1件ぶんしか無い場合: AIが呼ばれるのは1件だけ", async () => {
    // 1件の予約額 = reserveMicroUsd(...)。上限を「1件ぶん+少し」にする
    const probe = setup();
    await handleCalendarAssist(probe.deps, PREMIUM, AVAILABLE, assistBody());
    const oneReserve = probe.ledger.requests.values().next().value!.reserved;
    const { ledger, model, deps } = setup(Math.floor(oneReserve * 1.5));
    model.next = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { kind: "ok", text: okOutput(), usage: USAGE };
    };
    const results = await Promise.all([
      handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody()),
      handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody()),
      handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody()),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
    expect(ledger.spent + ledger.reserved).toBeLessThanOrEqual(ledger.limit);
  });

  test("同じ依頼ID（二重送信）は2回目を処理しない: AI呼び出しは1回、計上も1回", async () => {
    const { ledger, model, deps } = setup();
    const body = assistBody({ requestId: newRequestId() });
    const first = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
    const spentAfterFirst = ledger.spent;
    const second = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(model.calls).toHaveLength(1);
    expect(ledger.spent).toBe(spentAfterFirst);
  });

  test("台帳が使えないときは、AIを呼ばない（503）", async () => {
    const { ledger, model, deps } = setup();
    ledger.failReserve = true;
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(503);
    expect(model.calls).toHaveLength(0);
  });

  test("確定の記録に一時的に失敗しても1回やり直す。2回失敗しても結果は返し、予約は戻さない", async () => {
    const a = setup();
    a.ledger.failSettleTimes = 1;
    const r1 = await handleCalendarAssist(a.deps, PREMIUM, AVAILABLE, assistBody());
    expect(r1.status).toBe(200);
    expect(a.ledger.spent).toBe(costMicroUsd("standard", USAGE));

    const b = setup();
    b.ledger.failSettleTimes = 2;
    const r2 = await handleCalendarAssist(b.deps, PREMIUM, AVAILABLE, assistBody());
    expect(r2.status).toBe(200);
    expect(b.ledger.reserved).toBeGreaterThan(0); // 予約は残る（期限切れで「使用済み」になる）
    b.ledger.expireAll();
    expect(b.ledger.reserved).toBe(0);
    expect(b.ledger.spent).toBeGreaterThan(0);
  });
});

test.describe("AI補助: 失敗時の利用枠の扱い（根拠なく返還しない）", () => {
  test("OpenAIが入力を受け付けなかった(401/400/429)ときだけ、予約を解放する", async () => {
    for (const status of [400, 401, 429]) {
      const { ledger, model, deps } = setup();
      model.next = { kind: "rejected", status };
      const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
      expect(res.status).toBe(502);
      expect(ledger.calls).toEqual(["reserve", "release"]);
      expect(ledger.reserved).toBe(0);
      expect(ledger.spent).toBe(0);
    }
  });

  test("タイムアウト・通信断・5xx・不正な応答は、解放も確定もしない（予約が残り、期限切れで使用済みになる）", async () => {
    for (const reason of ["timeout", "network", "server", "bad-response"] as const) {
      const { ledger, model, deps } = setup();
      model.next = { kind: "unknown", reason };
      const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
      expect(res.status, reason).toBe(504);
      expect(ledger.calls, reason).toEqual(["reserve"]); // release も settle も呼ばない
      expect(ledger.reserved).toBeGreaterThan(0);
      expect(ledger.spent).toBe(0);
      ledger.expireAll();
      expect(ledger.reserved).toBe(0);
      expect(ledger.spent).toBeGreaterThan(0); // 返還されていない
    }
  });

  test("AI呼び出しで想定外の例外が出ても、予約は解放しない", async () => {
    const { ledger, model, deps } = setup();
    model.next = async () => {
      throw new Error("boom");
    };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(504);
    expect(ledger.calls).toEqual(["reserve"]);
  });

  test("OpenAIが処理した失敗（拒否・途中で切れた・失敗）は、使用量で確定する", async () => {
    for (const kind of ["refusal", "incomplete", "failed"] as const) {
      const { ledger, model, deps } = setup();
      model.next = { kind, usage: USAGE };
      const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
      expect(res.status).toBe(502);
      expect((res.body as { suggestions?: unknown }).suggestions).toBeUndefined();
      expect(ledger.calls).toEqual(["reserve", "settle"]);
      expect(ledger.spent).toBe(costMicroUsd("standard", USAGE));
    }
  });

  test("使用量が読めない成功・失敗は、予約額で確定する（少なく数えない）", async () => {
    const { ledger, model, deps } = setup();
    model.next = { kind: "ok", text: okOutput(), usage: null };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(200);
    const reserved = [...ledger.requests.values()][0].reserved;
    expect(ledger.spent).toBe(reserved);
  });

  test("AIの出力が不正でも、AIは処理済みなので確定する（結果は使わない）", async () => {
    const { ledger, model, deps } = setup();
    model.next = { kind: "ok", text: "これはJSONではありません", usage: USAGE };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody());
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("ai_invalid_output");
    expect(ledger.spent).toBe(costMicroUsd("standard", USAGE));
  });

  test("確定・解放をあとから重ねて呼んでも、二重計上・二重返還にならない", async () => {
    const { ledger, deps, model } = setup();
    const body = assistBody();
    await handleCalendarAssist(deps, PREMIUM, AVAILABLE, body);
    const spent = ledger.spent;
    const requestId = body.requestId as string;
    expect((await ledger.settle({ userId: USER_ID, requestId, actualMicroUsd: spent, usage: null })).outcome).toBe("already_settled");
    expect((await ledger.release({ userId: USER_ID, requestId, errorCode: "x" })).outcome).toBe("already_settled");
    expect(ledger.spent).toBe(spent);
    expect(model.calls).toHaveLength(1);
  });
});

test.describe("AI補助: 本文を保存・記録しない", () => {
  test("運用ログには、セルの文字・AIの出力・予定名が含まれない", async () => {
    const { logs, model, deps } = setup();
    const secret = "機密の取引先A社との打合せ";
    model.next = {
      kind: "ok",
      text: JSON.stringify({ suggestions: [{ row: 5, date: "2027-04-05", title: secret, start_time: null, end_time: null, confidence: "high", inferred: false, note: secret }] }),
      usage: USAGE,
    };
    const res = await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody({ rows: [{ row: 5, cells: ["4/5", secret] }] }));
    expect(res.status).toBe(200);
    expect(logs.length).toBeGreaterThan(0);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("入学式");
    expect(dump).not.toContain("2027-04-05");
  });

  test("台帳に渡る値は、利用者ID・依頼ID・機能名・モデル名・金額・トークン数だけ（本文を渡さない）", async () => {
    const { ledger, deps } = setup();
    const secret = "機密の取引先A社との打合せ";
    const seen: unknown[] = [];
    const spy = ledger.reserve.bind(ledger);
    ledger.reserve = async (a) => {
      seen.push(a);
      return spy(a);
    };
    const settle = ledger.settle.bind(ledger);
    ledger.settle = async (a) => {
      seen.push(a);
      return settle(a);
    };
    await handleCalendarAssist(deps, PREMIUM, AVAILABLE, assistBody({ rows: [{ row: 5, cells: ["4/5", secret] }] }));
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["feature", "maxConcurrent", "maxPerMinute", "modelId", "requestId", "reserveMicroUsd", "ttlSeconds", "userId"]);
  });
});
