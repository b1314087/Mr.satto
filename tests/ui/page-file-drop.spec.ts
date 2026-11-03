import fs from "node:fs";
import { test as plainTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, waitForFileInputHydrated, waitForSuccess } from "../helpers/tool-runner";
import { containsDirectory, isExternalFileDrag } from "@/lib/drop/page-file-drop";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";

/**
 * ドラッグ&ドロップの全画面対応のテスト。
 * ファイル選択欄（FileDropzone など）がページで唯一の受け取り先のとき、ページのどこに落としても、
 * その欄で選んだときと同じ処理に渡る。外部のファイルのドラッグだけを対象にし、通常の操作は妨げない。
 *
 * ブラウザの実際のドラッグ&ドロップと同じイベント（DragEvent と DataTransfer）を、ファイル選択欄の外
 * （ページの見出しなど）で発生させて確かめる。
 */

interface TestFile {
  name: string;
  mime: string;
  base64: string;
}

const file = (path: string, name: string, mime: string): TestFile => ({ name, mime, base64: fs.readFileSync(path).toString("base64") });
const textFile = (name: string, mime: string, content: string): TestFile => ({ name, mime, base64: Buffer.from(content).toString("base64") });

const overlay = (page: Page) => page.getByTestId("page-drop-overlay");

/** 指定した要素（既定はページの見出し＝ファイル選択欄の外）で、ドラッグのイベントを発生させる。戻り値は defaultPrevented */
async function dragOn(
  page: Page,
  types: string[],
  files: TestFile[] = [],
  opts: { selector?: string; text?: string; clientX?: number; clientY?: number } = {}
): Promise<boolean[]> {
  return page.evaluate(
    ({ types, files, opts }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.mime }));
      }
      if (opts.text) dt.setData("text/plain", opts.text);
      const el = document.querySelector(opts.selector ?? "h1")!;
      return types.map((type) => {
        const ev = new DragEvent(type, {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: opts.clientX ?? 200,
          clientY: opts.clientY ?? 200,
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    },
    { types, files, opts }
  );
}

async function openTool(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
  await waitForFileInputHydrated(page);
}

const png = () => file(fixtures.png, "sample.png", "image/png");

test.describe("全画面のドロップ：共通のファイル選択欄（1つだけ）", () => {
  test("通常はオーバーレイを出さず、ドラッグ中だけ出す。欄の外に落とした画像が読み込まれ、表示は消える。続けて処理・ダウンロードできる", async ({ page }) => {
    await openTool(page, "image-resize");
    await expect(overlay(page)).toHaveCount(0);

    expect(await dragOn(page, ["dragenter", "dragover"], [png()])).toEqual([true, true]);
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toContainText("ここにファイルをドロップ");
    // クリックを通す（下のボタン・リンクの操作を妨げない）
    expect(await overlay(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

    await dragOn(page, ["drop"], [png()]);
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.getByText("sample.png").first()).toBeVisible({ timeout: 20_000 });

    // ファイルを選んだあとの設定・処理・ダウンロードは、これまでどおり
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");
    const download = await clickAndDownload(page, /^ダウンロード$/);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });

  test("対応していない形式は、欄で選んだときと同じ確認で断る", async ({ page }) => {
    await openTool(page, "pdf-compress");
    await dragOn(page, ["dragenter", "dragover", "drop"], [textFile("memo.txt", "text/plain", "hello")]);
    await expect(page.getByText(/このファイル形式には対応していません（memo\.txt）/)).toBeVisible();
    await expect(overlay(page)).toHaveCount(0);
  });

  test("複数ファイルに対応するツールでは、まとめて受け付ける。欄そのものへのドロップは二重に渡らない", async ({ page }) => {
    await openTool(page, "image-format-convert");
    const portrait = file(fixtures.portraitPng, "portrait.png", "image/png");
    await dragOn(page, ["dragenter", "dragover", "drop"], [png(), portrait]);
    await expect(page.getByRole("button", { name: /2件を.*に変換する/ })).toBeVisible({ timeout: 20_000 });

    // 欄そのものへ落としたときは、欄が処理し、全画面の仕組みは同じファイルをもう一度渡さない
    await dragOn(page, ["dragenter", "dragover", "drop"], [file(fixtures.png, "third.png", "image/png")], { selector: ".ms-dropzone" });
    await expect(page.getByRole("button", { name: /3件を.*に変換する/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /4件を/ })).toHaveCount(0);
  });

  test("1ファイルのツールに複数を落としたときは、これまでどおり先頭の1つだけを使う", async ({ page }) => {
    // PDF圧縮はプレミアムの一括処理に対応したため（複数を受け取る）、1ファイルだけを扱うPDFメタデータ削除で確かめる
    await openTool(page, "pdf-metadata-remove");
    await dragOn(page, ["dragenter", "dragover", "drop"], [file(fixtures.singlePagePdf, "first.pdf", "application/pdf"), file(fixtures.multiPagePdf, "second.pdf", "application/pdf")]);
    await expect(page.getByText("first.pdf").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("second.pdf")).toHaveCount(0);
  });
});

test.describe("全画面のドロップ：表示が残らないこと・通常の操作", () => {
  test("ドロップせずに中断した・画面の外へ出た・ページ内のドラッグが終わった場合も、表示は消える", async ({ page }) => {
    await openTool(page, "pdf-compress");
    // 中断（Escキーなど）：ドラッグの通知が止まると、少し待って消える
    await dragOn(page, ["dragenter", "dragover"], [png()]);
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toHaveCount(0, { timeout: 3_000 });

    // 画面の外へ出た
    await dragOn(page, ["dragenter", "dragover"], [png()]);
    await expect(overlay(page)).toBeVisible();
    await dragOn(page, ["dragleave"], [png()], { clientX: 0, clientY: 0 });
    await expect(overlay(page)).toHaveCount(0);

    // ドラッグの終了
    await dragOn(page, ["dragenter", "dragover"], [png()]);
    await expect(overlay(page)).toBeVisible();
    await dragOn(page, ["dragend"], []);
    await expect(overlay(page)).toHaveCount(0);
  });

  test("ページ内の文字・リンクのドラッグや、ファイルを含まないドラッグには反応せず、ブラウザの通常の動作も止めない", async ({ page }) => {
    await openTool(page, "pdf-compress");
    // ファイルを含まない（文字だけの）ドラッグ
    expect(await dragOn(page, ["dragenter", "dragover", "drop"], [], { text: "選んだ文字" })).toEqual([false, false, false]);
    await expect(overlay(page)).toHaveCount(0);

    // ページの中で始まったドラッグ（リンクや画像。dragstart がこのページで起きる）は、ファイルを含んでも対象外
    const link = 'main a[href^="/tools/"]';
    const prevented = await dragOn(page, ["dragstart", "dragenter", "dragover", "drop"], [png()], { selector: link });
    expect(prevented.slice(1)).toEqual([false, false, false]);
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.getByText("sample.png")).toHaveCount(0);
  });

  test("ボタン・入力欄・リンクは通常どおり使える（オーバーレイは通常時に存在しない）", async ({ page }) => {
    await openTool(page, "image-resize");
    await expect(overlay(page)).toHaveCount(0);
    // ファイル選択欄（クリックで選ぶ）も、これまでどおり
    await page.locator('input[type="file"]').first().setInputFiles(fixtures.png);
    await expect(page.getByText("sample.png").first()).toBeVisible({ timeout: 20_000 });
    const width = page.getByRole("spinbutton").first();
    await width.fill("32");
    await expect(width).toHaveValue("32");
    // ツール間の移動
    await page.locator('main a[href="/tools/image-compress"]').first().click();
    await expect(page).toHaveURL(/\/tools\/image-compress$/);
  });

  test("ページを移ると受付をやめる：ファイル選択欄のないページでは、ドラッグに反応しない", async ({ page }) => {
    await openTool(page, "pdf-compress");
    await page.goto("/");
    await expect(page.locator("h1").first()).toBeVisible();
    expect(await dragOn(page, ["dragenter", "dragover"], [png()])).toEqual([false, false]);
    await expect(overlay(page)).toHaveCount(0);
  });
});

test.describe("全画面のドロップ：対象外・特殊な入力", () => {
  test("入力欄が段階的に増えるツール（フォーム→個別PDF）：最初の画面では、ただ1つの欄（帳票のPDF）が受け取り先になる", async ({ page }) => {
    await openTool(page, "form-to-individual-pdfs");
    expect(await dragOn(page, ["dragenter", "dragover"], [png()])).toEqual([true, true]);
    await expect(overlay(page)).toContainText("帳票のPDF");
    await dragOn(page, ["drop"], [png()]);
    // 帳票の欄の確認（PDFのみ）で断られる
    await expect(page.getByText(/このファイル形式には対応していません（sample\.png）/)).toBeVisible();
  });

  test("補助的な入力欄（シフト表の保存ファイルの読み込み）は、全画面のドロップを受けない", async ({ page }) => {
    await page.goto("/tools/shift-schedule");
    await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
    await waitForFileInputHydrated(page);
    expect(await dragOn(page, ["dragenter", "dragover"], [textFile("save.json", "application/json", "{}")])).toEqual([false, false]);
    await expect(overlay(page)).toHaveCount(0);
  });

  test("独自の入力欄（年度カレンダーの予定データ）も、欄の外に落としたExcelを読み込める", async ({ page }) => {
    await page.goto("/tools/fiscal-calendar");
    await expect(page.getByTestId("events-dropzone")).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
      return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
    });
    await page.getByLabel("年度", { exact: true }).selectOption("2026");
    const blob = await writeXlsxSheets([{ name: "予定表", rows: [["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"]] }]);
    const xlsx: TestFile = {
      name: "予定表.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
    };
    await dragOn(page, ["dragenter", "dragover"], [xlsx]);
    await expect(overlay(page)).toContainText("予定データ");
    await dragOn(page, ["drop"], [xlsx]);
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.getByTestId("events-file-name")).toHaveText("予定表.xlsx", { timeout: 30_000 });
  });
});

