import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { FIELDS, formatRealSummary, judgeFromUi, parseTruthCsv, summarizeReal, type FieldName, type RealDocResult } from "../helpers/receipt-real-eval";

/**
 * 実物の領収書・レシートで、日付・取引先・合計金額の抽出精度を測る評価（工程12）。
 *
 * 【このテストは、実物の評価を行った結果ではなく、実物の評価を行うための道具】
 * 実物の領収書が用意され、利用者が下の手順で実行したときに、はじめて実物の評価になる。通常のテスト実行では、動かない（スキップされる）。
 *
 * 使い方（利用者のパソコンで、領収書をそのパソコンの外へ出さずに実行する）：
 * 1. 好きなフォルダ（このリポジトリの外。例：デスクトップの eval-receipts）に、領収書の画像・PDFを入れる。
 * 2. 同じフォルダに、正解表 truth.csv を作る。1行目は「file,date,vendor,total」。
 *    file：ファイル名、date：YYYY-MM-DD（書類に無ければ空）、vendor：取引先名（無ければ空）、total：円の整数（無ければ空）。
 *    ひな型：tests/fixtures/real-eval/truth.template.csv（架空の例）。
 * 3. 次の環境変数を付けて実行する：
 *      RECEIPT_REAL_EVAL_DIR=（領収書のフォルダ）  RECEIPT_REAL_EVAL_OUT_DIR=（結果を書き出す、このリポジトリの外のフォルダ）
 *    任意：RECEIPT_REAL_EVAL_DETAIL=1 を付けると、書類ごとの詳細（取引先名・金額を含む）も書き出す。
 *
 * 個人情報の扱い：
 * - 領収書は、ブラウザの中（このパソコンの中）で処理され、外部へ送信されない（ツールの仕様。外部送信がないことは別のテストで確認している）。
 * - 結果の書き出し先が、このリポジトリの中のとき（誤ってGitに入れるのを防ぐため）は、実行を止める。
 * - 画面・ログには、件数だけを出す。取引先名・日付・金額・ファイル名は出さない。
 * - 既定で書き出す summary.md / summary.json は、件数だけ（個人情報なし）。詳細（RECEIPT_REAL_EVAL_DETAIL=1）には取引先名・金額が入るため、共有・コミットしないこと。
 */

const EVAL_DIR = process.env.RECEIPT_REAL_EVAL_DIR;
const OUT_DIR = process.env.RECEIPT_REAL_EVAL_OUT_DIR;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

