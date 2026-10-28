import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { tools } from "@/lib/tools/data";

/**
 * increment_tool_usage の入力検証・上限（supabase/migrations/0005_tool_usage_validation.sql）のテスト（工程39）。
 * 使い捨てのPostgreSQLで実際に関数を実行して確認する。本番のSupabaseには接続しない。
 * PostgreSQLが無い環境ではスキップする（scripts/test-tool-usage-sql.sh が 77 を返す）。
 */
test("ツール利用回数のSQL: 識別子の検証・上限・権限・冪等な適用", async () => {
  test.setTimeout(120_000);
  try {
    const out = execFileSync("bash", [path.join(process.cwd(), "scripts/test-tool-usage-sql.sh")], { encoding: "utf8", timeout: 100_000 });
    expect(out).toContain("ALL SQL TESTS PASSED");
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    if (err.status === 77) test.skip(true, "PostgreSQL が見つからないためスキップ");
    throw new Error(`SQL tests failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
});

test("アプリの全ツール識別子が、SQLが許可する形式（小文字英数字とハイフン・最大64文字）に合っている", () => {
  const pattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) expect(tool.id, tool.id).toMatch(pattern);
});

test("SQLの静的確認: 検証と上限があり、PUBLIC・anon から実行権限を外し、破壊的な操作を含まない", () => {
  const sql = readFileSync("supabase/migrations/0005_tool_usage_validation.sql", "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  expect(code).toMatch(/p_tool_id !~ '\^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$'/);
  expect(code).toMatch(/v_daily_cap constant integer := 1000/);
  expect(code).toMatch(/revoke all on function public\.increment_tool_usage\(text\) from public, anon/);
  expect(code).toMatch(/grant execute on function public\.increment_tool_usage\(text\) to authenticated/);
  expect(code).not.toMatch(/drop table|truncate|delete from|alter table/i);
});
