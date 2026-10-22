# Mr.Satto 現状把握報告書（ChatGPT向け）

作成: Claude ／ 調査日: 2026-10-22 ／ 位置づけ: **現状の事実整理のみ。工程表・フェーズ番号・実装順序・優先順位は含まない**（それらはChatGPT側で決める）。

この報告書の読み方:

- 各項目に、根拠となるファイルパスを付けています（リポジトリ内の相対パス）。
- 判定の区分は次の4つです。
  - **【事実】**: コード・実行結果から確認できたこと。
  - **【問題の可能性】**: 問題になりうるが、実害の有無は未確定のこと（ID: P-A1…=利用者・課金・データに影響しうるもの／P-B1…=整理・表示・文書の不整合など軽微なもの。2つを混ぜないために分けています）。
  - **【未確認】**: 外部サービスの状態など、この調査では確かめられないこと（ID: U-01…）。
  - **【改善候補】**: 決定事項ではなく、候補として挙げるだけのもの（ID: C-01…。順不同・優先順位なし）。
- 秘密情報（キー・トークン・個人情報）は、この報告書に含めていません。

---

## 1. 調査日時・対象コミット

| 項目 | 内容 |
|---|---|
| 調査日 | 2026-10-22（日本時間の夕方） |
| 調査対象 | Macの正本 `~/Desktop/Mr-Satto`（読み取りのみ） |
| ブランチ | `main` |
| HEAD | `150ffd51b0efa3602d4dde9dba9b51eda80e1eb5`（「Customer Portalの設定をMr.Satto専用に指定できるようにし、OpenAI実接続の確認テストを追加」） |
| ローカルの `origin/main` との関係 | 一致（`git status -sb` が `main...origin/main` で差分なし）。ただし `git fetch` はしていないため、GitHub上の最新との一致は【未確認】 |
| 作業ツリー | クリーン（`git status --porcelain` が空）。未コミットの変更なし |
| 無視されているファイル | `.DS_Store`、`.holiday-sync-build/`、`next-env.d.ts`、`node_modules/`、`playwright-report/`、`test-results/`、`tests/fixtures/generated/`、`tsconfig.tsbuildinfo`（いずれも `.gitignore` 対象。ソースではない） |
| Gitフック | 有効なフックなし（`.git/hooks` に実行可能なフックなし、husky / lefthook も未使用） |
| 規模 | 追跡ファイル613個。`src` のTS/TSXは約83,200行、`tests` は約25,000行 |
| 履歴 | 135コミット（2026-09-23〜2026-10-22）。作成者は「Claude」134件・ユーザー1件 |
| 直近のコミット | `150ffd5` ポータル設定ID／OpenAI実接続テスト → `f27f44f` 課金OFF中はAI APIを利用不可 → `7b36bce` AI読み取り補助・料金統一・規約更新 → `edf380a` 予定取込の警告追加 → `2762024` 祝日データ自動更新 |

調査の方法:

1. Macのリポジトリを、読み取りコマンドだけで調べた（コードの閲覧・検索・集計）。
2. ツール数などの集計は、報告書や過去のフェーズ資料ではなく、**現在のソース**（`src/lib/tools/data.ts` をTypeScriptで評価した結果）から算出した。
3. 型チェック・Lint・本番ビルド・全自動テスト・`npm audit` は、Macと**ファイルの内容が一致していること**（`src`・`tests`・`scripts`・`supabase`・`public` の各ディレクトリと、`package.json`・`package-lock.json`・`next.config.ts`・`playwright.config.ts`・`tsconfig.json`・`eslint.config.mjs`・`.env.example`・`.gitignore` を、ファイルごとのハッシュで照合済み。`.github` は複製に無いため対象外）を確認したクラウド側の複製で実行した（Macのファイルは変更していない）。環境変数（Stripe/Supabase/OpenAIのキー等）は一切設定していない状態での結果である。
4. Stripe / OpenAI / Supabase / Vercel には一切アクセスしていない（管理画面・API・CLIとも）。コードの変更、コミット、プッシュ、デプロイもしていない。

---

## 2. サービス全体の概要

### 2.1 サービスの内容【事実】

- 「面倒な作業を、サッと。」をコンセプトにした、日本語の無料Webツール集（`src/lib/config/site.ts`）。画像・PDF・Excel/CSV・Word・PowerPoint・動画・音声・ファイル・生成系・その他の**106ツール**が登録されている（詳細は3章・付録A）。
- すべてのツールは、**利用者のブラウザ内で処理が完結する**設計（全106ツールが `processor: "browser"`。サーバーでファイルを処理するツールは0個）。
- 年度カレンダー作成ツール（`fiscal-calendar`）だけが、Excelの予定表の取り込みと、（課金ON時のみ）Premium向けの「AIで読み取る」補助を持つ。AI補助だけが、サーバー経由で外部（OpenAI API）へ文字を送る。

### 2.2 技術構成【事実】（`package.json`）

- Next.js 16.3.6（App Router・Turbopack）、React 19.2.8、TypeScript（`strict: true`）、Tailwind CSS 4、`next-themes`（ダークモード）。
- 主なライブラリ: `pdf-lib`・`pdfjs-dist`・`@pdf-lib/fontkit`（PDF）、`docx`・`mammoth`（Word）、`read-excel-file`・`write-excel-file`（Excel）、`tesseract.js`（OCR）、`onnxruntime-web`（背景除去）、`mediabunny`・`@mediabunny/mp3-encoder`（動画・音声）、`qrcode`・`jsbarcode`、`fflate`（ZIP）、`stripe` 22.6.2、`@supabase/supabase-js` 2.117.1、`@supabase/ssr`。
- テスト: `@playwright/test` 1.63のみ（Jest/Vitest等は使っていない）。
- Node.jsの指定（`engines`）は `package.json` に無い。GitHub Actionsでは Node 22 を使用。
- フォント・OCR言語データ・背景除去モデル・WASMは `public/`（約51MB）に自前で置いており、実行時に外部CDNから取得しない（`public/fonts`、`public/tesseract`、`public/models/u2netp.onnx`、`public/ort`）。

### 2.3 画面・API・サーバー側の処理【事実】

画面（`src/app/**/page.tsx`）:

- 公開: `/`、`/tools`、`/tools/[tool]`（ツール詳細。カテゴリ10種を含む）、`/about`、`/privacy`、`/terms`、`/licenses`、`/pricing`、`/tokushoho`、`/login`、`/signup`、`/auth/forgot-password`、`/auth/reset-password`。
- ログイン後: `/account`（`robots: noindex`）。
- 管理: `/admin`、`/admin/members`、`/admin/usage`（管理者のみ。後述）。

API（`src/app/api/**/route.ts`）: 5本のみ。

| パス | 役割 |
|---|---|
| `POST /api/stripe/checkout` | Premiumの決済ページ（Stripe Checkout）を作る |
| `POST /api/stripe/portal` | 解約・支払い方法変更のページ（Stripe Customer Portal）を作る |
| `POST /api/stripe/webhook` | Stripeからの通知を受け、契約状態を同期する |
| `POST /api/ai/calendar-assist` | 年度カレンダーのAI読み取り補助 |
| `GET /api/ai/usage` | AI利用枠（AIトークン）の使用量・残量を返す |

ほかに、認証コールバック `src/app/auth/callback/route.ts`・`reset-callback/route.ts`、Server Actions（`"use server"`）が7ファイル（ログアウト、広告視聴による一時利用権、記入済みPDF→Excelの利用権）、`src/proxy.ts`（Next.js 16の旧middleware。静的ファイル以外の全パスで Supabase のセッションを検証・更新する。Supabase未設定なら何もしない）がある。

描画方式（クラウド側の本番ビルドの結果）【事実】: `/tools/[tool]` は**動的描画（ƒ）**、カテゴリ10ページとそのOGP画像は静的生成（●）。ツール詳細ページが動的なのは、Cookie（一時利用権・ログイン）を読むため（`src/lib/plans/temporary-access-actions.ts` の `checkTemporaryAccess()`）。なお、このビルドは Supabase の環境変数が無い状態で行ったため、`/admin`・`/account` などが静的（○）と表示された。**Vercel本番での各ルートの描画方式は【未確認】**（U-14）。

### 2.4 認証と権限【事実】

- Supabase Auth の**メールアドレス＋パスワード**のみ（外部ログイン／OAuthなし）。パスワードは8文字以上（`src/components/auth/signup-form.tsx`）。メール確認リンク、パスワード再設定あり。
- 会員登録時の規約・プライバシーポリシーへの同意は**ブラウザ上のチェックのみ**で、同意の日時などをサーバーに記録していない（`src/lib/auth/signup-consent.ts` の注記）。
- ログイン状態の判定は常にサーバー側（`supabase.auth.getUser()` でJWTを検証、`src/lib/auth/user.ts`）。ブラウザの値だけではPremium扱いにならない。
- 開発用のプラン上書きCookieは `NODE_ENV === "development"` のときだけ有効で、本番ビルドでは見ない（`src/lib/plans/current-plan.ts`）。
- 管理画面は `ADMIN_EMAILS`（サーバー専用の環境変数）に含まれるメールのログインユーザーだけ。未設定なら管理者は0人（`src/lib/admin/config.ts`、`src/app/admin/layout.tsx` と各ページの二重チェック）。
- ログイン後の遷移先（`?next=`）は、`/` で始まり `//` で始まらない相対パスだけを許可する（`src/components/auth/login-form.tsx`）。
- アカウント削除（退会）の画面・処理は、コード上に**存在しない**（`退会`・`deleteUser` の検索結果0件）。

### 2.5 データベース・保存【事実】

Supabase（PostgreSQL）のテーブル（`supabase/migrations/0001〜0003`）。すべてRLS（行レベルセキュリティ）有効。

| テーブル | 内容 |
|---|---|
| `profiles` | ユーザープロフィール（登録時のトリガーで作成） |
| `subscriptions` | ユーザーごとの現在の契約状態（1ユーザー1行。書き込みはサービスロールのサーバーコードのみ） |
| `stripe_webhook_events` | Webhookの重複処理防止（イベントID） |
| `tool_usage_daily` | 旧「記入済みPDF→Excel」の利用回数。**現在コードからは書き込まれていない**（`src/lib/admin/data.ts` の注記） |
| `ai_usage_periods` / `ai_usage_requests` | AI利用枠の台帳（期間ごとの使用額、依頼ごとの記録。入力・出力の本文は保存しない） |

- 利用者のファイルを保存する仕組み（Supabase Storage等）は、コード上に無い（`storage.from` の検索結果0件）。
- ブラウザ側の保存: 電子印鑑ツールが `localStorage` を使う（`electronic-stamp-generator-tool.tsx`）ほか、一時利用権のCookie（署名付き。JavaScriptから読めるよう `httpOnly` ではない。仕様上の理由がコードに明記されている）。
- AI台帳の操作は、サービスロールだけが実行できる関数（`ai_reserve` / `ai_settle` / `ai_release` / `ai_get_usage`）経由。`anon` / `authenticated` からの実行権限が実際に外れているかは、本番DBでの確認が必要で**【未確認】**（U-03）。

### 2.6 外部サービスとの連携【事実】

| 外部サービス | 用途 | コード上の状態 |
|---|---|---|
| Stripe | 月額課金（Checkout／Customer Portal／Webhook） | 課金フラグOFFの間は、3つのAPIとも利用不可（Webhookは受信しても何もせず200） |
| Supabase | 認証・DB | 常時使用（未設定でもツールは使える） |
| OpenAI API | 年度カレンダーのAI読み取り補助のみ | 課金フラグOFFの間は利用不可。Vercelプレビュー環境では常に利用不可 |
| Google AdSense / Google Ad Manager | 通常広告・リワード広告 | 広告フラグOFFの間は、スクリプトも読み込まない |
| Vercel | ホスティング。`main` へのpushで自動デプロイ | コード外の設定 |
| GitHub Actions | 祝日データの毎週自動更新（`.github/workflows/sync-holidays.yml`） | 内閣府の公式CSVを取得し、検証・テストが通れば `main` へ直接pushする |
| Googleフォーム | お問い合わせ窓口（`siteConfig.contactFormUrl`）。メール `contact@mrsatto.com` も記載 | — |

