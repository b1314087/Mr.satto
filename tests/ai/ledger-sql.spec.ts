import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";

/**
 * AI利用台帳のSQL（supabase/migrations/0003_ai_usage_ledger.sql）を、使い捨てのPostgreSQLで検証する。
 * 本番のSupabaseには接続しない。PostgreSQLが無い環境ではスキップする（scripts/test-ai-ledger-sql.sh が 77 を返す）。
 */
test("AI利用台帳のSQL: 予約・確定・解放・期限切れ・同時実行・権限・取り消し", async () => {
  test.setTimeout(170_000);
  try {
    const out = execFileSync("bash", [path.join(process.cwd(), "scripts/test-ai-ledger-sql.sh")], { encoding: "utf8", timeout: 160_000 });
    expect(out).toContain("ALL SQL TESTS PASSED");
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    if (err.status === 77) test.skip(true, "PostgreSQL が見つからないためスキップ");
    throw new Error(`SQL tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
});