plainTest.describe("全画面のドロップ：判定（画面なし）", () => {
  plainTest("受け取り先が2つ以上あるときは、どの欄か決められないため全画面のドロップをしない。1つに戻れば再開する", async () => {
    const g = globalThis as unknown as { window?: unknown };
    const hadWindow = "window" in g;
    g.window = { addEventListener() {}, removeEventListener() {} };
    try {
      const { registerPageDropTarget, getPageDropSnapshot } = await import("@/lib/drop/page-file-drop");
      const [a, offA] = registerPageDropTarget({ onFiles: () => {} });
      expect(getPageDropSnapshot().activeId).toBe(a);
      const [, offB] = registerPageDropTarget({ onFiles: () => {} });
      expect(getPageDropSnapshot().activeId).toBeNull();
      offB();
      expect(getPageDropSnapshot().activeId).toBe(a);
      offA();
      expect(getPageDropSnapshot().activeId).toBeNull();
    } finally {
      if (!hadWindow) delete g.window;
    }
  });

  const dt = (types: string[]) => ({ dataTransfer: { types } }) as unknown as DragEvent;

  plainTest("外部のファイルのドラッグだけを対象にする", () => {
    expect(isExternalFileDrag(dt(["Files"]), false)).toBe(true);
    expect(isExternalFileDrag(dt(["Files"]), true)).toBe(false);
    expect(isExternalFileDrag(dt(["text/plain"]), false)).toBe(false);
    expect(isExternalFileDrag({ dataTransfer: null } as unknown as DragEvent, false)).toBe(false);
  });

  plainTest("フォルダが含まれるドロップを見分ける（受け付けない）", () => {
    const item = (isDirectory: boolean) => ({ kind: "file", webkitGetAsEntry: () => ({ isDirectory }) });
    expect(containsDirectory({ items: [item(false), item(true)] } as unknown as DataTransfer)).toBe(true);
    expect(containsDirectory({ items: [item(false)] } as unknown as DataTransfer)).toBe(false);
    expect(containsDirectory({ items: [{ kind: "string" }] } as unknown as DataTransfer)).toBe(false);
    expect(containsDirectory(null)).toBe(false);
  });

  plainTest("ページ全体の受付は window に置き、登録・解除を対にしている（ページ移動で残らない）", () => {
    const src = fs.readFileSync("src/lib/drop/page-file-drop.ts", "utf-8");
    for (const type of ["dragstart", "dragend", "dragenter", "dragover", "dragleave", "drop"]) {
      expect(src).toContain(`window.addEventListener("${type}"`);
      expect(src).toContain(`window.removeEventListener("${type}"`);
    }
    // ファイルの中身を送らない・保存しない
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "indexedDB", "sendBeacon", "XMLHttpRequest", "console."]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});
