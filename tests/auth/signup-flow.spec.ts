import { test, expect } from "@playwright/test";
import { runSignup, type SignUpResult, type SignupDeps } from "@/lib/auth/signup-flow";
import { SIGNUP_CONSENT_REQUIRED_MESSAGE } from "@/lib/auth/signup-consent";

/**
 * 会員登録の流れ（サーバー側）の単体テスト（工程38）。Supabaseには接続しない。
 * 同意の確認がサーバーで行われること、同意の記録がサーバーの値だけで作られることを確認する。
 */
function makeDeps(over: Partial<SignUpResult> = {}, opts: { recordResult?: boolean | "throw" } = {}) {
  const calls = { signUp: 0, record: [] as unknown[][], notRecorded: 0 };
  const deps: SignupDeps = {
    async signUp() {
      calls.signUp += 1;
      return { error: null, userId: "user-new", alreadyRegistered: false, hasSession: false, ...over };
    },
    async recordConsent(...args: unknown[]) {
      calls.record.push(args);
      if (opts.recordResult === "throw") throw new Error("db down");
      return opts.recordResult ?? true;
    },
    onConsentNotRecorded() {
      calls.notRecorded += 1;
    },
  };
  return { deps, calls };
}

const INPUT = { email: "new@example.com", password: "password-1234", consentAccepted: true };

test("同意していなければ、Supabase Authへ登録を依頼せず、同意の記録も作らない", async () => {
  const { deps, calls } = makeDeps();
  const result = await runSignup({ ...INPUT, consentAccepted: false }, deps);
  expect(result).toEqual({ status: "error", message: SIGNUP_CONSENT_REQUIRED_MESSAGE });
  expect(calls.signUp).toBe(0);
  expect(calls.record).toEqual([]);
});

test("パスワードが短ければ、登録を依頼しない", async () => {
  const { deps, calls } = makeDeps();
  const result = await runSignup({ ...INPUT, password: "short" }, deps);
  expect(result.status).toBe("error");
  expect(calls.signUp).toBe(0);
});

test("同意して登録できたら、そのユーザーについて同意を記録する（引数はユーザーIDだけ。版・日時はサーバー側で決まる）", async () => {
  const { deps, calls } = makeDeps();
  const result = await runSignup(INPUT, deps);
  expect(result).toEqual({ status: "confirm-email" });
  expect(calls.record).toEqual([["user-new"]]);
});

test("その場でログイン済みになる設定では signed-in を返す（同意は記録する）", async () => {
  const { deps, calls } = makeDeps({ hasSession: true });
  expect(await runSignup(INPUT, deps)).toEqual({ status: "signed-in" });
  expect(calls.record).toEqual([["user-new"]]);
});

test("登録済みのメールアドレスには、同意を記録しない（存在を悟らせない同じ案内を返す）", async () => {
  const { deps, calls } = makeDeps({ alreadyRegistered: true, userId: "fake-id" });
  expect(await runSignup(INPUT, deps)).toEqual({ status: "confirm-email" });
  expect(calls.record).toEqual([]);
});

test("登録に失敗したら、同意を記録しない。エラーは利用者向けの文言に変換する", async () => {
  const { deps, calls } = makeDeps({ error: { message: "User already registered" }, userId: null });
  const result = await runSignup(INPUT, deps);
  expect(result).toEqual({ status: "error", message: "このメールアドレスは既に登録されています。ログインをお試しください。" });
  expect(calls.record).toEqual([]);
});

test("登録の通信が例外になっても、エラーとして返す（同意は記録しない）", async () => {
  const { deps, calls } = makeDeps();
  deps.signUp = async () => {
    throw new Error("network");
  };
  const result = await runSignup(INPUT, deps);
  expect(result.status).toBe("error");
  expect(calls.record).toEqual([]);
});

test("同意の記録に失敗しても、登録は取り消さない（決済の前にあらためて同意を求める）。失敗は通知する", async () => {
  for (const recordResult of [false, "throw"] as const) {
    const { deps, calls } = makeDeps({}, { recordResult });
    const result = await runSignup(INPUT, deps);
    expect(result).toEqual({ status: "confirm-email" });
    expect(calls.notRecorded).toBe(1);
  }
});

test("入力に、版・日時・ユーザーIDのような値を混ぜても、記録の引数には影響しない", async () => {
  const { deps, calls } = makeDeps();
  const forged = { ...INPUT, version: "1999-01-01", accepted_at: "1999-01-01", userId: "victim" } as typeof INPUT;
  await runSignup(forged, deps);
  expect(calls.record).toEqual([["user-new"]]);
});
