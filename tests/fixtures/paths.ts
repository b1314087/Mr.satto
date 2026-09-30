import path from "node:path";

/**
 * テストフィクスチャのパス定義。
 *
 * - static/  : リポジトリにコミットされた固定の小さいフィクスチャ（CSV/JSON/TXT）。
 *              個人情報を含まないダミーデータのみ。
 * - generated/: tests/global-setup.ts がテスト実行のたびに生成するバイナリフィクスチャ
 *              （PDF/PNG/JPG/XLSX/ZIP/WebM）。リポジトリにはコミットしない
 *              （.gitignore 参照）。実データを保存しない・毎回使い捨てにするための方針。
 */

const STATIC_DIR = path.join(__dirname, "static");
const GENERATED_DIR = path.join(__dirname, "generated");

export const fixtures = {
  dir: {
    static: STATIC_DIR,
    generated: GENERATED_DIR,
  },
  csv: path.join(STATIC_DIR, "sample.csv"),
  csvForMerge: path.join(STATIC_DIR, "sample-merge.csv"),
  json: path.join(STATIC_DIR, "sample.json"),
  txt: path.join(STATIC_DIR, "sample.txt"),

  singlePagePdf: path.join(GENERATED_DIR, "single-page.pdf"),
  multiPagePdf: path.join(GENERATED_DIR, "multi-page.pdf"),
  japanesePdf: path.join(GENERATED_DIR, "japanese.pdf"),
  landscapePdf: path.join(GENERATED_DIR, "landscape.pdf"),
  png: path.join(GENERATED_DIR, "sample.png"),
  jpg: path.join(GENERATED_DIR, "sample.jpg"),
  // Step 4: 証明写真サイズ変換テスト用。横長画像を証明写真比率へ変更した際の
  // 意図しない大幅な切り取りを確認する目的で、正方形のsample.png/jpgとは別に
  // 横長(landscape)の画像を用意する。
  landscapeJpg: path.join(GENERATED_DIR, "landscape.jpg"),
  // 破損ファイル（拡張子は画像だが中身が不正なバイト列）の異常系テスト用。
  corruptedImage: path.join(GENERATED_DIR, "corrupted-image.png"),
  // Step 5: 画像結合テスト用。sample.png(64x64正方形)・landscapeJpg(300x200横長)とは
  // 別に、異なるサイズが混在する場合の結合結果を確認するための縦長(portrait)画像。
  portraitPng: path.join(GENERATED_DIR, "portrait.png"),
  xlsx: path.join(GENERATED_DIR, "sample.xlsx"),
  zip: path.join(GENERATED_DIR, "sample.zip"),
  webm: path.join(GENERATED_DIR, "sample.webm"),

  // Phase 16: 電子印鑑生成（印影取り込み）テスト用フィクスチャ。
  // 実在の印鑑・個人情報は一切使用せず、すべてCanvasで合成した架空の図形。
  stampPng: path.join(GENERATED_DIR, "stamp.png"),
  stampJpg: path.join(GENERATED_DIR, "stamp.jpg"),
  stampSmallPng: path.join(GENERATED_DIR, "stamp-small.png"),
  stampComplexBgPng: path.join(GENERATED_DIR, "stamp-complex-bg.png"),
  stampPdf: path.join(GENERATED_DIR, "stamp.pdf"),
  stampLargeImagePng: path.join(GENERATED_DIR, "stamp-large.png"),
  stampTransparentPng: path.join(GENERATED_DIR, "stamp-transparent.png"),

  // Phase 18: 記入されたPDF→Excel「テンプレートモード」テスト用フィクスチャ。
  // 実在の人物・個人情報は一切使用しない（tests/fixtures/template-layout.ts参照）。
  templateBlankPdf: path.join(GENERATED_DIR, "template-blank.pdf"),
  templateFilledPdf: path.join(GENERATED_DIR, "template-filled.pdf"),
  templateFilledEmptySecondPdf: path.join(GENERATED_DIR, "template-filled-empty-second.pdf"),
  templateFilledMultiPagePdf: path.join(GENERATED_DIR, "template-filled-multi-page.pdf"),
  templateFilledThreePersonPdf: path.join(GENERATED_DIR, "template-filled-three-person.pdf"),
  templateBlankScannedPdf: path.join(GENERATED_DIR, "template-blank-scanned.pdf"),
  templateFilledScannedPdf: path.join(GENERATED_DIR, "template-filled-scanned.pdf"),

  // Phase 18.2: checkbox枠(A-19)・隣接Field分離(A-11/A-12)テスト用フィクスチャ。
  // 実在の人物・個人情報は一切使用しない（tests/fixtures/template-layout.ts参照）。
  templateBlankCheckboxPdf: path.join(GENERATED_DIR, "template-blank-checkbox.pdf"),
  templateFilledCheckboxCheckedPdf: path.join(GENERATED_DIR, "template-filled-checkbox-checked.pdf"),
  templateFilledCheckboxUncheckedPdf: path.join(GENERATED_DIR, "template-filled-checkbox-unchecked.pdf"),
  templateBlankAdjacentPdf: path.join(GENERATED_DIR, "template-blank-adjacent.pdf"),
  templateFilledAdjacentPdf: path.join(GENERATED_DIR, "template-filled-adjacent.pdf"),

  // Phase 18.2 B節: excel-to-pdf「Excelの印刷ページ=PDFのページ」テスト用フィクスチャ。
  // 実在の企業・個人データは一切使用しない、架空のダミーセル内容のみ
  // （tests/fixtures/xlsx-writer.ts の手組みXLSXビルダーで生成。
  // write-excel-fileでは印刷設定を書き出せないため新規に用意した）。
  excelFit1x1Xlsx: path.join(GENERATED_DIR, "excel-fit-1x1.xlsx"),
  excelFit1x3Xlsx: path.join(GENERATED_DIR, "excel-fit-1x3.xlsx"),
  excelFit2x2Xlsx: path.join(GENERATED_DIR, "excel-fit-2x2.xlsx"),
  excelPrintAreaXlsx: path.join(GENERATED_DIR, "excel-print-area.xlsx"),
  excelHiddenXlsx: path.join(GENERATED_DIR, "excel-hidden.xlsx"),
  excelPageBreakXlsx: path.join(GENERATED_DIR, "excel-page-break.xlsx"),
  excelBorderPartialXlsx: path.join(GENERATED_DIR, "excel-border-partial.xlsx"),
  excelBorderlessLargeXlsx: path.join(GENERATED_DIR, "excel-borderless-large.xlsx"),
  excelPaperA3PortraitXlsx: path.join(GENERATED_DIR, "excel-paper-a3-portrait.xlsx"),
  excelPaperLetterLandscapeXlsx: path.join(GENERATED_DIR, "excel-paper-letter-landscape.xlsx"),
  excelMarginsXlsx: path.join(GENERATED_DIR, "excel-margins.xlsx"),
  excelSheetNameXlsx: path.join(GENERATED_DIR, "excel-sheet-name.xlsx"),
  excelHeaderFooterXlsx: path.join(GENERATED_DIR, "excel-header-footer.xlsx"),

  // Phase 18.2 C節: word-to-pdf「Wordの印刷ページ=PDFのページ」テスト用フィクスチャ。
  // 実在の企業・個人データは一切使用しない、架空のダミー文章のみ
  // （tests/fixtures/docx-writer.ts の手組みDOCXビルダーで生成）。
  wordPageBreakDocx: path.join(GENERATED_DIR, "word-page-break.docx"),
  wordPageBreakBeforeDocx: path.join(GENERATED_DIR, "word-page-break-before.docx"),
  wordLandscapeA4Docx: path.join(GENERATED_DIR, "word-landscape-a4.docx"),
  wordMarginsDocx: path.join(GENERATED_DIR, "word-margins.docx"),
  wordRichContentDocx: path.join(GENERATED_DIR, "word-rich-content.docx"),
  wordMultiSectionDocx: path.join(GENERATED_DIR, "word-multi-section.docx"),

  // Phase 22: word-to-pdfの空白行・連続空行保持テスト用フィクスチャ。
  wordBlankLinesDocx: path.join(GENERATED_DIR, "word-blank-lines.docx"),

  // 外出先PC修正指示書§21-26: pdf-to-excelの罫線検出テスト用フィクスチャ。
  // 実際に罫線(線分)を描画したPDFと、全く同じレイアウトで罫線だけを
  // 描画していないPDFを対にして用意し、「線がある場合だけ罫線を出力し、
  // 無い場合には出力しない」ことの両方を確認する。
  pdfToExcelBorderedTablePdf: path.join(GENERATED_DIR, "pdf-to-excel-bordered-table.pdf"),
  pdfToExcelBorderlessTablePdf: path.join(GENERATED_DIR, "pdf-to-excel-borderless-table.pdf"),

  // 外出先PC修正指示書§27-28: pdf-to-wordのスキャンPDF(OCR)対応テスト用フィクスチャ。
  // 文字レイヤーを持たない画像のみのPDF（英数字のみ。日本語OCR精度の検証自体が
  // 目的ではなく、OCR経路が正しく動作することの確認が目的のため）。
  pdfToWordScannedPdf: path.join(GENERATED_DIR, "pdf-to-word-scanned.pdf"),

  // 外出先PC修正指示書§32-35: word-to-pdfのページ溢れ(1ページのWordが2ページの
  // PDFになる)根本原因修正の回帰テスト用フィクスチャ。指示書が明示的に要求する
  // 「1ページ(文章のみ)/1ページ+表/1ページ+画像/本当に2ページの文書/A4標準余白」
  // の組み合わせを、いずれも明示的な改ページを使わずに用意する。
  wordOnePageTextDocx: path.join(GENERATED_DIR, "word-overflow-one-page-text.docx"),
  wordOnePageWithTableDocx: path.join(GENERATED_DIR, "word-overflow-one-page-table.docx"),
  wordOnePageWithImageDocx: path.join(GENERATED_DIR, "word-overflow-one-page-image.docx"),
  wordGenuineTwoPageDocx: path.join(GENERATED_DIR, "word-overflow-genuine-two-page.docx"),
};