### 2.7 ビルド・テスト・Lintの仕組み【事実】

- `npm run dev / build / start / lint / test`、`holidays:sync`、`test:features-off`（`package.json`）。
- CIは `sync-holidays.yml`（祝日更新時のみ、型チェック→ESLint→カレンダーのテスト）**だけ**。通常のpushやPull Requestで自動的にテスト・Lintを走らせる仕組みは、リポジトリ内に無い。Vercelのビルド（`next build`。型チェックを含む）は、push時にVercel側で走る。
- Playwrightは `next dev` に対して実行する設定（本番ビルドでは検証できない開発用Cookieの経路があるため。`playwright.config.ts` の注記）。

### 2.8 機能スイッチ・主な制約【事実】

- `src/lib/config/features.ts`: 本番（`NODE_ENV=production`。Vercelの本番とプレビューの両方）では `PRODUCTION_FLAGS = { ads: false, billing: false }`。開発・テストでは常にオン（`NEXT_PUBLIC_FEATURES_OFF=1` でオフにして確認できる）。値の変更はビルドに埋め込まれるため、変更には再デプロイが必要。
- `src/lib/tools/data.ts` の `ALL_TOOLS_STANDARD = true`（16行目）: 一時的な運用スイッチ。`true` の間、元は「プレミアム限定」だった16ツールを含む**全106ツールが「通常」扱い**になる。元の設定は定義側に残っている（3章）。
- **現在の本番の挙動（コードから読み取れるもの）**: ログイン・会員登録・料金・特商法の導線は非表示（`/pricing` 等は「準備中」表示で `noindex`）、全ツールが無料・広告なし・会員登録不要で使える、Stripeの3API・AI APIは利用不可。実際の本番がこの通りかは、デプロイ状態に依存するため**【未確認】**（U-14）。

---

## 3. 機能・ツール一覧と集計

### 3.1 実数（現在のソースから算出）【事実】

- 登録数: **106**（`src/lib/tools/data.ts`）。状態はすべて `available`、`coming-soon`（準備中）は**0**。
- 重複IDは**0**、検索キーワード（`keywords`）が無いツールも**0**。
- 登録と実装の対応: 画面側の対応表（`src/components/tools/tool-registry.tsx`）は、`case` 99個＋画像共通実装の対象7個＝**106個**で、登録106個と過不足なく一致（登録だけで実装が無いもの0／実装だけで未登録のもの0。`tests/registry/tool-implementation-coverage.spec.ts` も同じ観点のテスト）。
- 処理場所: 106ツールすべて `processor: "browser"`。
- 「おすすめ」表示（`featured`）: 10ツール（`image-resize`、`image-compress`、`csv-format`、`pomodoro-timer`、`business-card-qr`、`invoice-generator`、`filled-pdf-to-excel`、`color-palette-generator`、`qr-generator`、`password-generator`）。

### 3.2 カテゴリ別の内訳【事実】

| カテゴリ（ID） | 件数 |
|---|---|
| 画像（image） | 23 |
| PDF（pdf） | 20 |
| Excel・CSV（csv-excel） | 16 |
| その他（other） | 16 |
| 生成ツール（generator） | 8 |
| 動画（video） | 7 |
| 音声（audio） | 6 |
| ファイル（file） | 5 |
| Word（word） | 4 |
| PowerPoint（pptx） | 1 |
| **合計** | **106** |

全ツールのID・名称・実装ファイル・説明は**付録A**に載せた（付録Aは `data.ts` と `tool-registry.tsx` から機械的に生成したもの）。

### 3.3 プラン区分【事実】

- 各ツールの `requiredPlan` の元の設定: `standard` が90、`premium` が**16**。
  - premiumの16: `pdf-to-excel`、`pdf-to-word`、`word-to-pdf`、`excel-to-pdf`、`ocr`、動画7（`video-convert`、`video-compress`、`video-resize`、`video-frame-rate`、`video-h264`、`video-thumbnail`、`video-metadata-remove`）、書類作成4（`estimate-generator`、`quote-order-generator`、`invoice-generator`、`order-generator`）。
- 実際に効く値（`ALL_TOOLS_STANDARD = true` を反映後）: **106ツールすべて `standard`**。
- 権限判定の唯一の場所は `canUseTool()`（`src/lib/plans/access.ts`）。`free × standard` は「利用可・広告必要」、`premium` の判定は premium プランだけ。
- 実際の広告ゲート: 広告フラグOFFの間は `isRewardedAdGateActive()` が常に false（`src/lib/ads/gam-config.ts`）なので、ダウンロード時の広告確認も行われない。

### 3.4 実装上の特徴【事実】

- 共通実装: 画像リサイズ・圧縮・JPG/PNG/WebP変換・回転の7ツールは `image-canvas-tool.tsx` を共有。見積書・請求書・注文書は `document-generator-tool.tsx` を共有（`invoice-generator-tool.tsx` 等が薄いラッパー）。
- 読み込み: 各ツールの画面コンポーネントは `next/dynamic` による動的読み込み。OCRだけは、動的化するとWorkerの読み込みが失敗した過去の経緯で静的importのまま（`tool-registry.tsx` 冒頭の説明）。
- 入力サイズの上限: 32ファイルにサイズ制限の記述がある（例: 画像20MB、Word30MB、ZIP展開の合計300MB・1ファイル100MB・展開後800MB、Excel予定表10MB、動画の上限は大きめ／無制限に近い値あり）。メモリ不足時の挙動は実機で未確認【未確認】（U-17）。
- エラー処理: 共通部品 `ErrorMessage`・`ProcessingStatus`（`src/components/common/`）で表示する作り。各ツールの入力検証・エラー表示の網羅性は、全ツールの個別精査まではしていない【未確認】。
- ブラウザ依存: 動画・音声は、ブラウザのデコード能力（H.264、AAC、FLACなど）に依存する。テストにも、環境が非対応ならスキップする箇所がある（`tests/tools/video.spec.ts:76`、`tests/tools/audio.spec.ts:82,101,238`）。
- カテゴリ分けで目を引く点【事実／軽微】: `pdf-to-excel` は `csv-excel`、`pdf-to-word`・`excel-label`（ラベル作成）は `word`、`pdf-to-image` は `image`、`fiscal-calendar`・`sequence-generator` は `generator` にある。IDが他と違う形式のもの: `date-weekday-tool`（末尾に `-tool`）。URLに影響するため、変更時はリダイレクトが必要（`next.config.ts` に過去の分類変更のリダイレクトがある）。
- 旧設計の名残【事実／軽微】: `src/lib/processors/server/index.ts` の `NotImplementedServerProcessor` は、どこからも使われていない。`ProcessorEngine` の型は `"server"`・`"auto"` を許すが、実際に使うツールは0。

### 3.5 テストの対応【事実】

- 106ツールすべてのIDが、レジストリ系以外のテストファイルにも登場する（`tests/tools/` 55ファイル、ほか）。ただし「IDが登場する」ことは、そのツールの入出力が十分に検証されていることを意味しない。深さの評価は【未確認】。

---

## 4. 年度カレンダー・予定表取り込みの現状

主な実装: `src/lib/calendar/`（`model.ts`、`holidays.ts`、`holiday-data*.ts`、`events.ts`、`event-import.ts`、`excel.ts`、`pdf.ts`、`themes.ts`、`layout.ts`）、画面 `src/components/tools/implementations/fiscal-calendar-tool.tsx` と `shared/fiscal-calendar-*.tsx`、処理 `src/lib/processors/browser/fiscal-calendar.ts`。

### 4.1 カレンダーの生成【事実】

- 年度は4月〜翌年3月。画面で選べる年度は**2020〜2050**（`FISCAL_YEAR_UI_MIN/MAX`）。内部の計算の対応範囲は2000〜2098年度、祝日の計算は2000〜2099年。範囲外は例外（`RangeError`）で、画面の選択肢には出ない。
- 週の開始（月曜／日曜）、デザイン5種＋利用者指定の4色（`themes.ts`）、用紙の向き（横／縦）、前後の月の日の表示、1シートに1か月／2か月、を選べる。
- 画面のプレビューとExcel・PDFは、同じ共通モデル（`model.ts`・`events.ts`）だけを見て描く（出力ごとに別の解釈をしない設計）。
- 和暦表記（令和・平成）に対応。2019年度以降は令和。
- 出力: **Excel（.xlsx）**（`write-excel-file` で作ったものをXMLレベルで補正。印刷範囲・用紙設定・枠固定などを設定）と **PDF**（`pdf-lib`＋Noto Sans JP）。どちらもブラウザ内で生成。
- 印刷結果の確認テストは、LibreOffice（`soffice`）があるときだけ実行し、無い環境ではスキップする（`tests/calendar/calendar-excel-print.spec.ts:48`、`calendar-events-output.spec.ts:405`）。

### 4.2 祝日の扱い【事実】

- 法律で決まる祝日はルール関数（`holidays.ts`）で計算。春分・秋分は、公示済みの年だけ確定表（`CONFIRMED_EQUINOX_DAYS`）を使い、それより先は計算式による「推定」。
- 確度は3段階（`HolidayStatus`）: 確定／法律どおり（法改正で変わりうる）／推定。**画面・Excel・PDFとも、推定の日には「※」と注記**を出す（`model.ts` の `monthNote()`）。
- 現在のデータ: 確定済みの最終年 `CONFIRMED_THROUGH_YEAR = 2027`、最終確認日 `HOLIDAY_DATA_CHECKED_AT = "2026-10-19"`（`src/lib/calendar/holiday-data.generated.ts`。自動生成ファイル）。
- 自動更新: GitHub Actionsが毎週月曜に内閣府のCSVを取得 → 検証 → 差分があれば更新 → 型チェック・Lint・カレンダーのテストが通ったときだけ `main` に直接push → Vercelが自動公開。失敗時はGitHubのIssueで通知（`.github/workflows/sync-holidays.yml`）。**実際にActionsが定期実行され成功しているか、`main` のブランチ保護との相性（botのpush許可）は【未確認】**（U-12）。生成ファイルの確認日が2026-10-19であることは、ある時点で更新処理が動いた形跡を示すにとどまる。

### 4.3 Excelの予定表の取り込み【事実】（`src/lib/calendar/event-import.ts`、`shared/fiscal-calendar-events-import.tsx`）

- 対応形式: **.xlsx／.xlsm のみ**。**CSVと旧形式（.xls）は取り込めない**（.xlsは専用の案内文を出す）。ファイルは10MBまで、読み込める行は20,000行まで。
- ファイルは端末内で読み取り、外部へ送らない。
- 列の判定: 見出し行（先頭30行から「日付」と「予定」の両方の列名が見つかる行）を探し、列名の表記ゆれ（例「日にち」「開催日」「件名」「行事名」「Start Time」）を許して「日付・予定・開始・終了」を割り当てる。見つからなければ位置から推定し、利用者が列の割り当てを画面で選び直せる。複数シートがあれば、予定表らしいシートを自動で選び、利用者が切り替えられる。
- 日付の読み取り: Excelの日付セル、シリアル値、8桁数字（20270405）、`2027/4/5`・`2027-04-05`・`2027年4月5日`、和暦（令和・平成・昭和・R・H・S、元年）、曜日付記（「(月)」「（月曜日）」）の除去、日付の後ろの時刻、に対応。
- 読めないもの: **年のない日付（「4/8」「4月8日」）は、年度を決められないとして読み取りエラー**にする（推測しない）。存在しない日付（2月30日など）、日付ではなく時刻だけのセルもエラー。
- 時刻: `10:00`、`10時30分`、`10時半`、Excelの時刻の小数、に対応。読めない時刻は「注意が必要な行」として返し、予定自体は時刻なしで残す。
- 問題の扱い: 日付が読めない・予定名が空の行は、理由つきで一覧に出す（ファイル全体は失敗させない）。**日付と曜日が合わない行、同じ日付の予定が複数ある日は「警告」**として出す（予定は削除・統合・修正しない。確認は利用者）。
- 年度外の予定は、別の年度へ動かさず「対象年度外のためカレンダーには配置されません」と表示する。年度を変えると、新しい年度の範囲で振り分け直す。
- 同じ日の予定は1件も落とさず、時刻なし→開始時刻順→元の行順に並べる。セルの文字は、XMLに書けない制御文字を除いてから出力（`sanitizeEventText`）。
- 確認・修正の方法: 通常の読み取り結果は、**行ごとに画面で編集する機能はなく**、列の割り当て・シート・見出し行の変更で読み直す作り。個別に直せるのはAIの提案を採用するときだけ（5章）。
- 既知の制限（コードを読んだ範囲）: 期間の指定（「4/8〜4/10」）、1セルに複数の予定を書いた形式の分解、セルの色・書式からの意味の読み取りに対応する処理は、見当たらない（日付セル1つ＝1日として扱う）。実際の利用者のExcelの多様さに、どの程度適合するかは【未確認】（U-16）。

