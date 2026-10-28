import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { evaluateAdminAccess } from "@/lib/admin/access";

/**
 * 管理者判定（メールアドレスの確認状態を含む）の単体テスト（工程39）。Supabaseには接続しない。
 */
const ADMINS = ["admin@example.com", "owner@example.com"];

test.describe("管理者として認める条件", () => {
  test("登録された管理者で、メールが確認済みなら ok", () => {
    expect(evaluateAdminAccess({ email: "admin@example.com", emailConfirmed: true }, ADMINS)).toEqual({ status: "ok" });
  });

  test("大文字小文字・前後の空白が違っても、同じメールアドレスとして扱う", () => {
    expect(evaluateAdminAccess({ email: "  Admin@Example.COM ", emailConfirmed: true }, ADMINS)).toEqual({ status: "ok" });
  });

  test("登録された管理者でも、メールが未確認なら認めない", () => {
    expect(evaluateAdminAccess({ email: "admin@example.com", emailConfirmed: false }, ADMINS)).toEqual({
      status: "forbidden",
      reason: "email-unconfirmed",
    });
  });

  test("確認状態が取得できなかった（未定義・null）ときは、認めない", () => {
    const unknown = { email: "admin@example.com", emailConfirmed: undefined } as unknown as { email: string; emailConfirmed: boolean };
    expect(evaluateAdminAccess(unknown, ADMINS).status).toBe("forbidden");
    const nullish = { email: "admin@example.com", emailConfirmed: null } as unknown as { email: string; emailConfirmed: boolean };
    expect(evaluateAdminAccess(nullish, ADMINS).status).toBe("forbidden");
  });

  test("一般ユーザー（確認済みでも）は認めない", () => {
    expect(evaluateAdminAccess({ email: "user@example.com", emailConfirmed: true }, ADMINS)).toEqual({ status: "forbidden", reason: "not-admin" });
  });

  test("メールアドレスが無い・空のユーザーは認めない", () => {
    expect(evaluateAdminAccess({ email: null, emailConfirmed: true }, ADMINS).status).toBe("forbidden");
    expect(evaluateAdminAccess({ email: "", emailConfirmed: true }, ADMINS).status).toBe("forbidden");
  });

  test("管理者が1人も登録されていないときは、誰も認めない（未設定で全員が管理者にならない）", () => {
    expect(evaluateAdminAccess({ email: "admin@example.com", emailConfirmed: true }, []).status).toBe("forbidden");
    expect(evaluateAdminAccess({ email: "", emailConfirmed: true }, [""]).status).toBe("forbidden");
  });

  test("ログイン情報が無い（未ログイン・ユーザー情報の取得失敗）ときは unauthenticated", () => {
    expect(evaluateAdminAccess(null, ADMINS)).toEqual({ status: "unauthenticated" });
  });

  test("似たメールアドレス（部分一致・別ドメイン）は認めない", () => {
    for (const email of ["admin@example.com.evil.test", "xadmin@example.com", "admin@example.co", "admin+x@example.com"]) {
      expect(evaluateAdminAccess({ email, emailConfirmed: true }, ADMINS).status, email).toBe("forbidden");
    }
  });
});

test.describe("実装の静的確認（クライアントの値で判定していない）", () => {
  // コメントの中の言葉に反応しないよう、コメントを除いたコードだけを確認する
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const auth = stripComments(readFileSync("src/lib/admin/auth.ts", "utf8"));
  const user = stripComments(readFileSync("src/lib/auth/user.ts", "utf8"));

  test("確認状態は、サーバーで検証したユーザー情報（getUser）の email_confirmed_at から得ている", () => {
    expect(user).toMatch(/auth\.getUser\(\)/);
    expect(user).toMatch(/email_confirmed_at/);
    expect(user).not.toMatch(/getSession\(\)/);
  });

  test("管理者判定は、getCurrentUser と純粋な判定関数を通している（Cookie・ヘッダー・入力値を読んでいない）", () => {
    expect(auth).toContain("getCurrentUser()");
    expect(auth).toContain("evaluateAdminAccess");
    expect(auth).not.toMatch(/cookies\(|headers\(|searchParams|localStorage/);
  });
});
