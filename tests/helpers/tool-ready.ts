import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { uploadFixture } from "./tool-runner";

/**
 * ツールページで「ファイルを選ぶ」操作を安全に行うための共通ヘルパー（工程3）。
 *
 * 背景（工程2の調査結果）:
 * - ツール本体は next/dynamic() で読み込まれる別の部品で、ページ内の最初の要素
 *   （パンくずのリンクなど）より遅れてhydration（Reactの準備）が完了することがある。
 *   tests/fixtures/premium-test.ts の goto はその「最初の要素」だけを見て待つため、
 *   戻った時点でファイル入力欄がまだ準備前、ということが実測で約6割のページ読み込みで起きた。
 *   準備前に setInputFiles すると、選択が無視されて画面が初期状態のままになることがある。
 * - 開発サーバー(Turbopack)が、HTMLに書いたものと違う名前のチャンクを返して
 *   /_next/static/ の読み込みが 404 になり、ツール本体が起動しないことがある。
 *   この場合は何度ファイルを選び直しても反応しないが、ページの再読み込みで回復する。
 *
 * 方針:
 * - ファイルを選ぶ前に「ファイル入力欄そのもの」のhydration完了を待つ（固定時間ではなく条件で待つ）。
 * - 選択後は、呼び出し側が指定した具体的な準備完了条件（canvas やプレビュー等）を待つ。
 * - 失敗したとき、/_next/static/ の読み込み失敗（開発サーバー由来の環境要因）が確認できた場合に
 *   限り、1回だけ再読み込みして回復を試みる。回復した場合はテスト結果の annotation に残す。
 * - それ以外の失敗（入力欄は準備できたのにcanvasが出ない等、アプリ側の不具合の可能性があるもの）は
 *   再試行せず、診断情報つきで失敗させる。
 */

const FILE_INPUT = 'input[type="file"]';

/** ファイル入力欄のhydration完了を待つ。上限時間までに完了しなければ false を返す（例外にはしない）。 */
export async function waitForFileInputHydrated(page: Page, timeoutMs = 20_000): Promise<boolean> {
  return page
    .waitForFunction(
      (selector) => {
        const input = document.querySelector(selector);
        return !!input && Object.keys(input).some((k) => k.startsWith("__reactProps$"));
      },
      FILE_INPUT,
      { timeout: timeoutMs }
    )
    .then(() => true)
    .catch(() => false);
}

/** このページの読み込み中に失敗した /_next/static/ のリソース（404など）を、ブラウザの記録から取り出す */
async function collectStaticLoadFailures(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((e) => e.name.includes("/_next/static/") && e.responseStatus >= 400)
        .map((e) => `${e.responseStatus} ${e.name.split("/").pop()}`)
    )
    .catch(() => [] as string[]);
}

export interface UploadWhenReadyOptions {
  /** ファイル入力欄のhydrationを待つ上限（ミリ秒） */
  inputTimeoutMs?: number;
  /** ファイル選択後に準備完了条件が満たされるのを待つ上限（ミリ秒） */
  readyTimeoutMs?: number;
  /** 開発サーバーのチャンク404が確認できた場合に、再読み込みで回復を試みる最大回数 */
  maxReloads?: number;
}

/**
 * （goto済みのページで）ファイル入力欄の準備完了を待ってからファイルを選び、
 * `ready` が表示されるまで待つ。回復の条件・診断の方針は、このファイル冒頭のコメントを参照。
 */
