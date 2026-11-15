import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/** 本番の機能スイッチの値を固定する: 課金はオン。2026-11-15から広告もオン（無料はダウンロードのたびに広告を見て使う）。 */
test("本番の機能スイッチ: billing=true, ads=true（どちらかが誤って切り替わらない）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/config/features.ts"), "utf8");
  const block = src.match(/const PRODUCTION_FLAGS[^{]*\{([\s\S]*?)\};/)?.[1] ?? "";
  expect(block).toMatch(/ads:\s*true/);
  expect(block).toMatch(/billing:\s*true/);
});

test("本番の既定のサイトURLは https://mrsatto.com（環境変数が未設定でも仮のURLにならない）", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/config/site.ts"), "utf8");
  expect(src).toContain('"https://mrsatto.com"');
});
