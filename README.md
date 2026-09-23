# Mr.Satto（Phase 1）

「面倒な作業を、サッと。」がコンセプトのWebツールサービス **Mr.Satto** の Phase 1 実装です。
画像・PDF・ファイル・CSV/Excel・学生向け・仕事・クリエイター向けなどのツールを1つにまとめ、
Next.js (App Router) + TypeScript + Tailwind CSS で構築しています。GitHub → Vercel の流れで
そのままWebサイトとして公開できる構成になっています。

> サービス名(ユーザー向け表示)は `src/lib/config/site.ts` の `siteConfig` に一元化しており、
> ここを変更するだけで全ページのブランド表記が切り替わります。なお、内部的なリポジトリ名・
> npmパッケージ名（`package.json` の `name`）は `universal-web-tools` のままにしています
> （変更による不要な影響を避けるため。ユーザーに表示されることはありません）。

## 技術構成

- Next.js 16 (App Router, Turbopack)
- React 19 / TypeScript
- Tailwind CSS v4（ダークモード: `next-themes` によるOS連動 + 手動切り替え）
- 依存ライブラリは最小限（`qrcode` のみ。QR生成も完全にブラウザ内で完結）
- 決済・アカウント機能は導入していません。広告収益化(Google AdSense)は「土台」のみ用意しており、
  広告IDを設定するまでは実際の広告配信は行われません（後述）

## ディレクトリ構成（抜粋）

```
src/
  app/                      # ルーティング（App Router）
    page.tsx                # トップページ
    tools/page.tsx          # ツール一覧（検索・カテゴリ絞り込み）
    tools/[tool]/page.tsx   # ツール詳細ページ（動的ルート）
    privacy/ terms/ contact # 静的ページ
    sitemap.ts robots.ts opengraph-image.tsx  # SEO関連
  components/
    ads/                    # AdSlot / RewardedDownloadGate（広告・Download Gate）
    common/                 # FileDropzone / FileList / ProcessingStatus / DownloadButton / ErrorMessage など共通UI
    layout/                 # Header / Footer
    theme/                  # ダークモード
    tools/                  # ToolCard / ToolGrid / 検索 / カテゴリ絞り込み / ComingSoon
    tools/implementations/  # 各ツールの実装コンポーネント
  lib/
    tools/                  # Tool/Category のデータ構造・データ本体・検索ロジック（データ駆動）
    processors/
      types.ts              # Processor / BrowserProcessor / ServerProcessor の基底インターフェース
      browser/               # 実際にブラウザ内で処理を行うProcessor実装（画像・QR・パスワード・テキスト等）
      server/                # Phase 2以降で実装するServerProcessorのプレースホルダー
    ads/config.ts           # AdSense関連の設定（広告ID・スロットID。環境変数から取得）
    download/types.ts       # DownloadAccessMode ("free" | "rewarded" | "premium")
```

## Processorアーキテクチャ

```
Tool → Processor ├── BrowserProcessor（Phase 1で実装）
                  └── ServerProcessor（Phase 1はインターフェースのみ。Phase 2以降で実装）
```

UIコンポーネントは各Processorクラスの `process()` だけを呼び出し、画像処理などの実装詳細には
直接触れません。将来、同じToolのままBrowserProcessor⇄ServerProcessorを差し替えられる設計です
（例: 高度なOCRやPDF→Excelなど、サーバー処理が適切な機能をPhase 2で追加する場合）。

## Phase 1で実際に動作するツール

ブラウザ内処理のみで完結する以下のツールは実装済みです（ファイルはサーバーに送信されません）。

- 画像: リサイズ / 圧縮 / 指定KBまで圧縮 / JPG・PNG・WebP変換 / 回転
- CSV: CSV整形
- その他: QRコード生成 / パスワード生成 / 文字数カウント / JSON整形
- 学生向け: ポモドーロタイマー
- 仕事: 名刺QRコード作成
- クリエイター: 配色パレット生成

それ以外のツール（PDF編集・OCR・ファイル一括操作など）は Phase 1 では「準備中」ページとして
登録のみ行っており、`src/lib/tools/data.ts` の `status` を `"available"` に変更し、対応する
Processor・UIコンポーネントを実装することで追加できます。

## 広告収益化(Google AdSense)アーキテクチャ

```
Tool Processing → Processed File → Download Gate(RewardedDownloadGate) → Download
```

各ツールのダウンロード処理は `RewardedDownloadGate` コンポーネント（`src/components/ads/`）を
経由します。`DownloadAccessMode`（`src/lib/download/types.ts`）で以下を切り替えられる設計です。

- `free`（現在の標準）: 通常広告を表示しつつ、そのままダウンロードできる
- `rewarded`（Phase 2以降）: リワード広告の視聴完了後にダウンロードが解除される
- `premium`（将来のPremiumプラン向け）: 広告なしで即ダウンロード

広告表示自体は `AdSlot` コンポーネント（`src/components/ads/ad-slot.tsx`）が担当します。
`NEXT_PUBLIC_ADSENSE_CLIENT_ID` が未設定の間（現在）は、実際の広告は読み込まれず、
レイアウト確認用のプレースホルダー（「広告（準備中）」の枠）が表示されるだけです。
AdSenseの審査に通過して広告ID・スロットIDを取得したら、`.env.example` を参考に
Vercelの環境変数へ設定してください（`NEXT_PUBLIC_` プレフィックスの値は秘密情報ではないため、
Vercelの環境変数タイプは「Config」を選択してください）。

## ローカル開発

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開いてください。

## ビルド確認

```bash
npm run lint
npm run build
```

## GitHubへのプッシュとVercelへのデプロイ

1. GitHubで新しいリポジトリを作成します。
2. このプロジェクトのリモートを設定してpushします。

   ```bash
   git remote add origin <あなたのGitHubリポジトリURL>
   git branch -M main
   git push -u origin main
   ```

3. [Vercel](https://vercel.com) にログインし、「Add New Project」から上記GitHubリポジトリを
   インポートします（Framework Presetは自動的に Next.js が選択されます）。
4. デプロイ後に発行されるURLを `NEXT_PUBLIC_SITE_URL` 環境変数として Vercel のプロジェクト設定に
   追加すると、OGP画像やsitemapが正しい本番URLで生成されます。
5. 以降、`main` ブランチへのpushで自動的にVercelが再デプロイします。

## Phase 1で意図的に実装していないこと

高度なOCR、PDF→Excel/Word本格実装、大容量PDFサーバー処理、Supabase Storageへのファイル保存、
決済・サブスクリプション・広告・ユーザーアカウント、iOS/Androidアプリは Phase 1 の対象外です。
ただし `ServerProcessor` のインターフェースは用意済みのため、Phase 2以降に追加しやすい構造に
なっています。