export async function uploadWhenReady(
  page: Page,
  files: string | string[],
  ready: Locator,
  options: UploadWhenReadyOptions = {}
): Promise<void> {
  const { inputTimeoutMs = 20_000, readyTimeoutMs = 15_000, maxReloads = 1 } = options;

  for (let attempt = 0; ; attempt++) {
    // 先に短く待ち、準備できない場合はチャンク読み込み失敗の有無を先に確認する
    // （失敗が確認できれば、残りの待機時間を使い切らずに回復へ進める）
    const firstWaitMs = Math.min(8_000, inputTimeoutMs);
    let inputHydrated = await waitForFileInputHydrated(page, firstWaitMs);
    if (!inputHydrated && (await collectStaticLoadFailures(page)).length === 0 && inputTimeoutMs > firstWaitMs) {
      inputHydrated = await waitForFileInputHydrated(page, inputTimeoutMs - firstWaitMs);
    }
    if (inputHydrated) {
      await uploadFixture(page, files);
      const shown = await ready
        .waitFor({ state: "visible", timeout: readyTimeoutMs })
        .then(() => true)
        .catch(() => false);
      if (shown) return;
    }

    const staticFailures = await collectStaticLoadFailures(page);
    if (staticFailures.length > 0 && attempt < maxReloads) {
      // 開発サーバー由来のチャンク読み込み失敗が確認できた場合に限り、再読み込みで回復を試みる。
      try {
        test.info().annotations.push({
          type: "recovered-by-reload",
          description: `開発サーバーのチャンク読み込み失敗を検出して再読み込み: ${staticFailures.join(", ")}`,
        });
      } catch {
        // テスト実行外から呼ばれた場合は記録のみ省略する
      }
      await page.reload();
      continue;
    }

    const readyCount = await ready.count().catch(() => -1);
    const diagnostics = [
      `ファイル入力欄のhydration: ${inputHydrated ? "完了" : `${inputTimeoutMs}ms待っても未完了`}`,
      `ファイル選択後の準備完了条件(${ready}): 表示されず（該当要素数 ${readyCount}）`,
      `/_next/static/ の読み込み失敗: ${staticFailures.length > 0 ? staticFailures.join(", ") : "なし"}`,
      `再読み込みによる回復: ${attempt}回実施`,
      `URL: ${page.url()}`,
    ].join("\n  ");
    // expect を使うことで、Playwrightの失敗表示（スクリーンショット・トレース）が通常どおり残る
    await expect(ready, `ファイルを選んだ後に準備完了条件が満たされませんでした。\n  ${diagnostics}`).toBeVisible({
      timeout: 1_000,
    });
    // 万一ここで表示された場合（直前の判定とのすれ違い）は、回復せず成功として続行する
    return;
  }
}

export interface ClickWhenReadyOptions {
  /** ボタンの表示・有効化・準備完了（onClickが取り付いたこと）を待つ上限（ミリ秒） */
  readyTimeoutMs?: number;
  /** クリック後に現れるはずの画面要素。指定すると、現れるまで待ち、現れなければ診断つきで失敗させる */
  expectAfter?: Locator;
  /** expectAfter を待つ上限（ミリ秒） */
  expectTimeoutMs?: number;
}

/** 要素にReactのonClickハンドラが取り付いている（hydration済み）か。ページ内で評価する関数。 */
function hasReactClickHandler(el: Element): boolean {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) return false;
  return typeof (el as unknown as Record<string, { onClick?: unknown }>)[key]?.onClick === "function";
}

/**
 * ボタンを、準備が完了してからクリックする（onClick を持つボタン用）。
 *
 * ボタンが「表示されている」だけでは、Reactの準備（hydration）が済んでいるとは限らない。
 * 準備前にクリックすると無視され、画面が切り替わらないことがある（工程5の
 * filled-pdf-to-excel-template で、10回中1〜2回の失敗として確認）。
 * そのため、次をすべて満たすまで待ってから、1回だけクリックする。
 * 1. ボタンが表示されている　2. ボタンが有効　3. ボタンにReactのonClickが取り付いている
 * クリックを繰り返すことはしない（状態を切り替えるボタンで、意図せず元に戻すことを避けるため）。
 *
 * `expectAfter` を指定した場合は、クリック後にその要素が現れるまで待つ。
 * 現れなければ、ボタンの状態（aria-pressed・準備状況）つきで失敗させる。
 */
export async function clickWhenReady(button: Locator, options: ClickWhenReadyOptions = {}): Promise<void> {
  const { readyTimeoutMs = 30_000, expectAfter, expectTimeoutMs = 30_000 } = options;

  await expect(button, `クリックするボタンが表示されませんでした: ${button}`).toBeVisible({ timeout: readyTimeoutMs });
  await expect(button, `クリックするボタンが有効になりませんでした: ${button}`).toBeEnabled({ timeout: readyTimeoutMs });
  await expect
    .poll(() => button.evaluate(hasReactClickHandler).catch(() => false), {
      message: `ボタンにReactのonClickが取り付かず（hydration未完了）、準備完了になりませんでした: ${button}`,
      timeout: readyTimeoutMs,
    })
    .toBe(true);

  await button.click();

  if (!expectAfter) return;
  const appeared = await expectAfter
    .waitFor({ state: "visible", timeout: expectTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;

  const pressed = await button.getAttribute("aria-pressed").catch(() => null);
  const handler = await button.evaluate(hasReactClickHandler).catch(() => false);
  await expect(
    expectAfter,
    [
      `ボタンをクリックしましたが、期待する画面要素が現れませんでした: ${expectAfter}`,
      `  ボタン: ${button}`,
      `  クリック後のaria-pressed: ${pressed ?? "(属性なし)"}`,
      `  ボタンのonClick取り付け: ${handler ? "あり" : "なし"}`,
    ].join("\n")
  ).toBeVisible({ timeout: 1_000 });
}
