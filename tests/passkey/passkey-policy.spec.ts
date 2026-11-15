import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { decidePaidAccess, paidAccessGranted } from "@/lib/passkey/policy";
import { deviceLabelFromUserAgent, passkeyLabel, passkeyProviderHint } from "@/lib/passkey/labels";
import { MAX_DEVICES, DEVICE_LIMIT_MESSAGE, IN_USE_MESSAGE } from "@/lib/passkey/config";

/** 有料プランの利用条件の判定（純粋な関数）と、表示名・設定値・組み込み先の確認 */

const now = Date.UTC(2026, 10, 16, 3, 0, 0);
const base = { credentialCount: 1, deviceActive: true, lease: "mine" as const, verifiedAtMs: now - 60_000 };

test.describe("有料プランの利用条件（decidePaidAccess）", () => {
  test("契約・パスキー・登録端末・本人確認・同時利用のロックがそろったときだけ使える", () => {
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: base, nowMs: now })).toBe("ok");
    expect(decidePaidAccess({ contractPaid: false, enabled: true, state: base, nowMs: now })).toBe("not_paid");
    expect(decidePaidAccess({ contractPaid: true, enabled: false, state: null, nowMs: now })).toBe("disabled");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: null, nowMs: now })).toBe("unavailable");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, credentialCount: 0 }, nowMs: now })).toBe("needs_passkey");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, deviceActive: false }, nowMs: now })).toBe("needs_device");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, lease: "other" }, nowMs: now })).toBe("in_use_elsewhere");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, lease: "free" }, nowMs: now })).toBe("needs_verification");
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, lease: "none" }, nowMs: now })).toBe("needs_verification");
    // 本人確認から12時間を過ぎたら、もう一度確認を求める
    expect(decidePaidAccess({ contractPaid: true, enabled: true, state: { ...base, verifiedAtMs: now - 13 * 3600_000 }, nowMs: now })).toBe("needs_verification");
  });

  test("有料機能を開放するのは ok と disabled（仕組みがオフ）だけ。DBの不調では開放しない", () => {
    expect(paidAccessGranted("ok")).toBe(true);
    expect(paidAccessGranted("disabled")).toBe(true);
    for (const s of ["not_paid", "needs_passkey", "needs_device", "needs_verification", "in_use_elsewhere", "unavailable"] as const) {
      expect(paidAccessGranted(s), s).toBe(false);
    }
  });
});

test.describe("表示名（保存先は判別できないことがある前提）", () => {
  test("User-Agentから短い端末名を作る", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone・Safari");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Windows・Edge");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("Android・Chrome");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Mac・Safari");
    expect(deviceLabelFromUserAgent(null)).toBe("この端末");
  });
  test("AAGUIDが分かれば保存先の目安を出し、分からなければ（すべて0など）出さない", () => {
    expect(passkeyProviderHint("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")).toContain("Google");
    expect(passkeyProviderHint("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(passkeyLabel(null, null)).toBe("パスキー（この端末で登録）");
  });
});

test.describe("設定値と組み込み先", () => {
  test("端末は最大2台・案内の文言は指示書のとおり", () => {
    expect(MAX_DEVICES).toBe(2);
    expect(DEVICE_LIMIT_MESSAGE).toBe("登録できる端末は最大2台です。新しい端末を登録するには、現在登録されている端末を1台解除してください。");
    expect(IN_USE_MESSAGE).toBe("このアカウントは別の端末で利用中です。先に利用中の端末からログアウトしてください。");
  });

  test("プランの判定（getServerPlan）とAIのサーバー判定に、利用条件が組み込まれている。本番の機能スイッチはまだオフ", () => {
    const plan = fs.readFileSync("src/lib/plans/current-plan.ts", "utf8");
    expect(plan).toContain("const access = await resolvePaidAccess(user.id, contractPlan !== \"free\");");
    expect(plan).toContain('contractPlan === "free" || paidAccessGranted(access.status) ? contractPlan : "free"');
    const ai = fs.readFileSync("src/lib/ai/server.ts", "utf8");
    expect(ai).toContain('if (!paidAccessGranted(ctx.paidAccess) && ctx.paidAccess !== "not_paid") return { userId: ctx.userId, plan: "free" };');
    const flags = fs.readFileSync("src/lib/config/features.ts", "utf8");
    expect(flags.slice(flags.indexOf("const PRODUCTION_FLAGS"))).toMatch(/passkey:\s*false/);
    // ログアウトでロックを解放し、パスワード変更で他の端末のログインとロックを終わらせる
    const actions = fs.readFileSync("src/lib/auth/actions.ts", "utf8");
    expect(actions).toContain("await endCurrentSession(user?.id ?? null);");
    expect(actions).toContain('await supabase.auth.signOut({ scope: "others" });');
  });

  test("開発専用の仕組み（メモリ上の保存先・テスト用ユーザー）は、開発サーバー＋環境変数＋Supabase未設定のときだけ動く", () => {
    const dev = fs.readFileSync("src/lib/passkey/dev.ts", "utf8");
    expect(dev).toContain('process.env.NODE_ENV === "development" && process.env.PASSKEY_DEV_STORE === "memory" && !isSupabaseServiceConfigured()');
    const route = fs.readFileSync("src/app/api/passkey/[action]/route.ts", "utf8");
    expect(route).toContain('if (!isPasskeyDevMode()) return json({ error: "見つかりません。" }, 404);');
  });
});
