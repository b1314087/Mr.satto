# PDF→画像で日本語の文字が消える問題の修正 報告書

作成日：2026-11-01（利用者からの報告「PDF→Jpegにした際に、文字がなくなった。PDFそのままの状態を再現して欲しい」による。ファイル名は既存の報告書と重ならないよう stage23 とした）

## 最初に（結論）

PDF→画像で、日本語の文字が消えることがある問題を直しました。

- 原因：PDFを描く部品（pdf.js）に、日本語の文字の対応表（CMap）の場所を渡していなかった。PDFにフォントが入っていない日本語の文字（「MS明朝」「ヒラギノ」などを名前だけで指定した文字。Word・Excel・業務システムから作ったPDFによくある）は、この表が無いと描けず、画像にすると文字が消えていた
- 直し方：pdfjs-dist 付属の対応表（CMap）と標準フォントのデータを `public/pdfjs/` に置き、PDFを開くすべての所でその場所を渡すようにした
- 同じ部品を使う他のツール（PDFの縮小表示、黒塗り、パスワード保護、名簿の読み取り、PDF→Excel・Word、OCR など）も、同じく直る
- 処理はこれまでどおりブラウザの中だけ。読み込むのは同じサイトの中のファイルだけで、PDFの中身をどこかへ送ることはない
- commit・push・マージ・デプロイは行っていません

## 1. 作業開始時のGit状態

- main、HEAD は `9a17eb5`（全ツール：処理中の画面）。GitHubと同じで、未コミットの変更はなし

## 2. 原因の確認（再現）

フォントを入れずに日本語を書いたPDF（HeiseiKakuGo-W5・UniJIS-UCS2-H で名前だけ指定）を作り、PDF→画像で変換した。

- 直す前：画像に文字が1つも描かれなかった（黒い画素 0）。pdf.js は「cMapUrl と cMapPacked を渡してください」という警告を出していた
- 直した後：「日本語の文字テスト　山田太郎」が描かれた（黒い画素 約15,000）

## 3. 変更したファイル

追加：

- `public/pdfjs/cmaps/`（169ファイル）・`public/pdfjs/standard_fonts/`（16ファイル）：pdfjs-dist 4.10.38 付属のファイルの写し（約2.5MB。ライセンスのファイルも同梱）
- `tests/tools/pdf-cjk-render.spec.ts`：テスト
- この報告書

変更：

- `src/lib/pdf/pdfjs-client.ts`：PDFを開くときに渡す設定（`PDFJS_ASSET_OPTIONS`）を追加し、共通の読み込みで渡す
- PDFを直接開いていた所にも、同じ設定を渡す：
  - `src/components/common/pdf-thumbnails.tsx`（PDFの縮小表示）
  - `src/components/tools/implementations/roster-scan-panel.tsx`（名簿の読み取り）
  - `src/components/tools/implementations/shared/use-pdf-page-aspects.ts`（ページの縦横）
  - `src/components/tools/implementations/pdf-password-protect-tool.tsx`（パスワード保護の確認）
  - `src/lib/processors/browser/pdf-protect.ts`（パスワード保護）
  - `src/lib/processors/browser/pdf-redact.ts`（黒塗り。ページを画像にするため、同じく文字が消えるおそれがあった）

## 4. 実行したテストと結果

新しいテスト（`tests/tools/pdf-cjk-render.spec.ts`）：2件合格

- PDFを開くすべての所で設定を渡していること。対応表・標準フォントのファイルがあり、pdfjs-dist と同じ版であること
- PDF→画像で、フォントの入っていない日本語の文字が、画像に描かれること

関係する既存のテスト（PDFを開くツールのテスト、全ツールのプレビュー、ファイル選択・縮小表示、OCR、セキュリティの確認など）：420件合格、1件は1回目に失敗して2回目に合格（外字チェックのWordのテスト。今回変えたPDFを描く部分は使わない）

型チェック（`tsc --noEmit`）・ESLint（`src` と `tests`）：エラー・警告なし。本番ビルド（`next build`）：成功。

## 5. 残っている制約

- PDFにフォントが入っていない文字は、見る側のパソコン・スマホにある日本語のフォントで描く。そのため、文字は出るが、元のフォント（例：MS明朝）と字形が少し違う場合がある（PDFを開くアプリでも同じ）
- 外字（そのパソコンだけで作った文字）は、フォントが入っていなければ描けない
- pdfjs-dist の版を上げるときは、`public/pdfjs/` も同じ版のものに置き換える必要がある（テストで、版の違いを見つけられる）

## Claudeの意見

- 利用者のPDFで確認できていないため、同じPDFでもう一度試してもらうのがよいと思います。それでも文字が消える場合は、別の原因（文字が特殊な形で入っているなど）のため、PDFを見せてもらえれば調べます。
