import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as processorTest } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";
import {
  SIZE_TOLERANCE_PT,
  inspectOutputPdf,
  pageSizeFor,
  writeSequentialPdf,
  writeSyntheticPdf,
  type OutputPdfInfo,
  type SyntheticPageSpec,
} from "../helpers/pdf-page-quality";
import { PdfRotateProcessor } from "@/lib/processors/browser/pdf";

/**
 * PDFページ操作の出力品質テスト 第1弾（工程7）: 削除・並べ替え・抽出・回転。
 *
 * 「処理が成功してダウンロードできた」だけでは成功扱いにせず、ダウンロードした出力PDFを
 * 実際にパースして、ページ数・元ページの並び・回転角・ページサイズ・本文の保持を検証する。
 * 入力PDFはテストごとに合成する（tests/helpers/pdf-page-quality.ts）。
 *
 * 各ページには「元のページ番号」を示す一意な本文（QA-ORIG-n）と、元ページごとに異なる
 * ページサイズを与えているため、出力の各ページがどの元ページ由来かを本文とサイズの
 * 両方で確認できる。
 */

// ---------------------------------------------------------------------------
// 共通操作
// ---------------------------------------------------------------------------

/**
 * テスト用PDF（入力・ダウンロードした出力）の置き場所。
 *
 * workPath() は「テスト名（日本語・長い）」を含む深いパスになり、そこに置いた
 * PDFは、ファイル入力欄へ setInputFiles() しても選択が黙って無視されることを実測で確認した
 * （画面にファイルが現れない。同じ内容でも、短い英数字だけのパスなら正常に選べる）。
 * テスト名に依存しない短い英数字の一時フォルダを使い、終わったら削除する
 * （失敗したときは、調査用に中身をテスト結果へ添付する）。
 */
