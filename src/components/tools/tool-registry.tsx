"use client";

import dynamic from "next/dynamic";
import { OcrTool } from "./implementations/ocr-tool";

/**
 * Phase 7 軽量化：各ツール実装を next/dynamic() 経由の動的importに変更した。
 *
 * 変更前は全46ツールを静的importしていたため、/tools/[tool] は単一の
 * 動的ルートである関係上、Next.jsのバンドラーは「どのツールIDが来ても
 * 対応できるように」全ツールの実装コードを1つの共有チャンクへまとめて
 * しまっていた（実測: 本番ビルドで約1.4MBの単一チャンクとなり、QRコード
 * 生成のような軽量ツールのページを開いただけでOCR等を含む全ツール分の
 * UIコードがダウンロードされることを確認済み）。
 *
 * 各Processor内部（pdfjs-dist / tesseract.js / docx / write-excel-file /
 * read-excel-file 等の重量ライブラリ）は元々 `await import(...)` で
 * 遅延読み込みされており、この点は既に適切だった。今回変更したのは
 * 「ツールのUIコンポーネント自体」の読み込みタイミングであり、
 * Processorの実装やツールの動作ロジックには一切手を加えていない。
 *
 * SSR動作は変更しない（next/dynamicの既定どおりサーバー側でも解決される）ため、
 * 初期HTMLの見え方はこれまでと変わらず、ブラウザが取得するJSチャンクだけが
 * ツールIDごとに分割される。
 *
 * ただし OcrTool（OCR）だけは意図的に静的importのまま残している。
 * next/dynamic() 化して実機検証（開発サーバーでのpremiumプラン上書き＋
 * 実際にファイルをアップロードしてOCRを実行するテスト）したところ、
 * 他の43ツールは問題なく動作した一方、OCRツールのみ実行時に
 * "_next/static/chunks/node_modules_*._.js" への404が発生し、OCR処理が
 * 完了しない不具合を確認した（静的importに戻すと発生しない）。
 * tesseract.jsのWorker生成コードが非同期チャンク境界をまたぐことで
 * 発生している可能性が高いが、原因調査・恒久対応には大規模な変更が
 * 必要と判断した。OCRはPhase 7の指示で明示的に保護対象とされている
 * 重要ツールであり、「軽量化のために動作しなくなる」ことは本フェーズの
 * 安全性の優先順位（Simple→Fast→Safe→...）に反する。そのため、OCRのみ
 * 既存の静的import（Phase 6.5までと同じ動作）に戻し、他の43ツール分
 * でのみ動的分割の効果を得る、という最小限の対応とした。
 */
