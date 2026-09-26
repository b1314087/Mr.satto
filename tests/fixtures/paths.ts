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
  png: path.join(GENERATED_DIR, "sample.png"),
  jpg: path.join(GENERATED_DIR, "sample.jpg"),
  xlsx: path.join(GENERATED_DIR, "sample.xlsx"),
  zip: path.join(GENERATED_DIR, "sample.zip"),
  webm: path.join(GENERATED_DIR, "sample.webm"),
};
