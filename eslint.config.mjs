import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 祝日データ自動更新スクリプトのビルド出力（使い捨て）
    ".holiday-sync-build/**",
    // pdfjs-dist の Worker (PDF→画像ツール用) は node_modules からコピーした
    // 圧縮済み配布物であり、Lint対象のソースコードではない。
    "public/pdf.worker.min.mjs",
    // tesseract.js / tesseract.js-core のWorker・WASMグルーコードも同様に
    // npmパッケージから抽出した圧縮済み配布物（Phase 2-D OCR機能用）であり、
    // 自前のソースコードではないためLint対象から除外する。
    "public/tesseract/**",
    // onnxruntime-web の WASM グルーコード（背景除去用）も同様。node_modules/onnxruntime-web/dist の
    // 同名ファイルとバイト単位で同一の圧縮済み配布物であり、自前のソースコードではないためLint対象から除外する。
    "public/ort/**",
  ]),
]);

export default eslintConfig;