const ImageCanvasTool = dynamic(() =>
  import("./implementations/image-canvas-tool").then((m) => m.ImageCanvasTool)
);
const QrGeneratorTool = dynamic(() =>
  import("./implementations/qr-generator-tool").then((m) => m.QrGeneratorTool)
);
const BusinessCardQrTool = dynamic(() =>
  import("./implementations/business-card-qr-tool").then((m) => m.BusinessCardQrTool)
);
const PasswordGeneratorTool = dynamic(() =>
  import("./implementations/password-generator-tool").then((m) => m.PasswordGeneratorTool)
);
const CharCountTool = dynamic(() =>
  import("./implementations/char-count-tool").then((m) => m.CharCountTool)
);
const JsonFormatterTool = dynamic(() =>
  import("./implementations/json-formatter-tool").then((m) => m.JsonFormatterTool)
);
const CsvFormatTool = dynamic(() =>
  import("./implementations/csv-format-tool").then((m) => m.CsvFormatTool)
);
const PomodoroTimerTool = dynamic(() =>
  import("./implementations/pomodoro-timer-tool").then((m) => m.PomodoroTimerTool)
);
const ColorPaletteTool = dynamic(() =>
  import("./implementations/color-palette-tool").then((m) => m.ColorPaletteTool)
);
const ImageSnsSizeTool = dynamic(() =>
  import("./implementations/image-sns-size-tool").then((m) => m.ImageSnsSizeTool)
);
const ImageCropTool = dynamic(() =>
  import("./implementations/image-crop-tool").then((m) => m.ImageCropTool)
);
const ImageBatchConvertTool = dynamic(() =>
  import("./implementations/image-batch-convert-tool").then((m) => m.ImageBatchConvertTool)
);
const PdfMergeTool = dynamic(() =>
  import("./implementations/pdf-merge-tool").then((m) => m.PdfMergeTool)
);
const PdfSplitTool = dynamic(() =>
  import("./implementations/pdf-split-tool").then((m) => m.PdfSplitTool)
);
const PdfDeletePagesTool = dynamic(() =>
  import("./implementations/pdf-delete-pages-tool").then((m) => m.PdfDeletePagesTool)
);
const PdfReorderPagesTool = dynamic(() =>
  import("./implementations/pdf-reorder-pages-tool").then((m) => m.PdfReorderPagesTool)
);
const PdfRotateTool = dynamic(() =>
  import("./implementations/pdf-rotate-tool").then((m) => m.PdfRotateTool)
);
const ImageToPdfTool = dynamic(() =>
  import("./implementations/image-to-pdf-tool").then((m) => m.ImageToPdfTool)
);
const PdfToImageTool = dynamic(() =>
  import("./implementations/pdf-to-image-tool").then((m) => m.PdfToImageTool)
);
const FileBulkRenameTool = dynamic(() =>
  import("./implementations/file-bulk-rename-tool").then((m) => m.FileBulkRenameTool)
);
const FileSequentialRenameTool = dynamic(() =>
  import("./implementations/file-sequential-rename-tool").then((m) => m.FileSequentialRenameTool)
);
const FileZipTool = dynamic(() =>
  import("./implementations/file-zip-tool").then((m) => m.FileZipTool)
);
const CsvToExcelTool = dynamic(() =>
  import("./implementations/csv-to-excel-tool").then((m) => m.CsvToExcelTool)
);
const ExcelToCsvTool = dynamic(() =>
  import("./implementations/excel-to-csv-tool").then((m) => m.ExcelToCsvTool)
);
const CsvMergeTool = dynamic(() =>
  import("./implementations/csv-merge-tool").then((m) => m.CsvMergeTool)
);
const CsvDedupeTool = dynamic(() =>
  import("./implementations/csv-dedupe-tool").then((m) => m.CsvDedupeTool)
);
const CsvReplaceTool = dynamic(() =>
  import("./implementations/csv-replace-tool").then((m) => m.CsvReplaceTool)
);
const PdfCompressTool = dynamic(() =>
  import("./implementations/pdf-compress-tool").then((m) => m.PdfCompressTool)
);
const PdfToTextTool = dynamic(() =>
  import("./implementations/pdf-to-text-tool").then((m) => m.PdfToTextTool)
);
const EstimateGeneratorTool = dynamic(() =>
  import("./implementations/estimate-generator-tool").then((m) => m.EstimateGeneratorTool)
);
const InvoiceGeneratorTool = dynamic(() =>
  import("./implementations/invoice-generator-tool").then((m) => m.InvoiceGeneratorTool)
);
const OrderGeneratorTool = dynamic(() =>
  import("./implementations/order-generator-tool").then((m) => m.OrderGeneratorTool)
);
const PdfToExcelTool = dynamic(() =>
  import("./implementations/pdf-to-excel-tool").then((m) => m.PdfToExcelTool)
);
const PdfToWordTool = dynamic(() =>
  import("./implementations/pdf-to-word-tool").then((m) => m.PdfToWordTool)
);
const WordToPdfTool = dynamic(() =>
  import("./implementations/word-to-pdf-tool").then((m) => m.WordToPdfTool)
);
const ExcelToPdfTool = dynamic(() =>
  import("./implementations/excel-to-pdf-tool").then((m) => m.ExcelToPdfTool)
);
const PdfExtractPagesTool = dynamic(() =>
  import("./implementations/pdf-extract-pages-tool").then((m) => m.PdfExtractPagesTool)
);
const PdfAddPageNumbersTool = dynamic(() =>
  import("./implementations/pdf-add-page-numbers-tool").then((m) => m.PdfAddPageNumbersTool)
);
const PdfWatermarkTool = dynamic(() =>
  import("./implementations/pdf-watermark-tool").then((m) => m.PdfWatermarkTool)
);
const ImageFlipTool = dynamic(() =>
  import("./implementations/image-flip-tool").then((m) => m.ImageFlipTool)
);
const ImageGrayscaleTool = dynamic(() =>
  import("./implementations/image-grayscale-tool").then((m) => m.ImageGrayscaleTool)
);
const ImageAdjustTool = dynamic(() =>
  import("./implementations/image-adjust-tool").then((m) => m.ImageAdjustTool)
);
const CsvToJsonTool = dynamic(() =>
  import("./implementations/csv-to-json-tool").then((m) => m.CsvToJsonTool)
);
const JsonToCsvTool = dynamic(() =>
  import("./implementations/json-to-csv-tool").then((m) => m.JsonToCsvTool)
);
const TextLineCleanerTool = dynamic(() =>
  import("./implementations/text-line-cleaner-tool").then((m) => m.TextLineCleanerTool)
);
const FileUnzipTool = dynamic(() =>
  import("./implementations/file-unzip-tool").then((m) => m.FileUnzipTool)
);
const FileHashTool = dynamic(() =>
  import("./implementations/file-hash-tool").then((m) => m.FileHashTool)
);
const FileInspectorTool = dynamic(() =>
  import("./implementations/file-inspector-tool").then((m) => m.FileInspectorTool)
);
const PdfResizePagesTool = dynamic(() =>
  import("./implementations/pdf-resize-pages-tool").then((m) => m.PdfResizePagesTool)
);
const PdfMetadataRemoveTool = dynamic(() =>
  import("./implementations/pdf-metadata-remove-tool").then((m) => m.PdfMetadataRemoveTool)
);
const PdfCropPagesTool = dynamic(() =>
  import("./implementations/pdf-crop-pages-tool").then((m) => m.PdfCropPagesTool)
);
const ImageMetadataRemoveTool = dynamic(() =>
  import("./implementations/image-metadata-remove-tool").then((m) => m.ImageMetadataRemoveTool)
);
const ImageWatermarkTool = dynamic(() =>
  import("./implementations/image-watermark-tool").then((m) => m.ImageWatermarkTool)
);
const TextCaseConverterTool = dynamic(() =>
  import("./implementations/text-case-converter-tool").then((m) => m.TextCaseConverterTool)
);
const CsvColumnEditorTool = dynamic(() =>
  import("./implementations/csv-column-editor-tool").then((m) => m.CsvColumnEditorTool)
);

