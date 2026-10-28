import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildConsentRows, hasAllCurrentConsents, missingConsents } from "@/lib/legal/consent";
import { LEGAL_DOCUMENTS, LEGAL_VERSIONS, formatLegalVersion } from "@/lib/legal/versions";

/**
 * 同意の記録（工程38）の単体テスト。データベースには接続しない。
 * 確認すること: 保存する行（文書・版・経路）、現行の版への同意の判定、古い版では不十分、SQLの安全な設計。
 */
const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test.describe("同意の判定と、保存する行", () => {
  test("版の書式は YYYY-MM-DD で、表示用に日本語の日付へ変換できる", () => {
    for (const doc of LEGAL_DOCUMENTS) expect(LEGAL_VERSIONS[doc]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatLegalVersion("2026-10-28")).toBe("2026年10月28日");
    expect(formatLegalVersion("unknown")).toBe("unknown");
  });

  test("記録が無ければ、すべての文書が未同意", () => {
    expect(missingConsents([])).toEqual(LEGAL_DOCUMENTS);
    expect(hasAllCurrentConsents([])).toBe(false);
  });

  test("現行の版の記録が揃っていれば同意済み。片方だけでは未同意", () => {
    const all = LEGAL_DOCUMENTS.map((document) => ({ document, version: LEGAL_VERSIONS[document] }));
    expect(hasAllCurrentConsents(all)).toBe(true);
    expect(missingConsents(all.slice(0, 1))).toEqual(LEGAL_DOCUMENTS.slice(1));
  });

  test("古い版への同意は、現行の版への同意にならない（改定したら、あらためて同意を求める）", () => {
    const old = LEGAL_DOCUMENTS.map((document) => ({ document, version: "2000-01-01" }));
    expect(hasAllCurrentConsents(old)).toBe(false);
    expect(missingConsents(old)).toEqual(LEGAL_DOCUMENTS);
    // 版を進めたら、これまでの記録では足りなくなる
    const bumped = { terms: "2099-01-01", privacy: LEGAL_VERSIONS.privacy };
    const current = LEGAL_DOCUMENTS.map((document) => ({ document, version: LEGAL_VERSIONS[document] }));
    expect(missingConsents(current, bumped)).toEqual(["terms"]);
  });

  test("保存する行は、サーバー側の現行の版・指定の経路・ユーザーIDだけで作られる（余計な項目を持たない）", () => {
    const rows = buildConsentRows("user-1", "signup");
    expect(rows).toHaveLength(LEGAL_DOCUMENTS.length);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["document", "source", "user_id", "version"]);
      expect(row.user_id).toBe("user-1");
      expect(row.source).toBe("signup");
      expect(row.version).toBe(LEGAL_VERSIONS[row.document]);
    }
    expect(buildConsentRows("user-1", "account").every((r) => r.source === "account")).toBe(true);
  });
});

test.describe("SQL（0004_terms_consents.sql）の設計", () => {
  const sql = read("supabase/migrations/0004_terms_consents.sql");
  // コメント行を除いた、実行される部分
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  test("RLSを有効にし、ポリシーは作らず、anon/authenticated の権限を外している", () => {
    expect(code).toMatch(/alter table public\.terms_consents enable row level security/i);
    expect(code).not.toMatch(/create policy/i);
    expect(code).toMatch(/revoke all on table public\.terms_consents from public, anon, authenticated/i);
  });

  test("ユーザー×文書×版で一意、文書・経路は許可する値だけ、ユーザー削除で連鎖して消える", () => {
    expect(code).toMatch(/unique \(user_id, document, version\)/i);
    expect(code).toMatch(/check \(document in \('terms', 'privacy'\)\)/i);
    expect(code).toMatch(/check \(source in \('signup', 'account'\)\)/i);
    expect(code).toMatch(/references auth\.users \(id\) on delete cascade/i);
  });

  test("更新を拒否するトリガーがある（追記専用）／メールアドレスやIPアドレスの列は持たない", () => {
    expect(code).toMatch(/before update on public\.terms_consents/i);
    expect(code).toMatch(/raise exception/i);
    expect(code).not.toMatch(/\b(email|ip_address|ip|user_agent)\b/i);
  });

  test("何度流しても安全で、破壊的な操作（drop table / truncate / delete from）を含まない", () => {
    expect(code).toMatch(/create table if not exists/i);
    expect(code).not.toMatch(/drop table|truncate|delete from|alter table .* drop/i);
    expect(code).toMatch(/^begin;/im);
    expect(code).toMatch(/^commit;/im);
  });
});

test.describe("決済の前の同意の確認（ソースの静的確認）", () => {
  test("チェックアウトは、同意の確認を、価格の確認・Checkout作成より前に行い、読み取れない場合は止める", () => {
    const src = read("src/app/api/stripe/checkout/route.ts");
    const gate = src.indexOf("getConsentState(user.id)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("verifyPremiumPrice()"));
    expect(gate).toBeLessThan(src.indexOf("checkout.sessions.create"));
    expect(src).toContain("consent_required");
    expect(src).toMatch(/if \(!consent\.ok\)[\s\S]{0,200}status: 503/);
  });

  test("同意の記録を作る処理は、クライアントから版・日時・ユーザーIDを受け取らない", () => {
    const action = read("src/lib/legal/consent-actions.ts");
    expect(action).not.toMatch(/formData\.get\("(version|user_?id|accepted_at|document)"\)/);
    expect(action).toContain("getCurrentUser()");
    const signup = read("src/lib/auth/signup-action.ts");
    expect(signup).not.toMatch(/formData\.get\("(version|user_?id|accepted_at|document)"\)/);
  });

  test("同意の記録・アカウント削除のサーバー専用ファイルは、クライアントから import されない", () => {
    for (const f of ["src/lib/legal/consent-store.ts"]) expect(read(f)).toContain('import "server-only"');
    const clientFiles = ["src/components/auth/signup-form.tsx", "src/components/account/delete-account-form.tsx"];
    for (const f of clientFiles) {
      const src = read(f);
      expect(src).not.toContain("consent-store");
      expect(src).not.toContain("supabase/service");
    }
  });
});

test.describe("アカウント削除の実装（ソースの静的確認）", () => {
  test("削除の対象はセッションのユーザーだけ（フォームのユーザーIDを受け取らない）で、パスワードをログに出さない", () => {
    const src = read("src/lib/account/delete-account-actions.ts");
    expect(src).not.toMatch(/formData\.get\("(user_?id|id|email)"\)/);
    expect(src).toContain("getCurrentUser");
    const logCalls = src.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const call of logCalls) expect(call).not.toMatch(/password|token|secret|email/i);
  });

  test("Stripeの顧客・支払い記録を削除する処理を持たない（保存の要否は運営者の判断が必要）", () => {
    const src = read("src/lib/account/delete-account-actions.ts") + read("src/lib/account/delete-account.ts");
    expect(src).not.toMatch(/customers\.(del|delete)/);
    expect(src).not.toMatch(/subscriptions\.(cancel|del)/);
    expect(src).not.toMatch(/refunds\./);
  });
});
