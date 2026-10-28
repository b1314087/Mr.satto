import { test, expect } from "@playwright/test";
import {
  DELETE_ACCOUNT_MESSAGES,
  DELETE_CONFIRMATION_WORD,
  runDeleteAccount,
  type DeleteAccountDeps,
  type StoredSubscription,
  type StripeOpenCheck,
} from "@/lib/account/delete-account";

/**
 * アカウント削除の流れの単体テスト（工程38）。SupabaseにもStripeにも接続せず、メモリ上の疑似データベースで確認する。
 * 確認すること: 本人だけが削除できる／未ログイン・他人は削除できない／確認の入力・パスワードの再認証／
 * 契約が続いている間は削除しない／Stripeの確認ができないときは削除しない／関連データが残らない／
 * 失敗しても中途半端な状態を作らない／同じ操作を繰り返しても安全／ログに秘密情報を出さない。
 */

const PASSWORD = "correct-password-1234";

interface FakeWorld {
  users: Map<string, { email: string }>;
  /** テーブルごとの、ユーザーIDに紐づく行（auth.users の削除で連鎖して消える） */
  related: Record<string, Set<string>>;
  subscriptions: Map<string, StoredSubscription>;
  stripe: Map<string, StripeOpenCheck[]>; // 顧客IDごとの、確認結果の順番
  calls: string[];
  logs: string[];
  failDelete?: boolean;
  failStripe?: boolean;
  sessionUserId: string | null;
  signOutThrows?: boolean;
  rateLimited?: boolean;
  passwordCheckThrows?: boolean;
}

function makeWorld(): FakeWorld {
  const world: FakeWorld = {
    users: new Map([
      ["user-a", { email: "a@example.com" }],
      ["user-b", { email: "b@example.com" }],
    ]),
    related: {
      profiles: new Set(["user-a", "user-b"]),
      subscriptions: new Set(["user-a", "user-b"]),
      tool_usage_daily: new Set(["user-a", "user-b"]),
      ai_usage_periods: new Set(["user-a", "user-b"]),
      ai_usage_requests: new Set(["user-a", "user-b"]),
      terms_consents: new Set(["user-a", "user-b"]),
    },
    subscriptions: new Map(),
    stripe: new Map(),
    calls: [],
    logs: [],
    sessionUserId: "user-a",
  };
  return world;
}

function depsFor(world: FakeWorld): DeleteAccountDeps {
  return {
    async getCurrentUser() {
      if (!world.sessionUserId) return null;
      const u = world.users.get(world.sessionUserId);
      return u ? { id: world.sessionUserId, email: u.email } : null; // 削除済みなら、セッションも無効
    },
    isRateLimited: () => world.rateLimited === true,
    async verifyPassword(_email, password) {
      world.calls.push("verifyPassword");
      if (world.passwordCheckThrows) throw new Error("network");
      return password === PASSWORD;
    },
    async getStoredSubscription(userId) {
      world.calls.push("getStoredSubscription");
      return world.subscriptions.get(userId) ?? null;
    },
    async checkStripeOpenSubscriptions(customerId) {
      world.calls.push("checkStripe");
      if (world.failStripe) throw new Error("stripe down");
      const queue = world.stripe.get(customerId) ?? ["none"];
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async expireOpenCheckoutSessions() {
      world.calls.push("expireSessions");
      if (world.failStripe) throw new Error("stripe down");
    },
    async deleteUser(userId) {
      world.calls.push(`deleteUser:${userId}`);
      if (world.failDelete) throw new Error("db down");
      if (!world.users.has(userId)) return "not-found";
      world.users.delete(userId);
      for (const rows of Object.values(world.related)) rows.delete(userId); // 外部キーの連鎖削除
      return "deleted";
    },
    async signOut() {
      world.calls.push("signOut");
      if (world.signOutThrows) throw new Error("signout failed");
    },
    log: (event, detail) => world.logs.push(`${event} ${JSON.stringify(detail)}`),
  };
}

const OK_INPUT = { confirmation: DELETE_CONFIRMATION_WORD, password: PASSWORD };

test.describe("アカウント削除: 本人だけが削除できる", () => {
  test("未ログインでは削除できない（削除処理も、パスワード確認も呼ばれない）", async () => {
    const world = makeWorld();
    world.sessionUserId = null;
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toEqual({ status: "error", code: "unauthenticated", message: DELETE_ACCOUNT_MESSAGES.unauthenticated });
    expect(world.calls).toEqual([]);
    expect(world.users.size).toBe(2);
  });

  test("ログイン中の本人のアカウントだけが削除され、他のユーザーのデータは残る", async () => {
    const world = makeWorld();
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toEqual({ status: "deleted" });
    expect(world.users.has("user-a")).toBe(false);
    expect(world.users.has("user-b")).toBe(true);
    for (const rows of Object.values(world.related)) {
      expect(rows.has("user-a")).toBe(false); // 関連データが残らない
      expect(rows.has("user-b")).toBe(true); // 他人のデータは残る
    }
    expect(world.calls.filter((c) => c.startsWith("deleteUser:"))).toEqual(["deleteUser:user-a"]);
  });

  test("入力に他人のIDのようなものを混ぜても、対象はセッションのユーザーだけ", async () => {
    const world = makeWorld();
    const forged = { ...OK_INPUT, userId: "user-b", user_id: "user-b" } as typeof OK_INPUT;
    await runDeleteAccount(forged, depsFor(world));
    expect(world.users.has("user-b")).toBe(true);
    expect(world.calls).toContain("deleteUser:user-a");
    expect(world.calls).not.toContain("deleteUser:user-b");
  });

  test("操作が多すぎるときは、何もしない", async () => {
    const world = makeWorld();
    world.rateLimited = true;
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "rate-limited" });
    expect(world.users.size).toBe(2);
    expect(world.calls).toEqual([]);
  });
});

