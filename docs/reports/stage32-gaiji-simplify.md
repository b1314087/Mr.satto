# 段階32：外字・特殊文字チェックの画面を簡単にする

## 変更したこと

- 結果のCSV書き出し（「結果をCSVでダウンロード」）を削除した。
- 「3. 整えたテキスト」の説明を一文に短くした。直す内容のチェック欄と直した数は「詳しい設定（直す内容・直した数）」に畳んだ（押すと開く）。
- 「このチェックでできること・できないこと」の欄を削除した（同じ内容はよくある質問にある）。「問題がないことの保証ではありません」は結果の欄に残している。
- SEOの使い方から、CSVのダウンロードの行を削除した。

## 変更したファイル

- src/components/tools/implementations/gaiji-checker-tool.tsx
- src/lib/gaiji/report.ts（CSVを作る処理を削除）
- src/lib/seo/tool-content.ts
- tests/tools/gaiji-checker.spec.ts

## 確認

- tests/tools/gaiji-checker.spec.ts：22件成功
- gaiji-detect・gaiji-variants・tests/seo・tests/registry：523件成功
- preview-all（gaiji-checker）：成功
- tsc・eslint・next build：成功