let workDir = "";
test.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfqa-"));
});
test.afterEach(async ({}, testInfo) => {
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const name of fs.readdirSync(workDir)) {
        await testInfo.attach(name, { path: path.join(workDir, name) });
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
const workPath = (name: string) => path.join(workDir, name);

/** ツールを開き、ファイル入力欄の準備完了を待ってPDFを選び、`ready`が表示されるまで待つ */
async function openToolWithPdf(page: Page, slug: string, pdfPath: string, ready: Locator) {
  await page.goto(`/tools/${slug}`);
  await uploadWhenReady(page, pdfPath, ready, { readyTimeoutMs: 25_000 });
}

/** 結果のダウンロードボタンを押し、出力PDFを一時フォルダへ保存して、PDFとして妥当であることまで確認してパスを返す */
async function downloadOutputPdf(page: Page, fileName: string): Promise<string> {
  const download = await clickAndDownload(page, /^ダウンロード$/);
  const savedPath = workPath(fileName);
  await download.saveAs(savedPath);
  await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
  return savedPath;
}

interface ExpectedOutput {
  /** 出力の各ページが、元の何ページ目由来であるべきか（出力順） */
  originals: number[];
  /** 元ページ番号 → 出力で期待する回転角。省略時は全ページ0度 */
  rotationOf?: (original: number) => number;
}

/** 出力PDFが期待どおりであること（ページ数・元ページの並び・回転角・ページサイズ）を検証する */
function expectOutput(info: OutputPdfInfo, expected: ExpectedOutput) {
  const rotationOf = expected.rotationOf ?? (() => 0);
  expect(info.pageCount, "出力のページ数").toBe(expected.originals.length);
  expect(info.originalOrder, "出力の各ページの元ページ番号（本文から判定）").toEqual(expected.originals);
  info.pages.forEach((p, i) => {
    const original = expected.originals[i];
    const size = pageSizeFor(original);
    expect(Math.abs(p.width - size.width), `出力${i + 1}ページ目(元${original})の幅`).toBeLessThanOrEqual(SIZE_TOLERANCE_PT);
    expect(Math.abs(p.height - size.height), `出力${i + 1}ページ目(元${original})の高さ`).toBeLessThanOrEqual(SIZE_TOLERANCE_PT);
    expect(p.rotation, `出力${i + 1}ページ目(元${original})の回転角`).toBe(rotationOf(original));
  });
}

// ---------------------------------------------------------------------------
// A. PDFページ削除
// ---------------------------------------------------------------------------

test.describe("pdf-delete-pages: 出力PDFの品質", () => {
  const SLUG = "pdf-delete-pages";
  const ready = (page: Page) => page.getByText("削除するページをタップして選択してください");
  /** ページ選択ボタン。選択後は名前が「n 削除」になるため、どちらの状態にも一致させる */
  const pageButton = (page: Page, n: number) => page.getByRole("button", { name: new RegExp(`^${n}( 削除)?$`) });

  async function selectPages(page: Page, pages: number[]) {
    for (const n of pages) {
      const button = pageButton(page, n);
      await clickWhenReady(button);
      await expect(button, `ページ${n}が選択状態になりませんでした`).toHaveAttribute("aria-pressed", "true");
    }
  }

  test("3ページから2ページ目を削除すると、残り2ページが元の順序・本文のまま出力される", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await openToolWithPdf(page, SLUG, input, ready(page));

    await selectPages(page, [2]);
    await expect(page.getByText("3ページ中1ページを選択")).toBeVisible();
    await clickWhenReady(page.getByRole("button", { name: "1ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });
    await expect(page.getByText(/^2ページ ・/)).toBeVisible();

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "deleted.pdf"));
    expectOutput(info, { originals: [1, 3] });
  });

  test("5ページから先頭と4ページ目を同時に削除しても、他のページは誤って消えない", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 5);
    await openToolWithPdf(page, SLUG, input, ready(page));

    await selectPages(page, [1, 4]);
    await clickWhenReady(page.getByRole("button", { name: "2ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "deleted.pdf"));
    expectOutput(info, { originals: [2, 3, 5] });
  });

  test("回転済みのページも、削除後に向きと内容が維持される", async ({ page }) => {
    const rotations: Record<number, number> = { 1: 0, 2: 90, 3: 180, 4: 270 };
    const specs: SyntheticPageSpec[] = [1, 2, 3, 4].map((n) => ({ original: n, rotation: rotations[n] }));
    const input = workPath("input.pdf");
    await writeSyntheticPdf(input, specs);
    await openToolWithPdf(page, SLUG, input, ready(page));

    await selectPages(page, [1]);
    await clickWhenReady(page.getByRole("button", { name: "1ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "deleted.pdf"));
    expectOutput(info, { originals: [2, 3, 4], rotationOf: (n) => rotations[n] });
  });

  test("何も選んでいない間と、全ページを選んだときは、実行できない（出力は作られない）", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await openToolWithPdf(page, SLUG, input, ready(page));

    // 未選択: 実行ボタンは無効
    await expect(page.getByRole("button", { name: "0ページを削除する", exact: true })).toBeDisabled();

    // 全ページ選択: 注意文が出て、実行ボタンは無効のまま
    await selectPages(page, [1, 2, 3]);
    await expect(page.getByText("すべてのページを削除することはできません")).toBeVisible();
    await expect(page.getByRole("button", { name: "3ページを削除する", exact: true })).toBeDisabled();

    // 出力は作られていない
    await expect(page.getByText("削除が完了しました")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^ダウンロード$/ })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// B. PDFページ並べ替え
// ---------------------------------------------------------------------------

test.describe("pdf-reorder-pages: 出力PDFの品質", () => {
  const SLUG = "pdf-reorder-pages";
  const ready = (page: Page) => page.getByText("↑↓ ボタンでページの順序を並び替えられます");
  const moveDown = (page: Page, position: number) => page.getByRole("button", { name: `${position}番目を下へ移動`, exact: true });
  const moveUp = (page: Page, position: number) => page.getByRole("button", { name: `${position}番目を上へ移動`, exact: true });

  /** 画面の並び順リストから、現在の「元ページ番号」の並びを読み取る */
  async function readOrderFromUi(page: Page): Promise<number[]> {
    const texts = await page.locator("main li").filter({ hasText: "元ページ" }).allInnerTexts();
    return texts.map((t) => Number(/元ページ\s*(\d+)/.exec(t)?.[1]));
  }

  test("3ページを 1,2,3 → 2,3,1 に並べ替えると、出力が指定順になる（欠落・重複なし）", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await openToolWithPdf(page, SLUG, input, ready(page));

    // 変更前は「元の順序」なので適用ボタンは無効
    await expect(page.getByRole("button", { name: "並び替えを適用する" })).toBeDisabled();

    await clickWhenReady(moveDown(page, 1)); // [2,1,3]
    await clickWhenReady(moveDown(page, 2)); // [2,3,1]
    await expect.poll(() => readOrderFromUi(page), { message: "画面上の並び順が 2,3,1 になること" }).toEqual([2, 3, 1]);

    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), {
      expectAfter: page.getByText("並び替えが完了しました"),
    });
    await expect(page.getByText(/^3ページ ・/)).toBeVisible();

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "reordered.pdf"));
    expectOutput(info, { originals: [2, 3, 1] });
    expect([...info.originalOrder].sort(), "元の3ページが過不足なく含まれる").toEqual([1, 2, 3]);
  });

  test("5ページの最後のページを先頭へ移動しても、他のページの順序・内容は維持される", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 5);
    await openToolWithPdf(page, SLUG, input, ready(page));

    // 現在位置5,4,3,2 のページを順に1つ上へ → [5,1,2,3,4]
    for (const position of [5, 4, 3, 2]) {
      await clickWhenReady(moveUp(page, position));
    }
    await expect.poll(() => readOrderFromUi(page), { message: "画面上の並び順が 5,1,2,3,4 になること" }).toEqual([5, 1, 2, 3, 4]);

    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), {
      expectAfter: page.getByText("並び替えが完了しました"),
    });

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "reordered.pdf"));
    expectOutput(info, { originals: [5, 1, 2, 3, 4] });
  });

  test("回転済みのページも、並べ替え後に向きと内容が維持される", async ({ page }) => {
    const rotations: Record<number, number> = { 1: 270, 2: 0, 3: 90 };
    const input = workPath("input.pdf");
    await writeSyntheticPdf(
      input,
      [1, 2, 3].map((n) => ({ original: n, rotation: rotations[n] }))
    );
    await openToolWithPdf(page, SLUG, input, ready(page));

    await clickWhenReady(moveDown(page, 1)); // [2,1,3]
    await clickWhenReady(moveDown(page, 2)); // [2,3,1]
    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), {
      expectAfter: page.getByText("並び替えが完了しました"),
    });

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "reordered.pdf"));
    expectOutput(info, { originals: [2, 3, 1], rotationOf: (n) => rotations[n] });
  });

  test("並べ替えて元の順序に戻すと、適用ボタンは再び無効になる", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await openToolWithPdf(page, SLUG, input, ready(page));

    const apply = page.getByRole("button", { name: "並び替えを適用する" });
    await expect(apply).toBeDisabled();
    await clickWhenReady(moveDown(page, 1)); // [2,1,3]
    await expect(apply).toBeEnabled();
    await clickWhenReady(moveUp(page, 2)); // [1,2,3]
    await expect.poll(() => readOrderFromUi(page)).toEqual([1, 2, 3]);
    await expect(apply).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// C. PDFページ抽出
// ---------------------------------------------------------------------------

test.describe("pdf-extract-pages: 出力PDFの品質", () => {
  const SLUG = "pdf-extract-pages";
  const ready = (page: Page) => page.getByPlaceholder("例: 1,3,5-7");

  const validCases: { name: string; pages: number; selection: string; expected: number[] }[] = [
    { name: "3ページから 1,3 を抽出すると2ページになる", pages: 3, selection: "1,3", expected: [1, 3] },
    { name: "指定した順序(5,2,4)がそのまま出力順になる", pages: 5, selection: "5,2,4", expected: [5, 2, 4] },
    { name: "範囲指定(2-4)で連続した3ページが抽出される", pages: 5, selection: "2-4", expected: [2, 3, 4] },
    { name: "個別ページと範囲の混在(1,3-4)が指定どおりに抽出される", pages: 5, selection: "1,3-4", expected: [1, 3, 4] },
    { name: "前後や区切りの空白があっても指定どおりに抽出される", pages: 5, selection: " 2 , 4-5 ", expected: [2, 4, 5] },
  ];

  for (const c of validCases) {
    test(`${c.name}（指定していないページは含まれない）`, async ({ page }) => {
      const input = workPath("input.pdf");
      await writeSequentialPdf(input, c.pages);
      await openToolWithPdf(page, SLUG, input, ready(page));

      await ready(page).fill(c.selection);
      await expect(page.getByText(`${c.expected.length}ページを抽出します`)).toBeVisible();
      await clickWhenReady(page.getByRole("button", { name: "ページを抽出する" }), {
        expectAfter: page.getByText("抽出が完了しました"),
      });
      await expect(page.getByText(new RegExp(`^${c.expected.length}ページ ・`))).toBeVisible();

      const info = await inspectOutputPdf(await downloadOutputPdf(page, "extracted.pdf"));
      expectOutput(info, { originals: c.expected });
    });
  }

  test("回転済みのページも、抽出後に向きと内容が維持される", async ({ page }) => {
    const rotations: Record<number, number> = { 1: 0, 2: 90, 3: 180, 4: 270 };
    const input = workPath("input.pdf");
    await writeSyntheticPdf(
      input,
      [1, 2, 3, 4].map((n) => ({ original: n, rotation: rotations[n] }))
    );
    await openToolWithPdf(page, SLUG, input, ready(page));

    await ready(page).fill("4,2");
    await clickWhenReady(page.getByRole("button", { name: "ページを抽出する" }), {
      expectAfter: page.getByText("抽出が完了しました"),
    });

    const info = await inspectOutputPdf(await downloadOutputPdf(page, "extracted.pdf"));
    expectOutput(info, { originals: [4, 2], rotationOf: (n) => rotations[n] });
  });

  // UIの仕様: ページ指定欄が空の間は実行できない。不正な指定は、入力した時点でプレビュー欄に
  // 理由が出て、実行するとエラー表示（role="alert"）になり、出力は作られない。
  const invalidCases: { selection: string; message: string }[] = [
    { selection: "0", message: "1以上のページ番号を指定してください" },
    { selection: "9", message: "存在しないページが指定されています" },
    { selection: "3-1", message: "ページ範囲の順序が正しくありません" },
    { selection: "abc", message: "ページ指定の形式が正しくありません" },
    { selection: "1,1", message: "ページ1が複数回指定されています" },
    { selection: ", ,", message: "抽出するページを指定してください" },
  ];

  for (const c of invalidCases) {
    test(`不正なページ指定「${c.selection}」は、理由が表示され、出力は作られない`, async ({ page }) => {
      const input = workPath("input.pdf");
      await writeSequentialPdf(input, 5);
      await openToolWithPdf(page, SLUG, input, ready(page));

      const run = page.getByRole("button", { name: "ページを抽出する" });
      await expect(run, "指定欄が空の間は実行できない").toBeDisabled();

      await ready(page).fill(c.selection);
      // 入力した時点で、プレビュー欄に理由が出る
      await expect(page.locator("p").filter({ hasText: c.message })).toBeVisible();

      await clickWhenReady(run, {
        expectAfter: page.getByRole("alert").filter({ hasText: c.message }),
      });

      await expect(page.getByText("抽出が完了しました")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^ダウンロード$/ })).toHaveCount(0);
    });
  }
});