const IMAGE_TOOL_IDS = new Set([
  "image-resize",
  "image-compress",
  "image-compress-to-size",
  "image-jpg-convert",
  "image-png-convert",
  "image-webp-convert",
  "image-rotate",
]);

/**
 * ツールIDと実装コンポーネントの対応表。
 * status: "available" のツールのみここに追加する。
 * 該当が無い場合は呼び出し側で ComingSoon を表示する。
 */
export function ToolImplementation({ toolId }: { toolId: string }) {
  if (IMAGE_TOOL_IDS.has(toolId)) {
    return <ImageCanvasTool toolId={toolId} />;
  }

  switch (toolId) {
    case "qr-generator":
      return <QrGeneratorTool />;
    case "business-card-qr":
      return <BusinessCardQrTool />;
    case "password-generator":
      return <PasswordGeneratorTool />;
    case "char-count":
      return <CharCountTool />;
    case "json-formatter":
      return <JsonFormatterTool />;
    case "csv-format":
      return <CsvFormatTool />;
    case "pomodoro-timer":
      return <PomodoroTimerTool />;
    case "color-palette-generator":
      return <ColorPaletteTool />;
    case "image-sns-size":
      return <ImageSnsSizeTool />;
    case "image-crop":
      return <ImageCropTool />;
    case "image-batch-convert":
      return <ImageBatchConvertTool />;
    case "pdf-merge":
      return <PdfMergeTool />;
    case "pdf-split":
      return <PdfSplitTool />;
    case "pdf-delete-pages":
      return <PdfDeletePagesTool />;
    case "pdf-reorder-pages":
      return <PdfReorderPagesTool />;
    case "pdf-rotate":
      return <PdfRotateTool />;
    case "image-to-pdf":
      return <ImageToPdfTool />;
    case "pdf-to-image":
      return <PdfToImageTool />;
    case "file-bulk-rename":
      return <FileBulkRenameTool />;
    case "file-sequential-rename":
      return <FileSequentialRenameTool />;
    case "file-zip":
      return <FileZipTool />;
    case "csv-to-excel":
      return <CsvToExcelTool />;
    case "excel-to-csv":
      return <ExcelToCsvTool />;
    case "csv-merge":
      return <CsvMergeTool />;
    case "csv-dedupe":
      return <CsvDedupeTool />;
    case "csv-replace":
      return <CsvReplaceTool />;
    case "pdf-compress":
      return <PdfCompressTool />;
    case "pdf-to-text":
      return <PdfToTextTool />;
    case "estimate-generator":
      return <EstimateGeneratorTool />;
    case "invoice-generator":
      return <InvoiceGeneratorTool />;
    case "order-generator":
      return <OrderGeneratorTool />;
    case "ocr":
      return <OcrTool />;
    case "pdf-to-excel":
      return <PdfToExcelTool />;
    case "pdf-to-word":
      return <PdfToWordTool />;
    case "word-to-pdf":
      return <WordToPdfTool />;
    case "excel-to-pdf":
      return <ExcelToPdfTool />;
    case "pdf-extract-pages":
      return <PdfExtractPagesTool />;
    case "pdf-add-page-numbers":
      return <PdfAddPageNumbersTool />;
    case "pdf-watermark":
      return <PdfWatermarkTool />;
    case "image-flip":
      return <ImageFlipTool />;
    case "image-grayscale":
      return <ImageGrayscaleTool />;
    case "image-adjust":
      return <ImageAdjustTool />;
    case "csv-to-json":
      return <CsvToJsonTool />;
    case "json-to-csv":
      return <JsonToCsvTool />;
    case "text-line-cleaner":
      return <TextLineCleanerTool />;
    case "file-unzip":
      return <FileUnzipTool />;
    case "file-hash":
      return <FileHashTool />;
    case "file-inspector":
      return <FileInspectorTool />;
    case "pdf-resize-pages":
      return <PdfResizePagesTool />;
    case "pdf-metadata-remove":
      return <PdfMetadataRemoveTool />;
    case "pdf-crop-pages":
      return <PdfCropPagesTool />;
    case "image-metadata-remove":
      return <ImageMetadataRemoveTool />;
    case "image-watermark":
      return <ImageWatermarkTool />;
    case "text-case-converter":
      return <TextCaseConverterTool />;
    case "csv-column-editor":
      return <CsvColumnEditorTool />;
    default:
      return null;
  }
}
