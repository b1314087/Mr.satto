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
};