test.describe("アカウント削除: 確認の入力と再認証", () => {
  test("確認の文言が違う・空のときは削除しない（パスワード確認にも進まない）", async () => {
    for (const confirmation of ["", "さくじょ", "delete", "削除します"]) {
      const world = makeWorld();
      const result = await runDeleteAccount({ confirmation, password: PASSWORD }, depsFor(world));
      expect(result).toMatchObject({ status: "error", code: "confirmation" });
      expect(world.users.has("user-a")).toBe(true);
      expect(world.calls).toEqual([]);
    }
  });

  test("前後の空白を除けば「削除」と一致する入力は受け付ける", async () => {
    const world = makeWorld();
    const result = await runDeleteAccount({ confirmation: ` ${DELETE_CONFIRMATION_WORD} `, password: PASSWORD }, depsFor(world));
    expect(result).toEqual({ status: "deleted" });
  });

  test("パスワードが違う・空のときは削除しない", async () => {
    for (const password of ["wrong-password", ""]) {
      const world = makeWorld();
      const result = await runDeleteAccount({ confirmation: DELETE_CONFIRMATION_WORD, password }, depsFor(world));
      expect(result).toMatchObject({ status: "error", code: "password" });
      expect(world.users.has("user-a")).toBe(true);
      expect(world.calls.some((c) => c.startsWith("deleteUser"))).toBe(false);
    }
  });

  test("パスワードの確認自体ができなかったとき（通信の障害）は、削除しない", async () => {
    const world = makeWorld();
    world.passwordCheckThrows = true;
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "unavailable" });
    expect(world.users.has("user-a")).toBe(true);
  });
});

test.describe("アカウント削除: 課金との整合", () => {
  const stored = (status: string | null, over: Partial<StoredSubscription> = {}): StoredSubscription => ({
    status,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: status ? "sub_1" : null,
    ...over,
  });

  for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
    test(`契約が続いている（${status}）間は削除しない`, async () => {
      const world = makeWorld();
      world.subscriptions.set("user-a", stored(status));
      const result = await runDeleteAccount(OK_INPUT, depsFor(world));
      expect(result).toMatchObject({ status: "error", code: "contract-active" });
      expect(world.users.has("user-a")).toBe(true);
      expect(world.calls.some((c) => c.startsWith("deleteUser"))).toBe(false);
      expect(world.calls).not.toContain("signOut");
    });
  }

  test("解約が予約されていて、期間内でまだ active の契約も、削除しない（期間の終了後に削除できる）", async () => {
    const world = makeWorld();
    world.subscriptions.set("user-a", stored("active"));
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ code: "contract-active" });
  });

  for (const status of ["canceled", "incomplete_expired"]) {
    test(`契約が終わっている（${status}）なら、Stripeの確認と決済セッションの失効のあと、削除できる`, async () => {
      const world = makeWorld();
      world.subscriptions.set("user-a", stored(status));
      const result = await runDeleteAccount(OK_INPUT, depsFor(world));
      expect(result).toEqual({ status: "deleted" });
      // 順番: 確認 → 決済の途中のセッションを失効 → もう一度確認 → 削除
      const order = world.calls.filter((c) => c !== "verifyPassword" && c !== "getStoredSubscription");
      expect(order).toEqual(["checkStripe", "expireSessions", "checkStripe", "deleteUser:user-a", "signOut"]);
    });
  }

  test("契約情報が無い（一度も申し込んでいない）ユーザーは、そのまま削除できる", async () => {
    const world = makeWorld();
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toEqual({ status: "deleted" });
    expect(world.calls).not.toContain("checkStripe");
  });

  test("顧客IDだけあり、契約が一度も作られていないユーザーは、削除できる", async () => {
    const world = makeWorld();
    world.subscriptions.set("user-a", stored(null));
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toEqual({ status: "deleted" });
  });

  test("データベースでは終了でも、Stripeで続いている契約があれば削除しない（データベースの値が古い場合）", async () => {
    const world = makeWorld();
    world.subscriptions.set("user-a", stored("canceled"));
    world.stripe.set("cus_1", ["open"]);
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "contract-active" });
    expect(world.users.has("user-a")).toBe(true);
  });

  test("決済の途中のセッションを失効させている間に契約が作られたら（競合）、削除しない", async () => {
    const world = makeWorld();
    world.subscriptions.set("user-a", stored("canceled"));
    world.stripe.set("cus_1", ["none", "open"]);
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "contract-active" });
    expect(world.users.has("user-a")).toBe(true);
    expect(world.calls.some((c) => c.startsWith("deleteUser"))).toBe(false);
  });

  test("Stripeに接続できないときは、削除しない", async () => {
    const world = makeWorld();
    world.subscriptions.set("user-a", stored("canceled"));
    world.failStripe = true;
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "unavailable" });
    expect(world.users.has("user-a")).toBe(true);
  });

  test("Stripeが未設定で確認できない場合: 契約の記録があれば削除しない／無ければ削除できる", async () => {
    const withSub = makeWorld();
    withSub.subscriptions.set("user-a", stored("canceled"));
    withSub.stripe.set("cus_1", ["unverifiable"]);
    expect(await runDeleteAccount(OK_INPUT, depsFor(withSub))).toMatchObject({ code: "unavailable" });
    expect(withSub.users.has("user-a")).toBe(true);

    const withoutSub = makeWorld();
    withoutSub.subscriptions.set("user-a", stored(null));
    withoutSub.stripe.set("cus_1", ["unverifiable"]);
    expect(await runDeleteAccount(OK_INPUT, depsFor(withoutSub))).toEqual({ status: "deleted" });
  });

  test("データベースの契約情報を読めないときは、削除しない", async () => {
    const world = makeWorld();
    const deps = depsFor(world);
    deps.getStoredSubscription = async () => {
      throw new Error("db read failed");
    };
    const result = await runDeleteAccount(OK_INPUT, deps);
    expect(result).toMatchObject({ code: "unavailable" });
    expect(world.users.has("user-a")).toBe(true);
  });

  test("削除後に届くStripeの通知は、契約の行が無いので何も更新しない（Webhookとの競合）", async () => {
    // Webhookの処理は syncSubscription（契約の行が無ければ "no-row" で更新しない）。削除後の通知を想定して確認する。
    const { syncSubscription } = await import("@/lib/stripe/subscription-sync");
    let updates = 0;
    const outcome = await syncSubscription({
      store: {
        findByCustomer: async () => null,
        updateIfNotNewer: async () => {
          updates += 1;
          return true;
        },
      },
      customerId: "cus_1",
      subscription: { id: "sub_1", status: "canceled", cancel_at_period_end: false, items: { data: [] } },
      mapping: { premiumProductIds: [], premiumPriceIds: [], standardPriceIds: [] },
      retrievedAtIso: new Date().toISOString(),
    });
    expect(outcome).toBe("no-row");
    expect(updates).toBe(0);
  });
});