// ---------------------------------------------------------------------------
// D. PDFページ回転
// ---------------------------------------------------------------------------

test.describe("pdf-rotate: 出力PDFの品質", () => {
  const SLUG = "pdf-rotate";
  const ready = (page: Page) => page.getByRole("button", { name: "回転する", exact: true });
  /** 入力に最初から設定しておく回転角（元ページ番号 → 角度）。向きがバラバラのPDFで、ページごとの加算を確認する */
  const INITIAL: Record<number, number> = { 1: 0, 2: 90, 3: 180 };
  const specs: SyntheticPageSpec[] = [1, 2, 3].map((n) => ({ original: n, rotation: INITIAL[n] }));

  /** 回転量を選んで実行する（クリックは1回ずつ。選択の反映と完了表示まで確認する） */
  async function rotateWith(page: Page, degrees: 90 | 180 | 270) {
    await clickWhenReady(page.getByRole("button", { name: `${degrees}°`, exact: true }), {
      expectAfter: page.getByText(`時計回りに${degrees}°回転します`),
    });
    await clickWhenReady(ready(page), { expectAfter: page.getByText("回転が完了しました") });
  }

  for (const degrees of [90, 180, 270] as const) {
    test(`${degrees}°回転すると、全ページの回転角が元の角度に${degrees}°加算され、ページ数・内容・サイズは変わらない`, async ({ page }) => {
      const input = workPath("input.pdf");
      await writeSyntheticPdf(input, specs);
      await openToolWithPdf(page, SLUG, input, ready(page));

      await rotateWith(page, degrees);
      await expect(page.getByText(/^3ページ ・/)).toBeVisible();

      const info = await inspectOutputPdf(await downloadOutputPdf(page, "rotated.pdf"));
      expectOutput(info, { originals: [1, 2, 3], rotationOf: (n) => (INITIAL[n] + degrees) % 360 });
    });
  }

  test("90°を2回続けて回転すると、合計180°になる（出力を入力に戻して累積を確認）", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSyntheticPdf(input, specs);
    await openToolWithPdf(page, SLUG, input, ready(page));
    await rotateWith(page, 90);
    const firstPass = await downloadOutputPdf(page, "rotated-1.pdf");
    expectOutput(await inspectOutputPdf(firstPass), { originals: [1, 2, 3], rotationOf: (n) => (INITIAL[n] + 90) % 360 });

    // 1回目の出力を、もう一度ツールに入力する
    await openToolWithPdf(page, SLUG, firstPass, ready(page));
    await rotateWith(page, 90);
    const secondPass = await downloadOutputPdf(page, "rotated-2.pdf");
    expectOutput(await inspectOutputPdf(secondPass), { originals: [1, 2, 3], rotationOf: (n) => (INITIAL[n] + 180) % 360 });
  });

  test("270°回転したあとに90°回転すると、360°で元の向きに戻る", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSyntheticPdf(input, specs);
    await openToolWithPdf(page, SLUG, input, ready(page));
    await rotateWith(page, 270);
    const firstPass = await downloadOutputPdf(page, "rotated-1.pdf");

    await openToolWithPdf(page, SLUG, firstPass, ready(page));
    await rotateWith(page, 90);
    const secondPass = await downloadOutputPdf(page, "rotated-2.pdf");
    expectOutput(await inspectOutputPdf(secondPass), { originals: [1, 2, 3], rotationOf: (n) => INITIAL[n] });
  });
});

