import { test, expect } from "@playwright/test";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, normalizeUsername, usernameKey, validateUsername } from "@/lib/auth/username";
import { matchesMemberQuery } from "@/lib/admin/member-search";
import { runSignup, type SignupDeps } from "@/lib/auth/signup-flow";

/** ユーザー名のルール・会員登録での検証・管理画面の検索（Supabaseには接続しない） */

test.describe("ユーザー名のルール", () => {
  test("日本語・英数字・_・- の3〜20文字は通る。全角は半角にそろえ、前後の空白は除く", () => {
    for (const ok of ["taro", "Taro_Yamada-1", "やまだ太郎", "山田タロウ", "abc", "a".repeat(USERNAME_MAX_LENGTH), "あ".repeat(USERNAME_MAX_LENGTH)]) {
      expect(validateUsername(ok).ok, ok).toBe(true);
    }
    const v = validateUsername("　ＴＡＲＯ１２３ ");
    expect(v.ok && v.username).toBe("TARO123");
    expect(v.ok && v.key).toBe("taro123");
  });

  test("短すぎる・長すぎる・空・文字以外は、理由つきで断る", () => {
    const bad = (v: unknown) => validateUsername(v);
    expect(bad("ab")).toEqual({ ok: false, message: `ユーザー名は${USERNAME_MIN_LENGTH}〜${USERNAME_MAX_LENGTH}文字で入力してください。` });
    expect(bad("a".repeat(USERNAME_MAX_LENGTH + 1)).ok).toBe(false);
    expect(bad("あ".repeat(USERNAME_MAX_LENGTH + 1)).ok).toBe(false);
    for (const v of ["", "   ", undefined, null, 123]) expect(bad(v), String(v)).toEqual({ ok: false, message: "ユーザー名を入力してください。" });
    for (const v of ["taro yamada", "taro@example", "taro.yamada", "<script>", "a%b_c%", "taro😀"]) {
      const r = bad(v);
      expect(r.ok, v).toBe(false);
    }
  });

  test("運営・サービス名と紛らわしい名前は使えない（大文字小文字・全角も同じ）", () => {
    for (const v of ["admin", "ADMIN", "Ａｄｍｉｎ", "support", "mrsatto", "Mr_Satto", "運営", "管理者", "公式"]) {
      const r = validateUsername(v);
      // 3文字未満の「運営」「公式」は長さで断られる。それ以外は予約名として断る
      expect(r.ok, v).toBe(false);
    }
    expect(validateUsername("管理者").ok).toBe(false);
    expect(validateUsername("admin1").ok).toBe(true);
  });

  test("重複の判定に使う形は、大文字小文字・全角半角を区別しない", () => {
    expect(usernameKey("Taro")).toBe(usernameKey("ＴＡＲＯ"));
    expect(usernameKey("Taro")).toBe(usernameKey("taro"));
    expect(normalizeUsername(" ｔａｒｏ ")).toBe("taro");
  });
});

function makeDeps(taken: string[] = [], over: Partial<SignupDeps> = {}) {
  const calls = { signUp: [] as string[][], taken: [] as string[] };
  const deps: SignupDeps = {
    async signUp(email, _pw, username) {
      calls.signUp.push([email, username]);
      return { error: null, userId: "user-new", alreadyRegistered: false, hasSession: false };
    },
    async isUsernameTaken(name) {
      calls.taken.push(name);
      return taken.map((t) => t.toLowerCase()).includes(name.toLowerCase());
    },
    async recordConsent() {
      return true;
    },
    ...over,
  };
  return { deps, calls };
}

const INPUT = { email: "new@example.com", password: "password-1234", username: "taro_yamada", consentAccepted: true };

test.describe("会員登録: ユーザー名（サーバー側の確認）", () => {
  test("ユーザー名がない・ルールに合わない場合は、登録を依頼しない", async () => {
    for (const username of ["", "  ", "ab", "taro yamada", "admin"]) {
      const { deps, calls } = makeDeps();
      const result = await runSignup({ ...INPUT, username }, deps);
      expect(result.status, username).toBe("error");
      expect(calls.signUp, username).toEqual([]);
    }
  });

  test("既に使われているユーザー名（大文字小文字違いも）は、登録を依頼せず、理由を返す", async () => {
    const { deps, calls } = makeDeps(["Taro_Yamada"]);
    const result = await runSignup(INPUT, deps);
    expect(result).toEqual({ status: "error", message: "このユーザー名は既に使われています。別の名前にしてください。" });
    expect(calls.signUp).toEqual([]);
  });

  test("使えるユーザー名なら、そろえた形で登録を依頼する", async () => {
    const { deps, calls } = makeDeps();
    const result = await runSignup({ ...INPUT, username: " ＴＡＲＯ_１ " }, deps);
    expect(result).toEqual({ status: "confirm-email" });
    expect(calls.signUp).toEqual([["new@example.com", "TARO_1"]]);
  });

  test("重複の確認ができなくても（通信エラー）、登録は進める（DBの一意制約が最終的に守る）", async () => {
    const { deps, calls } = makeDeps([], {
      isUsernameTaken: async () => {
        throw new Error("db down");
      },
    });
    expect((await runSignup(INPUT, deps)).status).toBe("confirm-email");
    expect(calls.signUp).toHaveLength(1);
  });

  test("同意がなければ、ユーザー名が正しくても登録を依頼しない", async () => {
    const { deps, calls } = makeDeps();
    expect((await runSignup({ ...INPUT, consentAccepted: false }, deps)).status).toBe("error");
    expect(calls.signUp).toEqual([]);
    expect(calls.taken).toEqual([]);
  });
});

test.describe("管理画面: 会員の検索", () => {
  const m = { email: "Hanako@Example.com", username: "はなこ_Tokyo" };
  test("メールアドレスでもユーザー名でも、部分一致で探せる（大文字小文字・全角半角を区別しない）", () => {
    for (const q of ["hanako", "EXAMPLE.com", "はなこ", "tokyo", "ＴＯＫＹＯ", "  はなこ  ", ""]) expect(matchesMemberQuery(m, q), q).toBe(true);
    for (const q of ["jiro", "osaka"]) expect(matchesMemberQuery(m, q), q).toBe(false);
  });
  test("ユーザー名が未設定の会員は、メールアドレスでだけ探せる", () => {
    expect(matchesMemberQuery({ email: "a@example.com", username: null }, "a@example")).toBe(true);
    expect(matchesMemberQuery({ email: "a@example.com", username: null }, "未設定")).toBe(false);
    expect(matchesMemberQuery({ email: null, username: null }, "x")).toBe(false);
  });
});
