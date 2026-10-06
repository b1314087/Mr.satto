import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * 「全ツールにプレビュー」の網羅テスト。
 * 各ツールに入力を与えたあと、プレビュー領域(data-testid="tool-preview")が表示されること、
 * かつ中身が空でないことを確認する(見た目の細かな正しさは、各ツール専用のテストで確認する)。
 */

type Input =
  | { kind: "file"; files: string[] }
  | { kind: "text"; text: string }
  | { kind: "none" };

const pdf: Input = { kind: "file", files: [fixtures.multiPagePdf] };
const img: Input = { kind: "file", files: [fixtures.png] };
const csv: Input = { kind: "file", files: [fixtures.csv] };
const xlsx: Input = { kind: "file", files: [fixtures.xlsx] };
const docx: Input = { kind: "file", files: [fixtures.wordRichContentDocx] };
const video: Input = { kind: "file", files: [fixtures.webm] };
const zip: Input = { kind: "file", files: [fixtures.zip] };
const sample: Input = { kind: "text", text: "テスト入力 test 123\n  2行目の文章  \n\n3行目" };
const none: Input = { kind: "none" };

const CASES: [string, Input][] = [
  // PDF
  ...(["pdf-merge", "pdf-split", "pdf-delete-pages", "pdf-reorder-pages", "pdf-rotate", "pdf-extract-pages", "pdf-add-page-numbers", "pdf-watermark", "pdf-resize-pages", "pdf-crop-pages", "pdf-compress", "pdf-metadata-remove", "pdf-to-text", "pdf-to-word", "pdf-to-excel", "ocr", "filled-pdf-to-excel"] as const).map((id) => [id, pdf] as [string, Input]),
  // 画像
  ...(["image-sns-size", "image-crop", "image-batch-convert", "image-to-pdf", "image-flip", "image-grayscale", "image-metadata-remove", "image-layout", "image-passport-photo", "image-padding-text", "image-tile-split", "image-mosaic", "image-resize", "image-compress", "image-rotate"] as const).map((id) => [id, img] as [string, Input]),
  ["image-merge", { kind: "file", files: [fixtures.png, fixtures.jpg] }],
  ["csv-merge", { kind: "file", files: [fixtures.csv, fixtures.csvForMerge] }],
  ["csv-format", { kind: "text", text: "a, b ,c\n 1,2 ,3\n\n4,5,6" }],
  ["excel-label", { kind: "text", text: "山田太郎\n佐藤花子" }],
  // 表
  ...(["csv-to-excel", "csv-dedupe", "csv-replace", "csv-column-editor", "csv-to-json"] as const).map((id) => [id, csv] as [string, Input]),
  ...(["excel-to-csv", "excel-transpose", "excel-blank-remove", "excel-replace", "excel-merge-center", "excel-date-shift", "excel-to-pdf"] as const).map((id) => [id, xlsx] as [string, Input]),
  // 文書
  ...(["word-paragraph-cleanup", "word-renumber", "word-to-pdf"] as const).map((id) => [id, docx] as [string, Input]),
  // ファイル
  ["roster-template", csv],
  ["file-unzip", zip],
  ["file-zip", csv],
  ["file-bulk-rename", csv],
  ["file-sequential-rename", csv],
  ["file-hash", csv],
  ["file-inspector", img],
  // 動画(video-h264 はヘッドレスChromiumがH.264エンコード非対応のため、この環境では対象外)
  ...(["video-convert", "video-compress", "video-resize", "video-frame-rate", "video-thumbnail", "video-metadata-remove"] as const).map((id) => [id, video] as [string, Input]),
  // 文字・数値
  ["char-count", sample],
  ["text-line-cleaner", sample],
  ["text-case-converter", sample],
  ["number-format", { kind: "text", text: "1234567.891" }],
  ["json-formatter", { kind: "text", text: '{"a":1,"b":[1,2,3]}' }],
  ["json-to-csv", { kind: "text", text: '[{"a":1,"b":"x"},{"a":2,"b":"y"}]' }],
  ["qr-generator", { kind: "text", text: "https://example.com" }],
  // 入力なしでも見える/既定値で出るもの
  ["password-generator", none],
  ["date-weekday-tool", none],
  ["time-calculator", none],
  ["color-palette-generator", none],
  ["estimate-generator", none],
  ["invoice-generator", none],
  ["order-generator", none],
  ["envelope-address", none],
  ["ticket-voucher", none],
  ["electronic-stamp-generator", none],
];

for (const [id, input] of CASES) {
  test(`preview: ${id}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/tools/${id}`);
    // Reactの準備(hydration)が終わるまで待つ(入力要素にReactのpropsが付けば完了)
    await page.waitForFunction(
      () => {
        const el = document.querySelector("main input[type=file], main textarea, main input[type=text], main button");
        return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
      },
      null,
      { timeout: 90_000 }
    );
    const preview = page.getByTestId("tool-preview").first();
    // 開発サーバーの初回コンパイル直後はReactの準備(hydration)が終わる前に入力しても無視されることがあるため、
    // プレビューが出るまで、入力を数回やり直す。
    let shown = false;
    for (let attempt = 0; attempt < 5 && !shown; attempt++) {
      if (input.kind === "file") {
        await uploadFixture(page, input.files);
      } else if (input.kind === "text") {
        const field = page.locator("textarea, input[type='text']").first();
        await field.waitFor({ state: "visible", timeout: 20_000 });
        await field.fill(input.text + (attempt ? " " : ""));
      }
      shown = await preview.waitFor({ state: "visible", timeout: attempt === 0 ? 15_000 : 12_000 }).then(() => true).catch(() => false);
    }
    await expect(preview, `${id} のプレビューが表示されません`).toBeVisible({ timeout: 10_000 });
    const box = await preview.boundingBox();
    expect(box && box.width > 20 && box.height > 10, `${id} のプレビューが空です`).toBeTruthy();
  });
}