test.describe("アカウント削除: 失敗・繰り返し・ログ", () => {
  test("削除に失敗したら、エラーを返し、データは何も消えない（途中の状態を残さない）", async () => {
    const world = makeWorld();
    world.failDelete = true;
    const result = await runDeleteAccount(OK_INPUT, depsFor(world));
    expect(result).toMatchObject({ status: "error", code: "failed" });
    expect(world.users.has("user-a")).toBe(true);
    for (const rows of Object.values(world.related)) expect(rows.has("user-a")).toBe(true);
    expect(world.calls).not.toContain("signOut");
  });

  test("同じ操作を繰り返しても安全: 2回目は（セッションが無効なので）未ログインとして扱われ、他人には影響しない", async () => {
    const world = makeWorld();
    const deps = depsFor(world);
    expect(await runDeleteAccount(OK_INPUT, deps)).toEqual({ status: "deleted" });
    const second = await runDeleteAccount(OK_INPUT, deps);
    expect(second).toMatchObject({ status: "error", code: "unauthenticated" });
    expect(world.users.has("user-b")).toBe(true);
  });

  test("セッション確認のあとにアカウントが既に削除されていた（並行した2つの操作）場合も、成功として扱う", async () => {
    const world = makeWorld();
    const deps = depsFor(world);
    deps.deleteUser = async () => "not-found";
    expect(await runDeleteAccount(OK_INPUT, deps)).toEqual({ status: "deleted" });
  });

  test("ログイン状態の破棄に失敗しても、削除は成功として扱う", async () => {
    const world = makeWorld();
    world.signOutThrows = true;
    expect(await runDeleteAccount(OK_INPUT, depsFor(world))).toEqual({ status: "deleted" });
  });

  test("ログには、パスワード・メールアドレスを出さない（識別子と種類だけ）", async () => {
    const world = makeWorld();
    await runDeleteAccount(OK_INPUT, depsFor(world));
    const failing = makeWorld();
    failing.failDelete = true;
    await runDeleteAccount(OK_INPUT, depsFor(failing));
    const all = [...world.logs, ...failing.logs].join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("example.com");
    expect(all).not.toContain("db down"); // エラー本文も出さない（種類のみ）
  });

  test("削除後は、そのセッションでの再アクセスが拒否される（getCurrentUser が null になる）", async () => {
    const world = makeWorld();
    const deps = depsFor(world);
    await runDeleteAccount(OK_INPUT, deps);
    expect(await deps.getCurrentUser()).toBeNull();
  });
});
