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

  // Phase 18.2 C節: word-to-pdf「Wordの印刷ページ=PDFのページ」テスト用フィクスチャ。
  // 実在の企業・個人データは一切使用しない、架空のダミー文章のみ
  // （tests/fixtures/docx-writer.ts の手組みDOCXビルダーで生成）。
  wordPageBreakDocx: path.join(GENERATED_DIR, "word-page-break.docx"),
  wordPageBreakBeforeDocx: path.join(GENERATED_DIR, "word-page-break-before.docx"),
  wordLandscapeA4Docx: path.join(GENERATED_DIR, "word-landscape-a4.docx"),
  wordMarginsDocx: path.join(GENERATED_DIR, "word-margins.docx"),
  wordRichContentDocx: path.join(GENERATED_DIR, "word-rich-content.docx"),
  wordMultiSectionDocx: path.join(GENERATED_DIR, "word-multi-section.docx"),
};
