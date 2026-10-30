# Mr.Satto

「面倒な作業を、サッと。」がコンセプトのWebツールサービスです。公開URLは https://mrsatto.com です。
画像・PDF・Excel/CSV・Word・PowerPoint・動画・音声などを加工する100以上のツールを、1つのサイトにまとめています。

ファイルの処理は、**可能な限りお使いのブラウザの中だけで完結**させ、ファイルの内容をサーバーへ送らない方針です。
サーバーと通信するのは、会員登録・ログイン・お支払い・AI補助（利用者が同意したときだけ）などの、アカウントに関する処理に限ります。
詳しい取り扱いは、サイト内のプライバシーポリシー（`src/app/privacy/page.tsx`）に書いています。

> サービス名（ユーザー向け表示）は `src/lib/config/site.ts` の `siteConfig` にまとめています。
> 内部のリポジトリ名・npmパッケージ名（`package.json` の `name`）は `universal-web-tools` のままです
> （変更による不要な影響を避けるため。利用者には表示されません）。

## 技術構成

- Next.js 16（App Router・Turbopack）／ React 19 ／ TypeScript ／ Tailwind CSS v4（ダークモードは `next-themes`）
- ファイル処理: ブラウザ内で動くライブラリ（`pdf-lib`・`pdfjs-dist`・`tesseract.js`・`onnxruntime-web`・`mediabunny`・`docx` など）
- 会員・データ: Supabase（認証とデータベース。`@supabase/ssr`）
- お支払い: Stripe（Checkout・カスタマーポータル・Webhook）
- AI補助: OpenAI API（サーバー側からだけ呼ぶ。APIキーはサーバーの環境変数にだけ置く）
- 広告: Google AdSense / Google Ad Manager の仕組みは入っているが、`src/lib/config/features.ts` のスイッチで**現在はオフ**
- テスト: Playwright ／ 自動検証: GitHub Actions ／ 公開: GitHub → Vercel

Next.js 16 では、従来の `middleware.ts` が `proxy.ts` に名前を変えています（`src/proxy.ts`。Supabaseのログイン状態を更新する）。
フレームワークの仕様は旧バージョンと異なる部分があるため、実装前に `node_modules/next/dist/docs/` を確認してください（`AGENTS.md` も参照）。

## ディレクトリ構成（抜粋）

```
src/
  app/                    # ルーティング（App Router）
    page.tsx              # トップページ
    tools/                # ツール一覧、ツール詳細（tools/[tool]）
    pricing/ account/     # 料金ページ、アカウント画面（契約・アカウント削除）
    login/ signup/ auth/  # ログイン、会員登録、パスワード再設定
    admin/                # 管理画面（管理者のみ）
    api/                  # stripe（決済・Webhook）、ai（AI補助）、analytics（訪問数）、admin
    privacy/ terms/ tokushoho/ about/ licenses/   # 法務・案内ページ
    sitemap.ts robots.ts opengraph-image.tsx      # SEO関連
  components/             # account / admin / ads / analytics / auth / common / layout / pricing / seo / theme / tools / ui
    tools/implementations/  # 各ツールの画面
  lib/
    tools/                # ツールの一覧データ（data.ts）、カテゴリ、検索、関連ツール
    processors/browser/   # ブラウザ内で処理を行う実装（画像・PDF・Excelなど）
    config/               # 機能スイッチ（features.ts）、サイト設定（site.ts）
    stripe/ plans/        # 決済・Webhook・プランの判定
    ai/                   # AI補助（利用枠の予約・精算を含む）
    admin/ auth/ legal/ security/ supabase/ analytics/ account/   # 管理者判定、認証、同意の記録、Origin確認 など
    （そのほか各ツール用: pdf, excel, calendar, pptx, video, audio, ocr など）
supabase/
  migrations/             # データベースのSQL（番号順に、SupabaseのSQL Editorで手動適用する）
tests/                    # Playwrightのテスト（分野ごとのフォルダ）
scripts/                  # 補助スクリプト（Stripeの設定確認、SQLのテスト、祝日の自動更新、CIの準備）
docs/
  operations/             # 運用の手順書（外部サービスの設定確認、個人情報に関するご請求の対応）
  reports/                # 調査報告書（作成時点の記録）
.github/workflows/        # ci.yml（自動検証）、sync-holidays.yml（祝日データの自動更新）
```

## ツールの追加・変更

ツールの一覧は `src/lib/tools/data.ts` にまとめたデータで管理しています（データ駆動）。
ツールの画面は `src/components/tools/implementations/` にあり、`src/components/tools/tool-registry.tsx` でツールIDと結び付けています。
ツールのURL（`/tools/{ツールID}`）は検索エンジンに登録されているため、変更するときはリダイレクトを用意してください
（`next.config.ts` の `redirects()`）。

## 広告・課金のスイッチ

広告と課金の「入れる／切る」は、環境変数ではなく `src/lib/config/features.ts` の `PRODUCTION_FLAGS` で切り替えます。
値はビルド時にコードへ埋め込まれるため、変えたら再デプロイ（＝`main` へのpush）が必要です。
現在の設定は、課金あり・広告なしです。

## 環境変数

必要な環境変数の一覧と説明は `.env.example` にあります。値（特にAPIキーなどの秘密情報）は、**リポジトリに書かず、
自分のPCの `.env.local` と、Vercelの環境変数の画面にだけ**設定してください（`.env.local` はGitに入りません）。
`NEXT_PUBLIC_` で始まる値はブラウザにも公開されるため、秘密情報には付けないでください。

## ローカル開発

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開きます。

## 検証

```bash
npx tsc --noEmit            # 型チェック
npm run lint                # ESLint
npm run build               # 本番ビルド
npx playwright test <ファイルやフォルダ>   # 関連するテストだけを実行（全件は時間がかかります）
npm run test:features-off   # 広告・課金をオフにした構成の回帰テスト
npm run test:launch-config  # 広告だけオフ（課金あり）の構成のテスト
```

- 全テストは約130ファイルあり、1ワーカーで約45分かかります。通常は変更に関係するテストだけを実行します。
  動作が重い環境では、`--workers=1` を付けると安定します。
- GitHub Actions（`.github/workflows/ci.yml`）は、`main` へのpushとプルリクエストで、型チェック・ESLint・ビルドと、
  重要な分野のテストを実行します（結果を知らせるもので、Vercelの公開は止めません）。
- データベースのSQLのテストは、使い捨てのPostgreSQLで実行します（`scripts/test-tool-usage-sql.sh`・`scripts/test-ai-ledger-sql.sh`）。

## データベース（Supabase）

`supabase/migrations/` のSQLは、番号の小さいものから順に、SupabaseのSQL Editorに貼り付けて実行します（自動では適用されません）。
適用状況の確認方法は `docs/operations/external-services-checklist.md` にまとめています。
コードを公開（push）する前に適用が必要なSQLがあるため、各ファイルの冒頭の説明を確認してください。

## 公開（デプロイ）

`main` ブランチへpushすると、Vercelが自動で再デプロイします。祝日データは、GitHub Actions（`sync-holidays.yml`）が毎週、
内閣府の公式データを確認し、変更があるときだけ更新して `main` に反映します。

## 運用の手順書

- `docs/operations/external-services-checklist.md`: Stripe・Vercel・Supabase・OpenAIの設定確認と、購入から解約までの動作確認の手順・記録表
- `docs/operations/personal-data-requests.md`: 個人情報の開示・削除などのご請求への対応手順