test.describe("receipt-real-eval", () => {
  test.skip(!EVAL_DIR, "実物の領収書の評価は、RECEIPT_REAL_EVAL_DIR を指定したときだけ実行する");
  test.setTimeout(6 * 60 * 60 * 1000);

  test("実物の領収書・レシートで、日付・取引先・合計金額の抽出を評価する（件数だけを記録）", async ({ page }) => {
    const evalDir = path.resolve(EVAL_DIR!);
    if (!OUT_DIR) throw new Error("RECEIPT_REAL_EVAL_OUT_DIR（結果の書き出し先。このリポジトリの外のフォルダ）を指定してください。");
    const outDir = path.resolve(OUT_DIR);
    if (isInside(outDir, path.resolve(process.cwd()))) {
      throw new Error("結果の書き出し先が、このリポジトリの中です。個人情報をGitに入れないよう、リポジトリの外のフォルダを指定してください。");
    }
    const truthPath = path.join(evalDir, "truth.csv");
    if (!fs.existsSync(truthPath)) throw new Error("評価用のフォルダに truth.csv がありません。");
    const parsed = parseTruthCsv(fs.readFileSync(truthPath, "utf8"));
    if (parsed.errors.length > 0) throw new Error(`truth.csv に問題があります：\n${parsed.errors.join("\n")}`);
    fs.mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/tools/receipt-accounting-csv");
    await expect(page.getByTestId("receipt-tool")).toBeVisible();

    const results: RealDocResult[] = [];
    const detail: string[] = ["row,date_outcome,vendor_outcome,total_outcome,date_value,vendor_value,total_value,date_truth,vendor_truth,total_truth"];
    const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

    for (const entry of parsed.entries) {
      const filePath = path.resolve(evalDir, entry.file);
      if (!isInside(filePath, evalDir) || !fs.existsSync(filePath)) {
        results.push({ rowNumber: entry.rowNumber, failed: true, rows: 0, ms: 0 });
        continue;
      }
      const rowsLocator = page.getByTestId("receipt-row");
      const errorJobs = page.locator('[data-testid="receipt-job"][data-status="error"]');
      const before = await rowsLocator.count();
      const beforeErrors = await errorJobs.count();
      const started = Date.now();
      await uploadFixture(page, filePath);
      await expect
        .poll(
          async () => {
            const rows = await rowsLocator.count();
            const errors = await errorJobs.count();
            const summary = (await page.getByTestId("receipt-job-summary").textContent()) ?? "";
            return (rows > before || errors > beforeErrors) && summary.includes("読み取りは完了しています");
          },
          { timeout: 15 * 60 * 1000, intervals: [500, 1000] },
        )
        .toBe(true);
      const ms = Date.now() - started;
      const added = (await rowsLocator.count()) - before;

      if (added === 0) {
        results.push({ rowNumber: entry.rowNumber, failed: true, rows: 0, ms });
      } else if (added > 1) {
        results.push({ rowNumber: entry.rowNumber, failed: false, rows: added, ms });
      } else {
        const row = rowsLocator.nth(before);
        const truth: Record<FieldName, string | null> = {
          date: entry.date,
          vendor: entry.vendor,
          total: entry.total === null ? null : String(entry.total),
        };
        const outcomes = {} as NonNullable<RealDocResult["outcomes"]>;
        const lowConfidence = {} as NonNullable<RealDocResult["lowConfidence"]>;
        const values = {} as Record<FieldName, string>;
        for (const f of FIELDS) {
          const testId = f === "date" ? "receipt-date" : f === "vendor" ? "receipt-vendor" : "receipt-total";
          values[f] = await row.getByTestId(testId).inputValue();
          const candidateBox = row.getByTestId(`receipt-candidates-${f}`);
          const candidates = (await candidateBox.count()) > 0 ? await candidateBox.locator("button").allTextContents() : [];
          outcomes[f] = judgeFromUi(f, values[f], candidates, truth[f]);
          lowConfidence[f] = (await row.getByTestId(`receipt-lowconf-${f}`).count()) > 0;
        }
        results.push({ rowNumber: entry.rowNumber, failed: false, rows: 1, outcomes, lowConfidence, ms });
        if (process.env.RECEIPT_REAL_EVAL_DETAIL) {
          detail.push(
            [
              String(entry.rowNumber),
              outcomes.date,
              outcomes.vendor,
              outcomes.total,
              csvCell(values.date),
              csvCell(values.vendor),
              csvCell(values.total),
              csvCell(truth.date ?? ""),
              csvCell(truth.vendor ?? ""),
              csvCell(truth.total ?? ""),
            ].join(","),
          );
        }
      }

      // 次の書類に影響しないよう、追加された行と、読み取りの表示を消す
      for (let i = 0; i < added; i++) {
        await rowsLocator.nth(before).getByTestId("receipt-delete").click();
      }
      await expect(rowsLocator).toHaveCount(before);
      for (let guard = 0; guard < 5 && (await page.getByTestId("receipt-job").count()) > 0; guard++) {
        const close = page.getByTestId("receipt-job").first().getByRole("button", { name: "閉じる" });
        if ((await close.count()) === 0) break;
        await close.click();
      }
    }

    const summary = summarizeReal(results);
    fs.writeFileSync(path.join(outDir, "summary.md"), formatRealSummary(summary), "utf8");
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1), "utf8");
    if (process.env.RECEIPT_REAL_EVAL_DETAIL) fs.writeFileSync(path.join(outDir, "detail-local-only.csv"), `﻿${detail.join("\r\n")}`, "utf8");
    // 件数だけを出す（取引先名・日付・金額・ファイル名は出さない）
    console.log(`実物評価：ファイル${summary.documents}件、評価${summary.evaluated}件、読み取り失敗${summary.failed}件。結果は指定のフォルダに書き出しました。`);
    expect(summary.documents).toBe(parsed.entries.length);
  });
});