### 4.4 テスト【事実】

`tests/calendar/` に16ファイル（約240件）、`tests/tools/fiscal-calendar*.spec.ts`。祝日の「公式CSVとの突き合わせ」、Excelの厳密な構造検査（全組み合わせ）、取り込みの日付・曜日・重複の警告、などを検証する（実行結果は8章）。

---

## 5. AI機能の現状

### 5.1 範囲と呼び出し経路【事実】

- AIを使う機能は**1つだけ**: 年度カレンダーの予定表取り込みの「AIで読み取る」（`src/components/tools/implementations/shared/fiscal-calendar-ai-assist.tsx`）。ほかのツールにAIの呼び出しはない（`api.openai.com` を参照するのは `src/lib/ai/openai-client.ts` だけ。テストで固定: `tests/ai/static-security.spec.ts`）。
- 流れ: 画面（Premiumかつ課金ON時のみ表示）→ `POST /api/ai/calendar-assist` → `src/lib/ai/service.ts` → OpenAI Responses API → 出力を検証 → 画面に「提案」として表示。
- **AIと通常のロジックの分担**: 通常の読み取り（日付・時刻の解析、曜日の不一致・重複の警告）は、すべて通常のコード（`event-import.ts`）。AIは、通常の読み取りで日付や予定名を認識できなかった行を補助するだけ。曜日の不一致・重複の判定はAIに任せない（`src/lib/ai/calendar-assist.ts` の方針）。
- 失敗してもカレンダー生成は止まらない（通常の読み取り結果はそのまま使える旨を表示）。

### 5.2 モデル・送信内容・上限【事実】

- モデル2種（`src/lib/ai/pricing.ts`）: 「標準」`gpt-6-luna`、「高精度」`gpt-6.1-sol`。画面にはモデル名を出さず役割名で表示。単価はコメントに「2026-10-22時点のOpenAI公式資料に基づく」とあるが、**実際のAPIでの動作・単価との一致は【未確認】**（U-02。実接続テスト `tests/ai/openai-live.spec.ts` は用意済みだが、実行していない）。
- 呼び出しの設定（`openai-client.ts`）: `store: false`（OpenAI側に応答を保存しない設定）、`reasoning.effort: "low"`、構造化出力（JSON Schema・`strict: true`）、タイムアウト100秒（APIの最大実行時間は120秒）。
- 送るもの: 利用者が画面で選んだ**行・列の文字だけ**。ファイルそのものは送らない。1回あたり最大100行・12列、セル200文字、見出し40文字、合計120,000バイトまで。リクエスト本文は400,000バイト以内（`calendar-assist.ts`、`route.ts`）。
- 出力トークン上限: `min(16,000, 2,000 + 行数×150)`。
- AIの出力は信用せず検証する（スキーマ・行番号・日付形式。送っていない行・重複・形式の誤りは捨てる）。年を推測した場合は `inferred=true` で必ず画面に示す。

### 5.3 同意・確認・編集【事実】

- **実行のたびに**、送信内容を画面で確認し、同意のチェック（`data-testid="ai-consent"`）を入れる必要がある。サーバーも、同意（`accepted: true`＋現行の版 `CONSENT_VERSION = "2026-10-22"`）が無ければ処理しない（`service.ts`）。同意は次回に引き継がない。
- AIの結果は「提案」で、利用者が日付・時刻・予定名を直し、チェックを入れた分だけをカレンダーに採用する。日付が読めない・確度が低い行は、高精度モデルでの再確認の対象にできる。採用の取り消しも可能。

### 5.4 キーの保護・利用枠・失敗時【事実】

- APIキー: サーバー専用の環境変数 `OPENAI_API_KEY`。参照するのは `src/lib/ai/server.ts` だけ（`import "server-only"`）で、`NEXT_PUBLIC_` 付きの変数は無く、クライアントコンポーネントがサーバー専用モジュールを読み込まないことを静的テストで固定している。
- 利用条件（`getAiAvailability()`）: 課金フラグがOFFなら `billing_off`、Vercelのプレビュー環境なら `preview`、キーまたはSupabaseのサービスロールが未設定なら `not_configured` で、いずれも利用不可（503）。さらに、ログイン必須（401）・Premium必須（403）。
- 同一オリジンの確認（`Origin` と `Host`）、JSON形式の確認、`Cache-Control: no-store`。
- **利用枠**（`pricing.ts`、`supabase/migrations/0003_ai_usage_ledger.sql`）: 1請求期間あたり内部上限3,000,000µUSD（約3ドル≒500円相当と設計）。画面には金額でなく「AIトークン」（1AIトークン＝0.1µUSD）で表示。流れは「予約→OpenAI呼び出し→実使用量で確定（または解放）」。1回の予約が期間上限の1/4を超える依頼は、AIを呼ぶ前に断る。同時実行3件・毎分10件まで（DB側で判定）。重複依頼ID（409）は拒否。
- **失敗時の扱い**: OpenAIが入力を受け付けなかった（400/401/403/404/422/429）ときだけ予約を解放。タイムアウト・通信断・5xx・不正な応答は、課金されたか不明なので解放も確定もせず、予約は期限切れ（15分）で「使用済み」扱い。処理されたが使用量が読めない場合は予約額で確定（多めに数える）。
- 保存・ログ: リクエスト本文・AIの出力は、DBにもログにも書かない（台帳には依頼ID・使用量・結果コードのみ）。運用ログ（`console.info("[ai]", …)`）にも本文は含めない。AI関連コードにローカル保存・書き込み系の呼び出しが無いことも静的テストで確認している。
- 無料機能との分離: AIの画面（入口）は課金ONかつPremiumのときだけ。AI APIが使えなくても、通常のカレンダー生成・取り込みは影響を受けない。

### 5.5 未確認の点【未確認】

- OpenAI実接続（2モデル）が通るか、実際の使用量・費用が `pricing.ts` の想定と合うか（U-02）。
- OpenAIの予算上限・許可モデル・キーの権限などの外部設定（U-01）。
- 想定した精度・実際の利用者が欲しい補助の内容（利用データなし。U-18）。

---

## 6. 料金・認証・権限管理

### 6.1 料金の定義と表示【事実】

- 定義（唯一の情報源）: `src/lib/plans/types.ts`。**Free 0円／Premium 月額1,100円（税込）**が現行。`PREMIUM_PRICE_YEN = 1100`。
- 旧Standard（550円）は、型・判定・既存契約の表示のために残してあるだけで、料金ページには表示せず新規契約もできない。旧Premium（980円）の契約も、アプリ内ではpremiumとして扱う（`subscription-sync.ts`）。ユーザーの方針は「Standardはユーザー増加・広告導入の時期に使う（今は待機）」。再導入時は、料金表示・Checkoutの価格検証・規約・Webhookの判定の変更が必要。
- 表示場所: `/pricing`、`/tokushoho`、`/terms`、`/privacy`、`/about`、`/account`。課金フラグOFFの間は、料金・特商法ページは「準備中」表示で `noindex`、サイトマップからも除外（`src/app/sitemap.ts`）。

### 6.2 ツールへのアクセス制御【事実】

- サーバー側の判定: ツール詳細ページ（サーバーコンポーネント）が `getServerPlan()` で、ログイン状態・DBの契約状態・署名付き一時利用権から実効プランを決め、`ToolAccessGate` に渡す。非対応のプランには、ツール本体（子要素）を描画しない。
- ただし処理は**すべてブラウザ内**で、ツールのコード自体は誰にも配信されうる（JavaScriptのバンドルを直接取得すれば、ゲートを通さず実行できる）。サーバーで処理を行わない設計上の性質であり、「Premium限定ツール」の保護は画面表示の制御の範囲に限られる【事実】。
- 実効プランの決め方: `active` / `trialing` のときだけ有効。`past_due`・`unpaid`・`canceled`・`incomplete` 等は無料扱い（`src/lib/plans/effective-plan.ts`）。解約手続き中でも期間末までは `active` のまま使える。
- 現状は `ALL_TOOLS_STANDARD = true` のため、**課金をONにしても、現在のコードのままではPremiumの価値は「広告なし」と「AI読み取り補助」だけ**になる（全ツールが無料プランでも広告視聴で使えるため）。これは仕様の設定値であり不具合ではないが、料金ページの「プレミアム対象ツールも利用可能」という表現（`src/app/pricing/page.tsx`）と実態の関係は、方針決定の材料になる【事実】。

### 6.3 Checkout・Webhook・解約【事実】

- Checkout（`src/app/api/stripe/checkout/route.ts`）: 課金フラグOFFなら404／Stripe未設定なら503／ログイン必須（401）／ユーザー単位で毎分5回まで（429）／申込めるのは `premium` のみ／契約が続いている人は409（二重契約の防止）／**決済前にStripe上のPriceを検証**（通貨JPY・月額・1,100円・従量でない・有効。`src/lib/stripe/price-guard*.ts`。食い違えば503で止める）。Stripeに渡す `client_reference_id` と `metadata` にユーザーIDを付ける。プロモーションコードの入力を許可（`allow_promotion_codes: true`）。
- Webhook（`src/app/api/stripe/webhook/route.ts`）: 課金OFFなら何も読まず `{received:true, ignored:true}` を返す／署名ヘッダー無し・署名不正は400（DBに触れない）／Secret未設定は503／イベントIDを先に `stripe_webhook_events` に登録して重複を無視／**処理に失敗したイベントは登録を消し、500を返してStripeに再送させる**。処理するイベント: `customer.subscription.created/updated/deleted`、`checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`。イベント本文でなく、Stripeから最新のSubscriptionを取得して同期し、取得時刻が古い結果では上書きしない（順序逆転の防止）。
- 解約・支払い方法変更: `POST /api/stripe/portal`（課金OFFで404、ログイン必須、毎分5回まで）。`STRIPE_PORTAL_CONFIGURATION_ID`（`bpc_…`）を任意で指定でき、形式が不正なときは他の設定へ黙って切り替えず503で止まる。専用設定を作るスクリプト `scripts/create-portal-config.mjs` は用意済みだが、実行していない（利用者が実行する想定）。
- 契約状態の保存: `subscriptions` に1ユーザー1行（`user_id` が主キー、`stripe_customer_id`・`stripe_subscription_id` は一意）。書き込みはサーバー（サービスロール）のみ。
- 返金・日割りは行わない旨を規約・特商法ページに記載。

### 6.4 現時点で外部の状態として存在するもの【未確認】

