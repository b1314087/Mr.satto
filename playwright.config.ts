import { defineConfig, devices } from "@playwright/test";

/**
 * Mr.Satto 自動テスト基盤（Phase 14）。
 *
 * 方針:
 * - テストフレームワークは @playwright/test のみを使用する（Jest/Vitest等は追加しない）。
 * - webServerは `next dev` に対して実行する。理由は2つ:
 *   1. SEO関連のテスト（title/canonical/OGP/構造化データ等）はNEXT_PUBLIC_SITE_URLの値が
 *      レンダリングに使われるため（Phase 12で判明済み）、起動時にこの環境変数を
 *      明示的に設定していれば dev/build のどちらでも正しい値になる
 *      （Phase 12の問題は「dev/buildの違い」ではなく「env未設定時のフォールバック値」
 *      が原因だった）。
 *   2. pricing/plan回帰テスト（tests/regression/pricing-plan.spec.ts）が使う
 *      Phase 11由来の開発専用Cookie（mrsatto-dev-plan-override等）は、
 *      `process.env.NODE_ENV === "development"` の場合のみ有効になるガードが
 *      本体コード側に入っている（本番動作に影響しないための安全策）。
 *      `next build && next start` はNODE_ENVが常にproductionになりこの経路を
 *      検証できないため、実際にPhase 11のテスト用Cookie機構を使うには
 *      `next dev` に対して実行する必要がある。
 * - webServer はテスト実行時に自動起動する（既に起動済みのサーバーがあればローカル開発時は
 *   再利用する）。
 */

const PORT = process.env.PLAYWRIGHT_TEST_PORT ?? "3100";
// "127.0.0.1" ではなく "localhost" を使う。Next.js 16のdevサーバーは
// dev専用リソース（HMR等）へのクロスオリジンアクセスをデフォルトで遮断しており、
// 実機確認の結果、"127.0.0.1"経由でのアクセスはこの保護に引っかかり、
// 一部のツールページでクライアント側の初期化（フォーム操作等）が
// 正しく完了しないことが判明した。"localhost"はこの保護の対象外であるため、
// アプリ側の設定（next.config.tsのallowedDevOrigins等）を変更せずに
// テスト側だけで回避する。
const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${PORT}`;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mrmatto.vercel.app";

export default defineConfig({
  testDir: "./tests",
  // フィクスチャ生成用の global-setup と実際のテストファイルを区別する。
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // next dev（Turbopack）1インスタンスに対して複数workerが同時にアクセスするため、
  // 並列度を上げすぎるとルートの初回コンパイルが重なって不安定になる。
  // globalSetupでのルート事前ウォームアップと合わせて、ここでは並列度を抑える。
  retries: 1,
  workers: process.env.CI ? 2 : 3,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  outputDir: "./test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  // モバイル表示のSmoke testは個別のprojectを分けず、
  // tests/smoke/mobile.spec.ts 内で test.use(devices["Pixel 7"]) を使って
  // 同じ "chromium" project 内でビューポートを切り替える（project分岐による
  // 「全テストが2倍実行される」事故を避けるため）。
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // このサンドボックス環境には /opt/pw-browsers にChromiumが事前導入されている一方、
        // @playwright/test最新版が要求するリビジョンとズレることがあるため、
        // 事前導入済みの実行ファイルを明示的に指定する（新規ダウンロードを行わない）。
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : undefined,
      },
    },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SITE_URL: SITE_URL,
      PORT,
    },
  },
});