// ---------------------------------------------------------------------------
// D'. PDFページ回転（処理ロジックを直接呼ぶ補足テスト）
// ---------------------------------------------------------------------------
// 画面（pdf-rotate）は「すべてのページを回転する」仕様で、ページを指定する操作を公開していない。
// 一方、処理ロジック(PdfRotateProcessor)は pageNumbers で対象ページを限定できる。
// 「指定したページだけが回転し、指定していないページは変わらない」ことを、画面を経由せず
// 処理ロジックを直接呼んで確認する（アプリ本体のコードは変更しない）。

processorTest.describe("PdfRotateProcessor（ページ指定）: 出力PDFの品質", () => {
  const INITIAL: Record<number, number> = { 1: 0, 2: 90, 3: 180, 4: 270 };

  async function rotatePages(rotateBy: 90 | 180 | 270, pageNumbers: number[]) {
    const inputPath = workPath("input.pdf");
    await writeSyntheticPdf(
      inputPath,
      [1, 2, 3, 4].map((n) => ({ original: n, rotation: INITIAL[n] }))
    );
    const file = new File([fs.readFileSync(inputPath)], "input.pdf", { type: "application/pdf" });
    const output = await new PdfRotateProcessor().process({ file, rotateBy, pageNumbers });
    try {
      const outPath = workPath("rotated.pdf");
      fs.writeFileSync(outPath, Buffer.from(await output.blob.arrayBuffer()));
      return await inspectOutputPdf(outPath);
    } finally {
      URL.revokeObjectURL(output.url);
    }
  }

  processorTest("2ページ目だけを90°回転すると、2ページ目だけ角度が変わり、他のページは変わらない", async () => {
    const info = await rotatePages(90, [2]);
    expectOutput(info, { originals: [1, 2, 3, 4], rotationOf: (n) => (n === 2 ? (INITIAL[n] + 90) % 360 : INITIAL[n]) });
  });

  processorTest("複数ページ(1と4)を180°回転すると、その2ページだけが変わり、同じページを重複指定しても二重には回らない", async () => {
    const info = await rotatePages(180, [1, 4, 4]);
    expectOutput(info, { originals: [1, 2, 3, 4], rotationOf: (n) => (n === 1 || n === 4 ? (INITIAL[n] + 180) % 360 : INITIAL[n]) });
  });
});