- Stripe（本番）の商品・価格・Webhook設定・制限付きキーは、ユーザーが設定済みと報告している。**この調査では確認していない**（U-01）。旧「Ur SECOND」の商品が残っているか、旧Standard商品（550円）の状態、Customer Portalの設定内容も同様。
- Vercelの環境変数（`STRIPE_*`、`OPENAI_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`TEMP_ACCESS_SECRET`、`ADMIN_EMAILS` 等）の有無・値は確認していない。`STRIPE_STANDARD_PRICE_ID` は旧値が残っている可能性がある（ユーザーの申告）。コード上、`STRIPE_STANDARD_PRICE_ID` は旧Standard契約の判定に使われうる。

---

## 7. セキュリティ・データ保護

### 7.1 確認できた保護策【事実】

- **ファイルの外部送信**: ツールの処理はすべてブラウザ内で、`fetch(` の呼び出しは自サイトのAPI・フォント・モデルの取得のみ（`/api/ai/*`、`/api/stripe/*`、`/fonts/*`、`/models/*`）。外部ドメインへの通信が許されるのは、CSPの `connect-src`（自サイト・Supabase・Googleの広告関連ドメイン）の範囲。AIのときだけ、選択した文字がサーバー経由でOpenAIへ送られる（5章）。
- **秘密情報**: 参照している環境変数は `OPENAI_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`TEMP_ACCESS_SECRET`、`ADMIN_EMAILS` などで、いずれも `NEXT_PUBLIC_` ではない。`NEXT_PUBLIC_` が付くのは、サイトURL、SupabaseのURLと公開(anon)キー、広告ID／枠IDのみ（公開前提の値）。`.env.example` は値が空のひな形。秘密情報をログに出す箇所は見つからない（`console.*` は12箇所で、エラー時のStripe/Supabaseのエラーオブジェクト出力と、AIの本文を含まないイベント）。
- **HTTPヘッダー**（`next.config.ts`）: CSP（`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`、`form-action 'self'`、`base-uri 'self'` など）、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`（カメラ・マイク・位置情報などを無効）、HSTS（2年・サブドメイン含む・preloadなし）。
- **XSS**: `dangerouslySetInnerHTML` は構造化データ（JSON-LD）の1箇所のみで、`<` をエスケープしている。`innerHTML` / `eval` の使用なし。
- **認証・権限**: 5.4・2.4・6.2を参照。管理画面は、レイアウトとページの二重チェック。AI・Checkout・Portal・Webhookはそれぞれ、フラグ・認証・署名の検査を持つ。
- **データベース**: すべてのテーブルでRLS有効。`subscriptions` は自分の行の読み取りだけ許可で、書き込みポリシーは作らない。AI台帳の関数は `SECURITY DEFINER` かつ `search_path=''`、サービスロール専用（`0003_ai_usage_ledger.sql`、DBの関数テスト `supabase/tests/ai_usage_ledger_test.sql`、ロールバック用SQLあり）。
- **レート制限**: Checkout・Portalはユーザー単位で毎分5回（メモリ内）。AIはDB側（同時3件・毎分10件）。
- **一時利用権（広告視聴後の1時間）**: HMAC署名付きCookie（期限はサーバー発行。ブラウザの時計は使わない）。有効な利用権があれば新しく発行し直さない。
- **依存関係**: 7.3を参照。

### 7.2 問題の可能性【問題の可能性】

区分A（利用者・課金・データに影響しうるもの）:

- **P-A1 依存パッケージの既知の脆弱性**: `npm audit --omit=dev`（2026-10-22、クラウド側）で本番依存に6件（moderate 3／high 3）。中心は **`next` 16.3.6 が影響範囲（<16.3.8）に入っていること**（修正版は16.3.8以上、`fixAvailable` は16.4.2）。指摘の内容は、`use cache` とDraft Modeのコンテンツ漏えい、SSG/ISRのキャッシュポイズニング（自前ホスティング時）、画像最適化のSSRF（high）、メタデータ画像ルートの情報漏えい、開発サーバーのMCPエンドポイントの情報漏えいなど。ほかに `sharp`（<0.35.5、high。librsvgの脆弱性）、`source-map-js`（<1.2.2、high。DoS）、`mammoth` 経由の `argparse`／`sprintf-js`（moderate。修正は `mammoth` の古い版への戻しで、メジャー変更扱い）。**このアプリで実際に悪用できるか（`use cache`・Draft Mode・`next/image` の外部URL最適化の利用有無、Vercelでの影響）は未評価**。コード上、`use cache`・`draftMode` の使用は0件、`next/image` は3ファイルで使用、`next.config.ts` に `images` 設定（外部URLの許可）は無い。
- **P-A2 二重契約の防止はアトミックでない**: 契約済みかの確認はCheckoutセッションの**作成時**だけ（`checkout/route.ts` の `hasOpenSubscription`）。同じ利用者が2つのタブでCheckoutを開き、両方を完了すると、Stripe側に2つの契約ができうる。DBは1ユーザー1行（`subscriptions.user_id` が主キー）のため、片方の `stripe_subscription_id` が上書きされ、もう片方はStripeにだけ残りうる。実際に発生するか、Stripe側の設定（顧客あたりの契約数の制限など）で防がれるかは未検証。
- **P-A3 レート制限が単一インスタンスのメモリ**: `src/lib/utils/rate-limit.ts`。Vercelのサーバーレスは複数インスタンス・再起動があるため、制限が効かない場合がある（コードにも既知の限界として明記）。対象はCheckout・Portalのみ。
- **P-A4 広告視聴の検証ができない（広告ON後に影響）**: Webのリワード広告は、サーバー側で視聴を検証できないため、Server Actionを直接呼べば広告を見ずに1時間の利用権を得られる（`temporary-access-actions.ts` の注記）。さらに、広告が配信されなかった場合の代替付与は**回数制限なし**（`fallback-grant-policy.ts` の `cooldownMs: null`）で、広告ブロッカー利用者は毎回通れる。広告フラグがOFFの現在は影響なし。
- **P-A5 特定商取引法の表記が「請求があれば開示」方式**: `src/app/tokushoho/page.tsx` は、販売事業者・運営統括責任者・所在地・電話番号を公開せず、請求があった場合に遅滞なく開示する旨を記載（運営者の判断とコメントにある）。この方式が要件を満たすかは、法的な確認が必要（私は法的な判断をしない）。課金ON前の確認事項。
- **P-A6 プライバシーポリシー・規約に、情報の開示・削除（退会）の手続きの記載が見当たらない**: `src/app/privacy/page.tsx`・`terms/page.tsx` に「削除」「開示」「退会」の語が無い（検索結果0件）。アプリ内にもアカウント削除の機能が無い（2.4）。会員データ（メール・契約情報）が増える課金ON以降の論点。法的な要否は未確認。
- **P-A7 CSPに `'unsafe-inline'` を含む**: `next.config.ts` に、ナンス方式を採らない理由（静的生成・テーマ切替・フレームワークの制約）が詳しく書かれている。XSS対策としてのCSPの効果は限定的になる。意図的な設計判断として記録されている。
- **P-A8 外部サービスの停止・規約上の制約**: Vercel Hobbyは非営利・個人利用が条件、Supabase Freeは7日間利用が少ないと自動停止する（公式の記載。ユーザーが維持する方針を決定済みのため、事実のみ記録）。課金ON（営利利用）との関係は、方針決定の材料。
- **P-A9 監視・障害通知の仕組みがコード上に無い**: エラー追跡（Sentry等）、アクセス解析、稼働監視の依存・スクリプトが無い（検索結果0件）。Vercel側の設定は【未確認】（U-13）。祝日更新のみ、失敗時にGitHubのIssueで通知する。
- **P-A10 祝日更新が `main` へ直接push→本番に自動反映**: テスト通過が条件だが、人のレビューを挟まない。`main` のブランチ保護との関係は【未確認】（U-12）。

区分B（整理・表示・文書の不整合など軽微なもの）:

- **P-B1 READMEが古い**: `README.md` は「Phase 1」の記述で、「決済・アカウント機能は導入していません」「依存はqrcodeのみ」とあり、現状（Stripe・Supabase・AI・106ツール）と合っていない。
- **P-B2 コード内の数値コメントが古い**: `next.config.ts`（「46以上のツールページを静的生成」→現状は動的）、`tool-registry.tsx`（「全46ツール」→106）、`src/lib/admin/data.ts`（「他の98ツール」→現状は106ツール）。
- **P-B3 管理画面の「ツール利用状況」は実態を表さない**: `/admin/usage` は旧テーブル `tool_usage_daily`（現在書き込みなし）を読むため、サイト全体の利用回数は分からない（画面にもその旨の注記あり）。つまり、**どのツールがどれだけ使われているかを知る手段がコード上に無い**（アクセス解析なし）。
- **P-B4 ESLintの警告59件**: エラー0。警告のうち57件は、配布物 `public/ort/ort-wasm-simd-threaded.mjs`（`eslint.config.mjs` の除外対象に入っていない）で、自前コードの警告は2件（`no-unused-vars`）。
- **P-B5 未使用・旧設計の名残**: 3.4を参照（`NotImplementedServerProcessor` 等）。`STRIPE_STANDARD_PRICE_ID`・`PLAN_DEFINITIONS.standard`・980円の旧価格IDは、意図的に残したもの。
- **P-B6 サイトURLの既定値が環境で異なる**: `siteConfig.url` の未設定時の値は `https://example.vercel.app`、Playwright設定の既定は `https://mrmatto.vercel.app`、本番は `https://mrsatto.com`。`NEXT_PUBLIC_SITE_URL` が本番で設定されていれば問題ないが、未設定だとcanonical・OGP・サイトマップが誤ったドメインになる（設定の有無は【未確認】）。
- **P-B7 共通文言と課金ON時のAIの関係**: フッターの「ファイルはブラウザ上で処理され、サーバーに保存されません」（`footer.tsx`）は、課金ON時のAI補助（選択した文字をサーバー経由でOpenAIへ送る）の例外に触れていない。プライバシーポリシー側には詳しい説明がある（課金ON時のみ表示）。
- **P-B8 大きなファイル**: `src/lib/seo/tool-content.ts`（約2,340行）、`pdf-fill-annotate-tool.tsx`（約1,900行）、`ooxml-page-settings.ts`（約1,650行）、`excel-to-pdf.ts`（約1,600行）など。保守のしやすさへの影響は未評価。
- **P-B9 コード中の `Phase N` の記述が約300箇所**: 過去のフェーズ名をコメントに多数残している。現状との整合を読み手が判断する必要がある。
- **P-B10 法的ページのテスト3件が、現行の料金体系に追随していない**: `tests/legal/legal-pages.spec.ts` は旧Standard（550円）の記載を期待して失敗する（アプリの表示は現行仕様のPremium 1,100円のみ。8.2）。つまりHEAD時点で、既定のテスト実行は**失敗を含む**。
- **P-B11 `pptx-invert`（PowerPoint白黒反転）が、どのツールの「関連ツール」にも選ばれない**: `tests/seo/phase21-seo-audit.spec.ts` の孤立チェックが失敗する（8.2）。内部リンクの観点で孤立している。選定ロジックは `src/lib/tools/related-tools.ts`。
- **P-B12 通常のテスト実行では、本番相当（課金OFF）の回帰テストとPremium限定のUXテストが実行されない**: 前者は `npm run test:features-off` で別に実行する必要があり（18件、今回実行して成功）、後者は `ALL_TOOLS_STANDARD = true` のためスキップされる（4件。8.4）。

### 7.3 依存関係の補足【事実】

- `npm audit` はクラウド側で実行（レジストリへの読み取り問い合わせ。パッケージ一覧を送信）。結果は上記P-A1。**Macのローカルでは未実行**。`package-lock.json` は存在する。

---

## 8. 品質・テスト・保守性

「テストが存在する」ことと「テストが通った」ことは別なので、分けて書く。

### 8.1 今回実行した検証の結果【事実】

実行場所: クラウド側の複製（Macとファイル内容が一致。1章参照）。実行日: 2026-10-22。環境変数なし（Stripe／Supabase／OpenAIのキーは未設定）、ブラウザはChromium。

| 検証 | 結果 |
|---|---|
| 型チェック（`tsc --noEmit`） | 成功（エラー0） |
| ESLint（`eslint`） | エラー0、警告59（うち57件は配布物 `public/ort/ort-wasm-simd-threaded.mjs`。自前コードの警告は2件の未使用変数） |
| 本番ビルド（`next build`、Turbopack） | 成功 |
| 全自動テスト（`playwright test`、既定の設定） | 1,768件中 **成功1,720／失敗6／不安定9／スキップ33**（所要約1.3時間） |
| 課金OFFの回帰テスト（`NEXT_PUBLIC_FEATURES_OFF=1`、`tests/regression/features-off.spec.ts`） | 18件すべて成功（既定の実行ではスキップされるため、別に実行） |
| 依存の脆弱性（`npm audit --omit=dev`） | 6件（moderate 3／high 3）。7.2のP-A1 |

「不安定」とは、1回目に失敗し、自動の再実行（`retries: 1`）で成功したもの。

### 8.2 失敗した6件の内訳【事実】

確実に再現する4件:

| テスト | 失敗の中身 | 評価 |
|---|---|---|
| `tests/legal/legal-pages.spec.ts` の3件（特商法ページ／利用規約／料金ページ） | 「月額550円（税込）」の記載を期待しているが、現行の画面はPremium（1,100円）のみを表示する（コミット `7b36bce` の料金体系の統一）。テストが `PLAN_DEFINITIONS.standard.priceYen` を使っているため | **テストが現行仕様に追随していない**（アプリの表示は現行仕様どおり） |
| `tests/seo/phase21-seo-audit.spec.ts`（関連ツールの孤立チェック） | 「既知の1件（`pomodoro-timer`）以外に、他ツールの関連ツールに選ばれないツールが無い」という検査が、`pptx-invert`（PowerPoint白黒反転）で失敗 | **アプリ側の状態**: 新しい `pptx` カテゴリのツールが、どのツールの「関連ツール」にも出てこない（内部リンクの孤立）。`src/lib/tools/related-tools.ts` の選び方に起因 |

再現が不安定な2件（高負荷・初回のコンパイル待ちで時間切れになった可能性が高い）:

| テスト | 結果 |
|---|---|
| `tests/tools/new-tools.spec.ts`（背景透過「色指定」） | 全体実行で失敗。単独実行で1回失敗（`bg-preview` が20秒以内に表示されない）、再実行で成功。同ファイルの「AI: モデルが動いて…」は全体実行で不安定（再実行で成功） |
| `tests/tools/pdf-fill-annotate.spec.ts`（表示倍率を変えても同じ相対位置に書き出せる） | 全体実行で60秒の時間切れ。単独実行では成功 |

### 8.3 不安定だったテスト9件【事実】

再実行で成功した。`filled-pdf-to-excel` のテンプレート系3件、`pdf-to-excel` の基本変換、`print-documents` の封筒PDF、`ticket-voucher-options` の連番、`word-to-pdf-phase18-2` の複数セクション、`work.spec.ts` の記入済みPDF→Excel（スモーク）、`new-tools.spec.ts` の背景透過（AI）。いずれも「要素が一定時間内に表示されない」「60秒の時間切れ」で、並列実行時の負荷や開発サーバーの初回コンパイルが原因の可能性がある（原因の特定まではしていない）。OCR・PDF・Excel生成など重い処理系に偏っている。

### 8.4 スキップされた33件【事実】

| 件数 | テスト | 理由 |
|---|---|---|
| 18 | `tests/regression/features-off.spec.ts` | 課金OFF時の確認用で、`NEXT_PUBLIC_FEATURES_OFF=1` が無い通常の実行ではスキップされる（別に実行して18件成功） |
| 4 | `tests/regression/phase20-monetization-ux.spec.ts` | 「Premium限定のツールが無い」ためスキップ（`ALL_TOOLS_STANDARD = true` の影響）。**Premium限定ツールの案内画面などのUXは、現在のコードでは検証されていない** |
| 3 | `tests/ai/openai-live.spec.ts` | OpenAIへの実接続テスト。キーと `RUN_OPENAI_LIVE=1` が無いため（設計どおり） |
| 3 | `tests/tools/audio.spec.ts` | このブラウザがFLAC書き出し（1件）、AACの読み取り（2件）に対応していないため |
| 2 | `tests/tools/tools-explorer.spec.ts` | 「準備中のツールが無い」ため |
| 1 | `tests/auth/signup-consent.spec.ts` | Supabase未設定の環境のため会員登録フォームが無い |
| 1 | `tests/calendar/holidays-oracle.spec.ts` | 公式CSV本体（`tests/fixtures/static/syukujitsu.csv`）が未配置のため、「CSV本体と全行一致」の検査だけをスキップ（控えのJSON・デコード済みCSVとの検査は実行） |
| 1 | `tests/tools/video.spec.ts` | このブラウザはH.264を再生できない |

LibreOffice（`soffice`）が必要な印刷結果の検証は、この環境に存在していたため実行された（スキップ一覧に含まれない）。PostgreSQLを使うAI台帳のSQLテスト（`tests/ai/ledger-sql.spec.ts`）も、スキップされず成功した。

### 8.5 テストの構成【事実】

- 105ファイル、`test(` の記述1,095か所（繰り返し・組み合わせにより、実行時は1,768件）。すべて Playwright（Chromium）で、`next dev` に対して実行する。`globalSetup` が、PDF・Excel・Word・画像などの合成フィクスチャを生成する（実データ・個人情報なし）。
- ディレクトリ別（`test(` の記述数）: `tools` 513、`calendar` 241、`ai` 96、`regression` 63、`pptx` 46、`stripe` 34、`sequence` 30、`registry` 24、`seo` 18、`admin` 16、`legal` 8、`smoke` 4、`auth` 2。
- 純粋な関数のテストも Playwright で実行している（Jest等は使わない方針）。
- 外部サービスに触れないテストが原則。Stripeの署名検証、料金の検査、AI台帳のSQL、秘密情報の露出の静的検査などは、外部通信なしで検証している。
- Mac上の `test-results/.last-run.json` には「失敗」の記録が残っている（2026-10-02の古い実行結果。今回の結果ではない）。

### 8.6 検証されていない領域【未確認】

- Stripe・Supabase・OpenAI・Vercelへの実接続（実決済、Webhook到達、実AI呼び出し、本番DBの権限）。
- 本番ビルドの挙動（Playwrightは `next dev` が対象。環境変数ありの本番相当の描画方式）。
- 実機のスマートフォン、本格的なアクセシビリティ監査、負荷、低スペック端末（9.5、U-17、U-19）。
- Premium限定ツールのUX（8.4のとおり、現在は検証が休止状態）。

### 8.7 保守性【事実】

- TypeScriptは `strict`。`any` の使用は3か所、`@ts-ignore` 系は0、`eslint-disable` は89か所、`TODO/FIXME` は2か所。
- 共通化: 画像変換（7ツール）と書類作成（見積書・請求書・注文書）が共通実装。計算・解析の純粋な処理は `src/lib/` に、画面は `src/components/` に分かれている。
- 回帰リスクが高い箇所: 機能フラグを参照するファイル約30個（`featureFlags`）、`ALL_TOOLS_STANDARD` の切り替え、開発専用Cookieの経路（本番ビルドでは見ない）、似た機能の複数実装（9.5）。
- 変更時の安全網: 型チェック・Lint・ビルドはVercelのビルドでも一部走る（型チェックは `next build` に含まれる）が、**通常のpush／PRで自動テストが走る仕組みはない**（2.7）。祝日更新のワークフローだけがテストを走らせる。
- 文書・コメントの鮮度: READMEと一部コメントが古い（P-B1、P-B2）。コメントには過去の経緯が詳しく残っているので、判断の理由は追いやすい一方、現状との差を読み手が見分ける必要がある（P-B9）。

---

## 9. 利用者体験

利用者データ（アクセス解析・問い合わせ・アンケート）はコード上に存在しないため、「どれだけ使われているか／何が分かりにくいと感じられているか」は**断定しない**。以下は、コードと画面の構造から確認できる範囲の記述。

### 9.1 見つけやすさ【事実】

- ヘッダーに常設の検索欄（`src/components/tools/search-bar.tsx`）。ツール名・説明・カテゴリ名・キーワードを対象に、空白区切りの複数語のAND検索（例「画像 圧縮」。完全一致＞前方一致＞部分一致の順に並べる。`src/lib/tools/search.ts`）。ひらがな・カタカナ・英語の表記ゆれ用に、全ツールが `keywords` を持つ。
- `/tools` に一覧と絞り込み（`tools-explorer.tsx`）、カテゴリ別ページ10種、トップの「おすすめ」10ツール。関連ツールの導線あり（`related-tools.ts`）。
- 106ツールが10カテゴリにある。分類の不揃い（`excel-label` が Word カテゴリ、など）は3.4のとおり。

### 9.2 入力から出力までの流れ【事実】

- 共通部品（`src/components/common/`）: ファイルのドロップ領域、ファイル一覧、処理状態（`ProcessingStatus`）、エラー表示（`ErrorMessage`）、ダウンロードボタン、プレビューと設定を並べるレイアウト（`PreviewSplitLayout`）。
- ツール詳細ページには、使い方（`tool-how-to.tsx`）、よくある質問（`tool-faq.tsx`）、関連ツールがある。ページごとの説明文は `src/lib/seo/tool-content.ts`（約2,340行）に集約。
- 年度カレンダーは、設定→プレビュー（月ごと）→Excel／PDFのダウンロード、の流れ。予定表の取り込みは、ファイル選択→列の自動判定→結果の件数・問題行・警告の表示。
- 進捗表示: `ProcessingStatus`（idle／processing／success／error）。長時間かかる処理（動画、OCR）での詳細な進捗表示の有無は、ツールごとの確認が必要【未確認】。

### 9.3 無料と有料の見え方【事実】

- 現在（課金OFF・広告OFF）は、利用者から見て有料／無料の区別が出る場所はない（ログイン導線・料金ページを出さない。`src/components/layout/header.tsx` 等）。
- 課金ON時: 料金ページ（Free／Premium）、アカウント画面、Premium限定ツールの案内（ただし6.2のとおり、現状は全ツールが「通常」扱いのため、Premium限定の案内画面は出ない）。
- 料金ページの無料プランの説明は、広告ゲートが有効かどうかで書き分ける（`src/app/pricing/page.tsx`。広告が有効でない間は「広告を見なくても通常ツールを利用できます」）。

### 9.4 AI機能の分かりやすさ【事実】

- AIは年度カレンダーの取り込み画面の中だけ（課金ONかつPremium）。送信内容の確認、同意のチェック、モデル選択（標準／高精度）、利用枠の残量（AIトークン）、提案の編集・採用、という手順を踏む。AIの失敗時は、通常の結果がそのまま使えることを案内する。
- ほかのツールからAIの存在に気づく導線は、コード上に見当たらない（年度カレンダーを使う利用者にだけ届く）。

### 9.5 スマートフォン・アクセシビリティ・SEO【事実／一部未確認】

- スマートフォン: レイアウトはTailwindのレスポンシブ指定（`sm:` 等）で組まれている。自動テストは代表5ページ（`/`、`/tools`、`/tools/image`、`/tools/pdf-merge`、`/pricing`）をPixel 7相当で開き、横スクロールが出ないことだけを確認する（`tests/smoke/mobile.spec.ts`）。**実機での操作性は【未確認】**（U-19）。
- アクセシビリティ: `<html lang="ja">`、`aria-label` 約140箇所、`role="alert"`／`role="status"` などを使用。自動テストは「ボタンに名前がある」「入力欄にラベルがある」「Tabキーで移動できる」の最小限のチェック（`tests/helpers/a11y.ts`。axe-core等の本格監査ではない、とファイル冒頭に明記）。画像の代替テキストの網羅は未検証【未確認】（U-19）。
- SEO: ページごとのtitle／canonical／OGP（ツールごと・カテゴリごとの画像を動的生成）、構造化データ（JSON-LD）、`sitemap.xml`（ツール106＋カテゴリ10＋固定ページ）、`robots.txt`（`/account`・`/api` を拒否。`/admin` は拒否リストになく、管理画面側で `noindex` を設定）。検索エンジンでの実際の掲載・順位は【未確認】（U-20）。
- 似た機能が複数ある例【事実】: 画像変換（JPG／PNG／WebP変換と一括変換）、書類作成（見積書／請求書／注文書／見積・注文一体）、PDF→Excel と 記入済みPDF→Excel、CSV文字列置換 と Excel文字削除・置換、CSV→Excel と Excel→CSV。分かりにくいかどうかは、利用データがないため判断できない。
- 分かりにくい可能性がある点【問題の可能性／軽微】: 同じ「年度カレンダー」の説明に、課金ON時はAIの利用枠、課金OFF時は通常機能のみ、と画面が切り替わる（フラグ依存の表示が多く、`featureFlags` を参照するファイルが約30個ある）。

---

## 10. 運営・収益化

### 10.1 広告【事実】

- 通常広告（AdSense）とリワード広告（Google Ad Manager）の「土台」が実装済み: `src/components/ads/`、`src/lib/ads/`、`public/ads.txt`。広告フラグOFFの間は、スクリプトの読み込みも、ダウンロード時の広告確認もしない。
- 広告IDなどの環境変数（`NEXT_PUBLIC_ADSENSE_*`、`NEXT_PUBLIC_GAM_REWARDED_AD_UNIT_PATH`）が設定されて初めて広告が出る設計。Vercelに設定があるかは【未確認】。AdSense／GAMの審査状況も【未確認】（U-07）。
- 無料利用者の想定（`src/lib/plans/types.ts`）: ダウンロード時に広告を見ると1時間、広告なしで使える。広告ブロック等で広告が出ない場合は代替付与（回数制限なし）。

### 10.2 課金【事実】

- 有料プランは Premium 月額1,100円（税込）の1種類。解約は期間末まで有効、返金・日割りなし（規約・特商法に記載）。
- AI利用の費用管理: 1請求期間あたり、内部の上限3,000,000µUSD（設計上は約500円相当）。この約500円相当は、月額1,100円（税込）の半分未満という設計値（実際の費用・収益は推測しない）。為替の想定は165円／ドル（`JPY_PER_USD`、四半期ごとに見直す旨のコメント）。ほかに、OpenAI側に月間予算（ユーザー申告で$20）を設定済みとのこと【未確認】。
- 決済手数料・Stripeの料金・返金時の手数料の扱いはコード外。収益・費用・利用者数・稼働率は**推測しない**（データなし）。

### 10.3 規約・問い合わせ・法務表記【事実】

- ページ: 利用規約（約290行）、プライバシーポリシー（約220行）、特定商取引法に基づく表記（約140行）、ライセンス表記（`/licenses`）。最終更新はいずれも2026年10月。特商法ページは課金ONのときだけ公開。
- 問い合わせ: Googleフォーム（回答はGoogle側で管理）とメール `contact@mrsatto.com`。メールの受信設定は【未確認】（U-08）。
- 内容の法的な妥当性（特商法の開示方式、個人情報の取り扱い、国外のAI事業者への送信の記載など）は、私は判断していない。確認が必要【未確認】（U-06）。

### 10.4 障害対応・スケール・外部依存【事実／未確認】

- 障害時の手順書、ステータスページ、アラートは、リポジトリ内に無い。祝日データの更新失敗のみ、GitHubのIssueで知らせる仕組みがある。
- ツールの重い処理は各利用者のブラウザで動くため、サーバー負荷は小さい設計。一方で、ツール詳細ページは動的描画（リクエストごとにサーバー処理）、AI・決済・Webhookはサーバー処理。同時アクセスが増えたときの挙動、Vercel Hobbyの関数実行時間・回数の制限、Supabase Freeの接続数・停止条件は、実測も確認もしていない【未確認】。
- 外部依存: Vercel、GitHub、Supabase、Stripe、OpenAI、Google（AdSense／GAM／Forms）、内閣府（祝日CSV。更新時のみ）、npmレジストリ（ビルド時）。ブラウザ内で完結するツールは、サイト自体が配信されている限り使える設計。Supabaseが未設定のときは、認証なし（無料扱い）で動く（`getSupabaseServerClient()` が `null` を返す）。ただし、Supabaseが設定済みで一時的に停止している場合の画面の挙動は、検証していない【未確認】。
- ユーザーの方針（記録）: VercelはHobby、SupabaseはFreeを維持する。公式記載として、Vercel Hobbyは非営利・個人利用が条件、Supabase Freeは7日間利用が少ないと自動停止する、とされる。この方針の変更は、ここでは提案していない。

---

## 11. 確認された問題と根拠（一覧）

詳細は7.2。区分Aと区分Bを分けて並べる。重大度の順ではない。実害が出ているとは限らない（多くは「そうなりうる」という指摘）。

### 区分A（利用者・課金・データに影響しうるもの）

| ID | 概要 | 根拠 |
|---|---|---|
| P-A1 | `next` 16.3.6 ほか本番依存6件に既知の脆弱性報告（実影響は未評価） | `npm audit --omit=dev`（2026-10-22）、`package.json` |
| P-A2 | 二重契約の防止がCheckout作成時のチェックのみで、アトミックでない | `src/app/api/stripe/checkout/route.ts`、`supabase/migrations/0001_billing_schema.sql` |
| P-A3 | Checkout／Portalのレート制限が単一インスタンスのメモリ | `src/lib/utils/rate-limit.ts` |
| P-A4 | 広告視聴を検証できない・代替付与に回数制限なし（広告ON後に影響） | `src/lib/plans/temporary-access-actions.ts`、`fallback-grant-policy.ts` |
| P-A5 | 特商法の表記が「請求があれば開示」方式（法的確認が必要） | `src/app/tokushoho/page.tsx` |
| P-A6 | 規約・PPに開示・削除・退会の手続きの記載が見当たらず、退会機能もない | `src/app/privacy/page.tsx`、`terms/page.tsx`、`src/app/account/page.tsx` |
| P-A7 | CSPに `'unsafe-inline'`（意図的な設計判断として記録あり） | `next.config.ts` |
| P-A8 | Vercel Hobby／Supabase Freeの規約・停止条件（維持方針は決定済み。事実のみ） | 各社の公式記載（ユーザー提示・確認済み） |
| P-A9 | エラー監視・アクセス解析・稼働監視がコード上に無い | `package.json`、`src`（検索結果0件） |
| P-A10 | 祝日更新が `main` へ直接push→本番に自動反映（人のレビューなし） | `.github/workflows/sync-holidays.yml` |

### 区分B（整理・表示・文書の不整合など軽微なもの）

| ID | 概要 | 根拠 |
|---|---|---|
| P-B1 | READMEが古い（Phase 1・「決済は導入していません」） | `README.md` |
| P-B2 | コメント中のツール数・描画方式が古い | `next.config.ts`、`tool-registry.tsx`、`src/lib/admin/data.ts` |
| P-B3 | 管理画面の利用状況が旧テーブルのみで、実態を表さない（利用の計測手段なし） | `src/lib/admin/data.ts`、`src/app/admin/usage/page.tsx` |
| P-B4 | ESLint警告59件（57件は配布物 `public/ort/*.mjs`） | `eslint.config.mjs`、Lint実行結果 |
| P-B5 | 未使用・旧設計の名残（`NotImplementedServerProcessor` 等） | `src/lib/processors/server/index.ts` |
| P-B6 | サイトURLの既定値が環境ごとに異なる（本番での設定の有無は未確認） | `src/lib/config/site.ts`、`playwright.config.ts` |
| P-B7 | フッター等の共通文言がAI補助の例外に触れていない | `src/components/layout/footer.tsx` |
| P-B8 | 大きなファイルがある | 7.2参照 |
| P-B9 | `Phase N` の記述がコメントに約300箇所 | `src` 全体 |
| P-B10 | 法的ページのテスト3件が旧Standard（550円）を期待して失敗（HEADの既定テスト実行は失敗を含む） | `tests/legal/legal-pages.spec.ts`、テスト実行結果（8.2） |
| P-B11 | `pptx-invert` がどのツールの関連ツールにも選ばれない（内部リンクの孤立） | `tests/seo/phase21-seo-audit.spec.ts`、`src/lib/tools/related-tools.ts` |
| P-B12 | 既定のテスト実行では、課金OFFの回帰（別コマンド）とPremium限定UX（スキップ）が実行されない | `tests/regression/features-off.spec.ts`、`phase20-monetization-ux.spec.ts` |

---

## 12. 未確認事項

外部サービスの状態や、実データが必要なため、この調査では確かめられていないこと。

| ID | 内容 | 確認が必要な理由・備考 |
|---|---|---|
| U-01 | Stripe／Vercel／OpenAI／Supabaseの外部設定の実状（商品・価格・Webhook・キーの権限・環境変数・予算上限・許可モデル） | 管理画面は操作していない。ユーザーの申告のみ |
| U-02 | OpenAIの実接続（2モデルで成功するか、単価・使用量が想定と合うか） | 実接続テスト（`tests/ai/openai-live.spec.ts`）は用意済みで未実行 |
| U-03 | Supabase本番で、`anon`／`authenticated` がAI台帳の関数・表を使えないこと | 確認用の読み取りSQLをユーザーに渡したが、結果は未報告 |
| U-04 | 実購入→Webhook→契約反映→AI利用→Portalで解約、の通し確認 | 課金ON後にユーザー本人が実施する想定。実決済は私が行わない |
| U-05 | 旧Ur SECONDの商品の残存、旧Standard商品、Customer Portal設定の状態 | Stripe管理画面の確認が必要 |
| U-06 | 利用規約・プライバシーポリシー・特商法の法的な確認 | 法務の判断が必要 |
| U-07 | AdSense／Google Ad Managerの審査・設定状況 | 外部 |
| U-08 | ドメイン・メール（`contact@mrsatto.com`）の受信設定 | 外部 |
| U-09 | GitHub上の最新（`git fetch` 未実施）との一致 | 読み取り専用のため実施せず |
| U-10 | Vercel Hobby（商用利用になった場合の扱い）、Supabase Freeの制約の適用 | 公式の記載の解釈はユーザーの方針判断 |
| U-11 | 実際のアクセス数・ツール別利用・離脱・収益・費用・稼働率 | 計測手段が無く、データがない |
| U-12 | GitHub Actionsの実行履歴（成功しているか）、`main` のブランチ保護、Secrets／Variables | 外部 |
| U-13 | Vercelの監視・ログ・アラートの設定 | 外部 |
| U-14 | Vercel本番の実際のデプロイ状態、各ルートの描画方式、環境変数（`NEXT_PUBLIC_SITE_URL` 等）の有無 | 外部。クラウドのビルドは環境変数なしで実行 |
| U-15 | P-A1の脆弱性が、このアプリ・Vercel環境で実際に悪用可能か | 各アドバイザリの条件の精査が必要 |
| U-16 | 実際の利用者のExcel予定表（形式の多様さ）への適合度 | 実データなし |
| U-17 | 大容量ファイル・低スペック端末・ブラウザ差（H.264／AAC／FLAC等）での動作 | 実機確認が必要 |
| U-18 | AI読み取りの実際の精度と、利用者の需要 | 実データなし |
| U-19 | 実機のスマートフォン操作性、アクセシビリティの本格監査（画像の代替テキスト等） | 自動テストは最小限 |
| U-20 | 検索エンジンでの掲載状況、Core Web Vitals | 外部・実測が必要 |

---

## 13. 改善候補

**決定事項ではない。順不同で、優先順位・実施順序・工程は付けていない**（それらはChatGPT側で判断する前提）。各候補は、上の問題・未確認事項に対応する。

| ID | 候補 | 関連 |
|---|---|---|
| C-01 | `next` を修正版（16.3.8以上）へ、`sharp`・`source-map-js` を更新する | P-A1, U-15 |
| C-02 | `ALL_TOOLS_STANDARD`（Premiumの価値の設計）に関する方針を決め、設定・料金ページの文言をそれに合わせる | 6.2 |
| C-03 | 二重契約をアトミックに防ぐ（Stripe側の設定、またはDB側の制約・確認） | P-A2 |
| C-04 | レート制限を共有ストアで行う、または制限の目的を再整理する | P-A3 |
| C-05 | push／PR時に型チェック・Lint・テストを自動実行するCIを置く | 2.7 |
| C-06 | READMEとコード内コメントの数値・描画方式を現状に合わせる | P-B1, P-B2 |
| C-07 | 退会（アカウント削除）と、開示・削除の請求手続きの整備、規約・PPへの記載 | P-A6 |
| C-08 | 利用状況の計測（個人情報に配慮した範囲）と管理画面の見直し | P-B3, U-11 |
| C-09 | エラー監視・稼働監視・障害時の連絡手順を決める | P-A9, U-13 |
| C-10 | 年度カレンダーの取り込みの拡張（CSV、.xls、期間予定、年のない日付の扱い、行単位の編集） | 4.3 |
| C-11 | ESLintの除外設定に配布物（`public/ort/**`）を加える | P-B4 |
| C-12 | 未使用コード（`NotImplementedServerProcessor` 等）や古いフェーズ表記の整理 | P-B5, P-B9 |
| C-13 | カテゴリ・IDの不揃いの整理（URLが変わる場合はリダイレクトが必要） | 3.4 |
| C-14 | 会員登録時の同意をサーバー側に記録する | 2.4 |
| C-15 | 祝日自動更新に、人の確認を挟む運用や通知の強化を検討する | P-A10, U-12 |
| C-16 | 実機のスマートフォン確認とアクセシビリティの本格監査 | U-19 |
| C-17 | 大容量ファイル処理時の事前警告・進捗表示の統一 | 3.4, U-17 |
| C-18 | サイトURLの既定値（未設定時）を本番のドメインに揃える、または未設定を検知して止める | P-B6 |
| C-19 | 法的ページのテストを現行の料金体系（Free／Premium）に合わせて更新する | P-B10 |
| C-20 | 関連ツールの選定に `pptx-invert` を含める（またはテストの想定を更新する） | P-B11 |
| C-21 | 課金OFFの回帰テストを既定のテスト実行に含める手順にする／Premium限定UXテストの扱いを方針に合わせて決める | P-B12 |
| C-22 | 不安定なテスト（重い処理系）の待ち時間や並列度を見直す | 8.3 |

---

## 14. ChatGPTが判断するために必要な情報

### 14.1 ユーザーが決めている制約（変更しない前提）

- VercelはHobby、SupabaseはFreeを維持する。有料プランへの変更は、ユーザーが判断する。
- 課金（`billing`）と広告（`ads`）のフラグはOFFのまま。ONにするには、`src/lib/config/features.ts` を `true` にしてpush（=本番デプロイ）するだけだが、**公開前に限定して試す方法はない**（プレビュー環境にも同じ値が使われる）。ONにする判断はユーザーが明示的に行う。
- 旧Standard（550円）の商品は作成済みで待機。ユーザーが増え、広告を付けるタイミングで使う予定。
- Stripe／OpenAI／Supabase／Vercelの管理操作（管理画面・API・CLI・本番DB・キー・課金設定・環境変数・デプロイ設定・実決済・実AI呼び出し）は、Claudeには許可されていない。これらは、ユーザーが自分で行う。
- コミット・プッシュ・デプロイは、ユーザーの明示的な許可があるときだけ。pushは、そのまま本番デプロイを意味する。
- 返答・報告書は日本語。コードやコマンドはコピーできる形で渡す。コード変更時は、配布前にPlaywrightの回帰テストを走らせる。

### 14.2 現在の本番相当の挙動（コード上）

- ログイン・会員登録・料金・特商法の導線は出ない。全106ツールが無料・広告なし・会員登録不要。
- Stripeの3つのAPIとAI APIは利用不可（Webhookは受信しても何もしない）。
- 課金をONにすると、Premium（1,100円）の価値は「広告なし」と「年度カレンダーのAI読み取り補助」になる（`ALL_TOOLS_STANDARD = true` のため、全ツールがFreeでも使える）。

### 14.3 方針の判断に使える、現状の事実

- 製品の幅: 106ツールを持ち、そのうち年度カレンダー（取り込み＋AI）だけが「サーバー連携」を持つ。残りは、ブラウザ内完結で運営コストが小さい作り。
- 収益化の仕掛けは、実装済みで、スイッチOFF（広告の土台・Stripe課金・AI利用枠）。それぞれ、外部の審査・設定・実接続の確認が残っている（U-01〜U-08）。
- 計測手段がなく、**需要・利用状況の根拠となるデータがない**（P-B3, U-11）。ツールの取捨選択や、AIの価値判断は、現状のデータでは裏付けられない。
- テスト基盤は厚い（1,768件。8章）。今回の実行では、型チェック・Lint・ビルドは成功、テストは成功1,720／失敗6（確実な再現は4件で、法的ページのテスト3件は古い期待値、1件はPowerPoint白黒反転の関連づけ）／不安定9／スキップ33。課金OFF（本番相当）の回帰18件は成功。CIが無いため、テストの実行は人（またはClaude）が手元で行う前提。
- 品質面の既知の気になる点は、区分Aの10件と区分Bの12件。外部依存の脆弱性（P-A1）は最新の指摘であり、対応の要否は未評価。

### 14.4 ChatGPT側で決める論点（順序は付けない）

- Premiumの価値設計（全ツール開放のままか、一部をPremium限定に戻すか、AI機能をどこまで広げるか）。
- 課金をONにする条件（外部確認U-01〜U-06の完了基準、法務の確認範囲）。
- 広告の導入時期と、Standardの再導入の関係。
- 運営体制（問い合わせ対応、障害時の連絡、監視）。
- 無料インフラ（Hobby／Free）で運営を続ける範囲と、見直しの判断基準。
- 品質の基準（CI、脆弱性対応の頻度、テストの実行方法）。
- ツールの整理（似た機能の統合、カテゴリ／IDの整理）。

### 14.5 作業分担についての前提

- Claudeができること: コードの読み取り・変更、ローカルのテスト、報告書の作成、ユーザーが実行する手順の作成。
- ユーザーしかできないこと: 外部4サービスの管理画面操作、キーの発行・設定、実購入、GitHubへのpush、法務の確認、ドメイン・メールの設定。
- 正本はMacの `~/Desktop/Mr-Satto`。クラウド側の作業コピーは検証用の複製（ハッシュ照合で一致を確認）。

### 14.6 Claudeの意見

- この報告書は事実の整理が目的なので、優先順位は付けていない。ただ、判断の材料として一点だけ。課金をONにする前に、**Premiumが何に対して1,100円なのか**（現状は広告なしとAI補助のみ）を決めておくと、料金ページの表現・規約・特商法・AIの利用枠の設計が一貫しやすい（6.2）。
- 利用データがない状態（U-11）で機能を増減する判断は、根拠が弱くなる。計測の有無は、方針判断の前提になりうる。

---

## 付録A. ツール一覧（現在のソースから機械的に生成）

生成元: `src/lib/tools/data.ts`（TypeScriptで評価した結果）と `src/components/tools/tool-registry.tsx`（対応表）。全106件。処理場所はすべて「ブラウザ」。「元の区分」は `ALL_TOOLS_STANDARD` を無視した定義上の値（現在は全件が standard 扱い）。

#### 画像（`image`）: 23件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| image-resize | 画像リサイズ | image-canvas-tool.tsx（共通） | standard | 画像の縦横サイズを指定してリサイズします |
| image-compress | 画像圧縮 | image-canvas-tool.tsx（共通） | standard | 画質を保ちながら画像のファイルサイズを小さくします |
| image-compress-to-size | 指定KBまで圧縮 | image-canvas-tool.tsx（共通） | standard | 目標のファイルサイズ(KB)を指定して自動で圧縮します |
| image-jpg-convert | JPG変換 | image-canvas-tool.tsx（共通） | standard | 画像をJPG形式に変換します |
| image-png-convert | PNG変換 | image-canvas-tool.tsx（共通） | standard | 画像をPNG形式に変換します |
| image-webp-convert | WebP変換 | image-canvas-tool.tsx（共通） | standard | 画像をWebP形式に変換します |
| pdf-to-image | PDF→画像 | pdf-to-image-tool.tsx | standard | PDFの各ページを画像として書き出します |
| image-sns-size | SNSサイズ変換 | image-sns-size-tool.tsx | standard | Instagram・X(Twitter)など各SNSの推奨サイズに変換します |
| image-crop | 画像トリミング | image-crop-tool.tsx | standard | 画像の必要な部分だけを切り抜きます |
| image-batch-convert | 画像一括変換 | image-batch-convert-tool.tsx | standard | 複数の画像をまとめてJPG・PNG・WebPに変換し、ZIPでまとめてダウンロードします |
| image-rotate | 画像回転 | image-canvas-tool.tsx（共通） | standard | 画像を90度単位で回転・反転します |
| image-flip | 画像反転 | image-flip-tool.tsx | standard | 画像を左右または上下に反転します |
| image-grayscale | 画像グレースケール | image-grayscale-tool.tsx | standard | 画像をモノクロ・グレースケールに変換します |
| image-adjust | 画像明るさ・コントラスト調整 | image-adjust-tool.tsx | standard | 画像の明るさとコントラストを調整します |
| image-metadata-remove | 画像メタデータ削除 | image-metadata-remove-tool.tsx | standard | 画像を再エンコードして不要なメタデータを取り除きます |
| image-watermark | 画像ウォーターマーク | image-watermark-tool.tsx | standard | 画像にテキストの透かしを追加します |
| image-layout | 画像レイアウト | image-layout-tool.tsx | standard | 複数の画像・文字を自由配置し、結合・グリッド配置してPNG/JPEG/PDFに書き出します |
| image-merge | 画像結合 | image-merge-tool.tsx | standard | 複数の画像を横結合・縦結合・グリッドでシンプルにまとめてPNG/JPEGに書き出します（元サイズ維持が既定） |
| image-padding-text | 画像一括余白・文字入れ | image-padding-text-tool.tsx | standard | 複数の画像の周囲に余白を追加し、余白部分に文字（キャプション等）を入れて一括で書き出します（元画像はリサイズしません） |
| image-tile-split | 画像タイル分割 | image-tile-split-tool.tsx | standard | 1枚の画像を指定した行数×列数へ均等に分割し、複数の画像としてZIPで一括ダウンロードします |
| image-mosaic | 画像モザイク | image-mosaic-tool.tsx | standard | 画像の一部を矩形選択してモザイク・ぼかしを適用し、個人情報や顔・ナンバープレートなどを隠します |
| image-passport-photo | 証明写真サイズ変換 | image-passport-photo-tool.tsx | standard | 証明写真サイズにトリミングし、画像として保存またはA4用紙にまとめてPDF印刷できます |
| background-remover | 背景透過（背景除去） | background-remover-tool.tsx | standard | AIが画像の背景を自動で透明にします。画像は端末の外へ送信されません |

#### PDF（`pdf`）: 20件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| pdf-merge | PDF結合 | pdf-merge-tool.tsx | standard | 複数のPDFファイルを1つに結合します |
| pdf-split | PDF分割 | pdf-split-tool.tsx | standard | PDFをページ単位で分割します |
| pdf-delete-pages | PDFページ削除 | pdf-delete-pages-tool.tsx | standard | PDFの不要なページを削除します |
| pdf-reorder-pages | PDFページ並び替え | pdf-reorder-pages-tool.tsx | standard | PDFのページ順序を並び替えます |
| pdf-rotate | PDF回転 | pdf-rotate-tool.tsx | standard | PDFのページを回転します |
| pdf-compress | PDF圧縮 | pdf-compress-tool.tsx | standard | PDFのファイルサイズを圧縮します |
| image-to-pdf | 画像→PDF | image-to-pdf-tool.tsx | standard | 複数の画像を1つのPDFにまとめます |
| pdf-to-text | PDF→テキスト | pdf-to-text-tool.tsx | standard | PDFからテキストを抽出します |
| word-to-pdf | Word→PDF | word-to-pdf-tool.tsx | premium | Word文書(.docx)をPDFに変換します |
| excel-to-pdf | Excel→PDF | excel-to-pdf-tool.tsx | premium | Excelファイル(.xlsx)をPDFに変換します |
| ocr | OCR | ocr-tool.tsx | premium | 画像やスキャンしたPDFから文字を読み取ります |
| pdf-extract-pages | PDFページ抽出 | pdf-extract-pages-tool.tsx | standard | 指定したページだけを新しいPDFとして取り出します |
| pdf-add-page-numbers | PDFページ番号追加 | pdf-add-page-numbers-tool.tsx | standard | PDFの各ページにページ番号を追加します |
| pdf-watermark | PDF透かし | pdf-watermark-tool.tsx | standard | PDFの各ページにテキストの透かしを追加します |
| pdf-fill-annotate | PDF記入・注釈 | pdf-fill-annotate-tool.tsx | standard | PDFに文字・チェック・図形・手書き・画像・印影を追加して、その場でダウンロードします |
| pdf-password-protect | PDFパスワード保護 | pdf-password-protect-tool.tsx | standard | PDFにパスワードを設定します(AES-256)。印刷・コピー・編集の制限もかけられます |
| pdf-resize-pages | PDFページサイズ変更 | pdf-resize-pages-tool.tsx | standard | PDFのページサイズをA4・A3・Letterなどに変更します |
| pdf-metadata-remove | PDFメタデータ削除 | pdf-metadata-remove-tool.tsx | standard | PDFのタイトル・作成者などのメタデータを確認して削除します |
| pdf-crop-pages | PDF余白調整 | pdf-crop-pages-tool.tsx | standard | PDFページの上下左右の余白（表示範囲）を調整します |
| form-to-individual-pdfs | フォーム回答から個別PDFを一括作成 | form-to-individual-pdfs-tool.tsx | standard | Googleフォーム・Microsoft Formsの回答データをPDFテンプレートに差し込み、個別PDFを一括生成します |

#### Excel・CSV（`csv-excel`）: 16件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| pdf-to-excel | PDF→Excel | pdf-to-excel-tool.tsx | premium | PDF内の表をExcelファイルに変換します |
| csv-format | CSV整形 | csv-format-tool.tsx | standard | 余分な空白・空行・改行コードを整えます |
| csv-to-excel | CSV→Excel | csv-to-excel-tool.tsx | standard | CSVファイルをExcel形式に変換します |
| excel-to-csv | Excel→CSV | excel-to-csv-tool.tsx | standard | ExcelファイルをCSV形式に変換します |
| csv-merge | CSV結合 | csv-merge-tool.tsx | standard | 複数のCSVファイルを1つに結合します |
| csv-dedupe | 重複削除 | csv-dedupe-tool.tsx | standard | CSVの重複した行を削除します |
| csv-to-json | CSV→JSON | csv-to-json-tool.tsx | standard | CSVファイルをJSON形式に変換します |
| json-to-csv | JSON→CSV | json-to-csv-tool.tsx | standard | JSON配列をCSV形式に変換します |
| csv-replace | 文字列置換 | csv-replace-tool.tsx | standard | CSV内の文字列を一括置換します |
| csv-column-editor | CSV列編集 | csv-column-editor-tool.tsx | standard | CSVの列を選択・削除・リネーム・並び替えします |
| excel-transpose | Excel行列入れ替え | excel-transpose-tool.tsx | standard | Excelファイルの行と列を入れ替えます |
| excel-blank-remove | Excel空白行・空白列削除 | excel-blank-remove-tool.tsx | standard | Excelファイル内の完全に空白な行・列をまとめて削除します |
| excel-replace | Excel文字削除・置換 | excel-replace-tool.tsx | standard | Excel内の文字列を検索して削除・置換します |
| excel-merge-center | Excel横セル結合・中央揃え | excel-merge-center-tool.tsx | standard | 指定した範囲のセルを横方向に結合し、中央揃えを設定します |
| excel-date-shift | Excel日付一括変更 | excel-date-shift-tool.tsx | standard | Excel内の日付セルの年・月・日をまとめて変更、または日数を加減算します |
| filled-pdf-to-excel | 記入済みPDF→Excel | filled-pdf-to-excel-tool.tsx | standard | 記入済みの申請書・帳票のPDFを項目ごとに整理してExcelに変換します。テンプレートを登録すれば1ページに複数人分の情報がある帳票にも対応します |

#### Word（`word`）: 4件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| pdf-to-word | PDF→Word | pdf-to-word-tool.tsx | premium | PDFをWord文書に変換します |
| word-paragraph-cleanup | Word段落整理 | word-paragraph-cleanup-tool.tsx | standard | Word文書の全角・半角スペースや空白行をまとめて整理します |
| word-renumber | Word番号振り直し | word-renumber-tool.tsx | standard | 「1.2.3.」「(1)(2)(3)」「①②③」「ア イ ウ」などの番号表記をまとめて変換します |
| excel-label | ラベル作成 | excel-label-tool.tsx | standard | ラベル用紙の寸法(mm)に合わせて、全ラベル同じ内容／ラベルごとに違う内容のラベルシートをWord・Excelで作成します |

#### PowerPoint（`pptx`）: 1件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| pptx-invert | PowerPoint白黒反転 | pptx-invert-tool.tsx | standard | PowerPoint（.pptx）の白い背景・黒い文字を、黒い背景・白い文字に変換して保存します。白黒の画像も反転し、カラー写真・イラストはそのまま。編集できる形式のまま出力し、ファイルは送信されません |

#### 動画（`video`）: 7件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| video-convert | 動画形式変換 | video-convert-tool.tsx | premium | 動画をMP4・WebM形式に変換します |
| video-compress | 動画圧縮 | video-compress-tool.tsx | premium | 動画のファイルサイズを圧縮します |
| video-resize | 動画解像度変更 | video-resize-tool.tsx | premium | 動画の解像度を1080p・720p・480pなどに変更します |
| video-frame-rate | 動画フレームレート変更 | video-frame-rate-tool.tsx | premium | 動画のフレームレート(fps)を下げます |
| video-h264 | H.264変換（H.265対応） | video-h264-tool.tsx | premium | H.265(HEVC)などの動画をH.264(AVC)コーデック・MP4形式に変換します（iPhoneの動画にも） |
| video-thumbnail | 動画サムネイル抽出 | video-thumbnail-tool.tsx | premium | 動画の指定した時点の静止画をPNG・JPEGで書き出します |
| video-metadata-remove | 動画メタデータ削除 | video-metadata-remove-tool.tsx | premium | 動画に含まれる撮影日時・位置情報(GPS)・タイトルなどのメタデータを削除します |

#### 音声（`audio`）: 6件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| audio-convert | 音声形式変換 | audio-convert-tool.tsx | standard | 音声をMP3・WAV・M4A・OGG・FLACに変換します（M4A→MP3も対応） |
| audio-extract | 動画から音声を抽出 | audio-extract-tool.tsx | standard | MP4・MOV・WebMの動画から音声だけを取り出して保存します |
| audio-trim | 音声カット | audio-trim-tool.tsx | standard | 音声の必要な部分だけを切り出します |
| audio-merge | 音声結合 | audio-merge-tool.tsx | standard | 複数の音声ファイルを順番に1つへつなげます |
| audio-volume | 音量調整・ノーマライズ | audio-volume-tool.tsx | standard | 音声の音量を上げ下げしたり、最大音量を自動で揃えたりします |
| audio-compress | 音声圧縮 | audio-compress-tool.tsx | standard | 音声のファイルサイズを小さくします |

#### ファイル（`file`）: 5件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| file-bulk-rename | 一括ファイル名変更 | file-bulk-rename-tool.tsx | standard | 複数のファイル名をまとめて変更します |
| file-sequential-rename | 連番リネーム | file-sequential-rename-tool.tsx | standard | ファイル名に連番を付けてリネームします |
| file-zip | ZIP作成 | file-zip-tool.tsx | standard | 複数のファイルをまとめてZIP化します |
| file-unzip | ZIP解凍 | file-unzip-tool.tsx | standard | ZIPファイルをブラウザ上で解凍して中身を取り出します |
| file-hash | ファイルハッシュ | file-hash-tool.tsx | standard | ファイルのSHA-256ハッシュ値を計算します |

#### 生成ツール（`generator`）: 8件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| business-card-qr | 名刺二次元コード作成 | business-card-qr-tool.tsx | standard | 連絡先情報を二次元コード化して名刺やメールに使えます |
| color-palette-generator | 配色パレット生成 | color-palette-tool.tsx | standard | ベースカラーから調和の取れた配色パレットを作成します |
| gradient-generator | グラデーション生成 | gradient-generator-tool.tsx | standard | CSSコードとPNG画像で使えるグラデーションを、プレビューを見ながら作成します |
| electronic-stamp-generator | 電子印鑑生成 | electronic-stamp-generator-tool.tsx | standard | 文字から印影画像を作成したり、お手持ちの印鑑を画像・PDFから取り込んで透明PNGに整えたりできます |
| qr-generator | 二次元コード生成 | qr-generator-tool.tsx | standard | URLやテキストから二次元コードを作成します |
| password-generator | パスワード生成 | password-generator-tool.tsx | standard | 安全でランダムなパスワードを生成します |
| fiscal-calendar | 年度カレンダー作成 | fiscal-calendar-tool.tsx | standard | 4月始まりの年度（4月〜翌年3月）の月別カレンダーを、日本の祝日入りでExcel（12シート）・PDF（12ページ）に作成します。月曜・日曜始まりとデザインを選べ、A4で印刷しやすい設定で書き出します |
| sequence-generator | 連番・項目一括生成 | sequence-generator-tool.tsx | standard | 「第１回 英語」のような連番付きの項目を一括で作ります。1つの項目の連番も、複数の項目を入力順に項目ごとの連番にすることもでき、結果は編集してExcelへそのまま貼り付けられます |

#### その他（`other`）: 16件

| ID | ツール名 | 実装ファイル（src/components/tools/implementations/） | 元の区分 | 説明（data.ts） |
|---|---|---|---|---|
| pomodoro-timer | ポモドーロタイマー | pomodoro-timer-tool.tsx | standard | 集中と休憩を繰り返す勉強・作業用タイマーです |
| unit-converter | 単位変換 | unit-converter-tool.tsx | standard | 長さ・重さ・温度・面積（坪・畳）・体積・速度・時間・データ容量の単位を変換します |
| estimate-generator | 見積書作成 | estimate-generator-tool.tsx | premium | オンラインで見積書を作成してPDFで保存できます |
| quote-order-generator | 見積書・注文書の一体作成 | quote-order-generator-tool.tsx | premium | A4の1枚に、上が見積書・下が注文書。1回の入力で両方を作れます |
| invoice-generator | 請求書作成 | invoice-generator-tool.tsx | premium | 請求書を作成して振込先情報付きのPDFでダウンロードできます |
| order-generator | 注文書作成 | order-generator-tool.tsx | premium | 注文書を簡単に作成してPDFで保存できます |
| char-count | 文字数カウント | char-count-tool.tsx | standard | 文字数・単語数・行数をカウントします |
| json-formatter | JSON整形 | json-formatter-tool.tsx | standard | JSONを見やすく整形・検証します |
| text-line-cleaner | テキスト行整理 | text-line-cleaner-tool.tsx | standard | 空行削除・重複行削除・並び替えなどをまとめて行います |
| text-case-converter | 大文字・小文字・数字の全角半角変換 | text-case-converter-tool.tsx | standard | 英字を大文字・小文字・先頭大文字に変換し、数字を全角⇄半角にそろえます |
| date-weekday-tool | 日付・曜日ツール | date-weekday-tool.tsx | standard | 曜日確認・日付の加減算・日付一覧・曜日抽出・営業日計算をまとめて行います |
| time-calculator | 時間計算 | time-calculator-tool.tsx | standard | 時間差・時刻の加減算・複数時間の合計・実働時間（休憩差引）を計算します |
| number-format | 数字・番号フォーマット | number-format-tool.tsx | standard | 郵便番号・電話番号の整形や、カンマ・区切り文字の追加削除を行います |
| envelope-address | 封筒宛名作成 | envelope-address-tool.tsx | standard | 長形3号・長形4号・角形2号の封筒に、縦書き/横書き・封筒の向き・様/御中/なし・文字サイズ/太字を選び、位置と大きさをスライダーで調整して宛名・差出人・自由テキストを印刷するPDFを作成します。Excel/CSVからの複数宛先読み込みにも対応 |
| ticket-voucher | 整理券・金券・引換券作成 | ticket-voucher-tool.tsx | standard | 開始・終了番号、二次元コード・バーコードの内容や位置・大きさ、Excel一括読み込みに対応した、整理券・金券・引換券のPDFをまとめて作成します |
| roster-template | 名簿テンプレート作成 | roster-template-tool.tsx | standard | Excel/CSVから使用する列を選び、行の高さ・列の幅をmm指定して、印刷向けの名簿シートをExcel・PDFで作成します。スキャンしたPDFの罫線を読み取って、同じ大きさの枠をExcelで再現することもできます |
