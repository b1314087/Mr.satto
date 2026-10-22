import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/** 本番の機能スイッチの値を固定する: AI有料プランのため課金はオン、広告は必ずオフ。 */
test("本番の機能スイッチ: billing=true, ads=false（広告が誤って有効にならない）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/config/features.ts"), "utf8");
  const block = src.match(/const PRODUCTION_FLAGS[^{]*\{([\s\S]*?)\};/)?.[1] ?? "";
  expect(block).toMatch(/ads:\s*false/);
  expect(block).toMatch(/billing:\s*true/);
});

test("本番の既定のサイトURLは https://mrsatto.com（環境変数が未設定でも仮のURLにならない）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/config/site.ts"), "utf8");
  expect(src).toContain('"https://mrsatto.com"');
});
