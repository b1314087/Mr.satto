"use client";

import dynamic from "next/dynamic";
import { OcrTool } from "./implementations/ocr-tool";
import { ToolLoading } from "./tool-loading";

/**
 * Phase 7 軽量化：各ツール実装を next/dynamic() 経由の動的importに変更した。
 *
 * 変更前は、当時の全ツール（46個）を静的importしていたため、/tools/[tool] は単一の
 * 動的ルートである関係上、Next.jsのバンドラーは「どのツールIDが来ても
 * 対応できるように」全ツールの実装コードを1つの共有チャンクへまとめて
 * しまっていた（実測: 本番ビルドで約1.4MBの単一チャンクとなり、二次元コード
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
  import("./implementations/image-canvas-tool").then((m) => m.ImageCanvasTool),
  { loading: ToolLoading }
);
const QrGeneratorTool = dynamic(() =>
  import("./implementations/qr-generator-tool").then((m) => m.QrGeneratorTool),
  { loading: ToolLoading }
);
const BusinessCardQrTool = dynamic(() =>
  import("./implementations/business-card-qr-tool").then((m) => m.BusinessCardQrTool),
  { loading: ToolLoading }
);
const PasswordGeneratorTool = dynamic(() =>
  import("./implementations/password-generator-tool").then((m) => m.PasswordGeneratorTool),
  { loading: ToolLoading }
);
const CharCountTool = dynamic(() =>
  import("./implementations/char-count-tool").then((m) => m.CharCountTool),
  { loading: ToolLoading }
);
const JsonFormatterTool = dynamic(() =>
  import("./implementations/json-formatter-tool").then((m) => m.JsonFormatterTool),
  { loading: ToolLoading }
);
const CsvFormatTool = dynamic(() =>
  import("./implementations/csv-format-tool").then((m) => m.CsvFormatTool),
  { loading: ToolLoading }
);
const PomodoroTimerTool = dynamic(() =>
  import("./implementations/pomodoro-timer-tool").then((m) => m.PomodoroTimerTool),
  { loading: ToolLoading }
);
const UnitConverterTool = dynamic(() =>
  import("./implementations/unit-converter-tool").then((m) => m.UnitConverterTool),
  { loading: ToolLoading }
);
const GradientGeneratorTool = dynamic(() =>
  import("./implementations/gradient-generator-tool").then((m) => m.GradientGeneratorTool),
  { loading: ToolLoading }
);
const BackgroundRemoverTool = dynamic(() =>
  import("./implementations/background-remover-tool").then((m) => m.BackgroundRemoverTool),
  { loading: ToolLoading }
);
const PdfPasswordProtectTool = dynamic(() =>
  import("./implementations/pdf-password-protect-tool").then((m) => m.PdfPasswordProtectTool),
  { loading: ToolLoading }
);
const ColorPaletteTool = dynamic(() =>
  import("./implementations/color-palette-tool").then((m) => m.ColorPaletteTool),
  { loading: ToolLoading }
);
const ImageSnsSizeTool = dynamic(() =>
  import("./implementations/image-sns-size-tool").then((m) => m.ImageSnsSizeTool),
  { loading: ToolLoading }
);
const ImageCropTool = dynamic(() =>
  import("./implementations/image-crop-tool").then((m) => m.ImageCropTool),
  { loading: ToolLoading }
);
const ImageBatchConvertTool = dynamic(() =>
  import("./implementations/image-batch-convert-tool").then((m) => m.ImageBatchConvertTool),
  { loading: ToolLoading }
);
// JPG変換・PNG変換・WebP変換は、画像一括変換と同じ共通画面（出力形式の初期選択だけが違う）
const ImageRotateFlipTool = dynamic(() =>
  import("./implementations/image-rotate-flip-tool").then((m) => m.ImageRotateFlipTool),
  { loading: ToolLoading }
);
const ImageFormatConvertTool = dynamic(() =>
  import("./implementations/image-format-convert-tool").then((m) => m.ImageFormatConvertTool),
  { loading: ToolLoading }
);
// PDF編集（結合・分割・ページ削除・ページ抽出・並び替え・回転）は、1つの共通画面（操作の初期選択だけが違う）
const PdfEditTool = dynamic(() =>
  import("./implementations/pdf-edit-tool").then((m) => m.PdfEditTool),
  { loading: ToolLoading }
);
// PDF修正（記入・注釈・白消し／ページ番号／透かし）。PDF編集の処理結果の引き継ぎ先（工程12）
const PdfFixTool = dynamic(() =>
  import("./implementations/pdf-fix-tool").then((m) => m.PdfFixTool),
  { loading: ToolLoading }
);
const ImageToPdfTool = dynamic(() =>
  import("./implementations/image-to-pdf-tool").then((m) => m.ImageToPdfTool),
  { loading: ToolLoading }
);
const PdfToImageTool = dynamic(() =>
  import("./implementations/pdf-to-image-tool").then((m) => m.PdfToImageTool),
  { loading: ToolLoading }
);
const FileBulkRenameTool = dynamic(() =>
  import("./implementations/file-bulk-rename-tool").then((m) => m.FileBulkRenameTool),
  { loading: ToolLoading }
);
const FileSequentialRenameTool = dynamic(() =>
  import("./implementations/file-sequential-rename-tool").then((m) => m.FileSequentialRenameTool),
  { loading: ToolLoading }
);
const FileZipTool = dynamic(() =>
  import("./implementations/file-zip-tool").then((m) => m.FileZipTool),
  { loading: ToolLoading }
);
const ExcelCsvConvertTool = dynamic(() =>
  import("./implementations/excel-csv-convert-tool").then((m) => m.ExcelCsvConvertTool),
  { loading: ToolLoading }
);
const CsvMergeTool = dynamic(() =>
  import("./implementations/csv-merge-tool").then((m) => m.CsvMergeTool),
  { loading: ToolLoading }
);
const ExcelMergeTool = dynamic(() =>
  import("./implementations/excel-merge-tool").then((m) => m.ExcelMergeTool),
  { loading: ToolLoading }
);
const CsvDedupeTool = dynamic(() =>
  import("./implementations/csv-dedupe-tool").then((m) => m.CsvDedupeTool),
  { loading: ToolLoading }
);
const CsvReplaceTool = dynamic(() =>
  import("./implementations/csv-replace-tool").then((m) => m.CsvReplaceTool),
  { loading: ToolLoading }
);
const PdfCompressTool = dynamic(() =>
  import("./implementations/pdf-compress-tool").then((m) => m.PdfCompressTool),
  { loading: ToolLoading }
);
const PdfToTextTool = dynamic(() =>
  import("./implementations/pdf-to-text-tool").then((m) => m.PdfToTextTool),
  { loading: ToolLoading }
);
const EstimateGeneratorTool = dynamic(() =>
  import("./implementations/estimate-generator-tool").then((m) => m.EstimateGeneratorTool),
  { loading: ToolLoading }
);
const QuoteOrderGeneratorTool = dynamic(() =>
  import("./implementations/quote-order-generator-tool").then((m) => m.QuoteOrderGeneratorTool),
  { loading: ToolLoading }
);
const InvoiceGeneratorTool = dynamic(() =>
  import("./implementations/invoice-generator-tool").then((m) => m.InvoiceGeneratorTool),
  { loading: ToolLoading }
);
const OrderGeneratorTool = dynamic(() =>
  import("./implementations/order-generator-tool").then((m) => m.OrderGeneratorTool),
  { loading: ToolLoading }
);
const PdfToExcelTool = dynamic(() =>
  import("./implementations/pdf-to-excel-tool").then((m) => m.PdfToExcelTool),
  { loading: ToolLoading }
);
const PdfToWordTool = dynamic(() =>
  import("./implementations/pdf-to-word-tool").then((m) => m.PdfToWordTool),
  { loading: ToolLoading }
);
const WordToPdfTool = dynamic(() =>
  import("./implementations/word-to-pdf-tool").then((m) => m.WordToPdfTool),
  { loading: ToolLoading }
);
const ExcelToPdfTool = dynamic(() =>
  import("./implementations/excel-to-pdf-tool").then((m) => m.ExcelToPdfTool),
  { loading: ToolLoading }
);
const PdfAddPageNumbersTool = dynamic(() =>
  import("./implementations/pdf-add-page-numbers-tool").then((m) => m.PdfAddPageNumbersTool),
  { loading: ToolLoading }
);
const PdfWatermarkTool = dynamic(() =>
  import("./implementations/pdf-watermark-tool").then((m) => m.PdfWatermarkTool),
  { loading: ToolLoading }
);
const ImageFlipTool = dynamic(() =>
  import("./implementations/image-flip-tool").then((m) => m.ImageFlipTool),
  { loading: ToolLoading }
);
const ImageGrayscaleTool = dynamic(() =>
  import("./implementations/image-grayscale-tool").then((m) => m.ImageGrayscaleTool),
  { loading: ToolLoading }
);
const ImageAdjustTool = dynamic(() =>
  import("./implementations/image-adjust-tool").then((m) => m.ImageAdjustTool),
  { loading: ToolLoading }
);
const CsvJsonConvertTool = dynamic(() =>
  import("./implementations/csv-json-convert-tool").then((m) => m.CsvJsonConvertTool),
  { loading: ToolLoading }
);
const TextLineCleanerTool = dynamic(() =>
  import("./implementations/text-line-cleaner-tool").then((m) => m.TextLineCleanerTool),
  { loading: ToolLoading }
);
const FileUnzipTool = dynamic(() =>
  import("./implementations/file-unzip-tool").then((m) => m.FileUnzipTool),
  { loading: ToolLoading }
);
const FileHashTool = dynamic(() =>
  import("./implementations/file-hash-tool").then((m) => m.FileHashTool),
  { loading: ToolLoading }
);
const PdfResizePagesTool = dynamic(() =>
  import("./implementations/pdf-resize-pages-tool").then((m) => m.PdfResizePagesTool),
  { loading: ToolLoading }
);
const PdfMetadataRemoveTool = dynamic(() =>
  import("./implementations/pdf-metadata-remove-tool").then((m) => m.PdfMetadataRemoveTool),
  { loading: ToolLoading }
);
const PdfCropPagesTool = dynamic(() =>
  import("./implementations/pdf-crop-pages-tool").then((m) => m.PdfCropPagesTool),
  { loading: ToolLoading }
);
const ImageMetadataRemoveTool = dynamic(() =>
  import("./implementations/image-metadata-remove-tool").then((m) => m.ImageMetadataRemoveTool),
  { loading: ToolLoading }
);
const ImageWatermarkTool = dynamic(() =>
  import("./implementations/image-watermark-tool").then((m) => m.ImageWatermarkTool),
  { loading: ToolLoading }
);
const ImageLayoutTool = dynamic(() =>
  import("./implementations/image-layout-tool").then((m) => m.ImageLayoutTool),
  { loading: ToolLoading }
);
const ImagePassportPhotoTool = dynamic(() =>
  import("./implementations/image-passport-photo-tool").then((m) => m.ImagePassportPhotoTool),
  { loading: ToolLoading }
);
const ImageMergeTool = dynamic(() =>
  import("./implementations/image-merge-tool").then((m) => m.ImageMergeTool),
  { loading: ToolLoading }
);
const ImagePaddingTextTool = dynamic(() =>
  import("./implementations/image-padding-text-tool").then((m) => m.ImagePaddingTextTool),
  { loading: ToolLoading }
);
const ImageTileSplitTool = dynamic(() =>
  import("./implementations/image-tile-split-tool").then((m) => m.ImageTileSplitTool),
  { loading: ToolLoading }
);
const ImageMosaicTool = dynamic(() =>
  import("./implementations/image-mosaic-tool").then((m) => m.ImageMosaicTool),
  { loading: ToolLoading }
);
const TextCaseConverterTool = dynamic(() =>
  import("./implementations/text-case-converter-tool").then((m) => m.TextCaseConverterTool),
  { loading: ToolLoading }
);
const CsvColumnEditorTool = dynamic(() =>
  import("./implementations/csv-column-editor-tool").then((m) => m.CsvColumnEditorTool),
  { loading: ToolLoading }
);
const VideoConvertTool = dynamic(() =>
  import("./implementations/video-convert-tool").then((m) => m.VideoConvertTool),
  { loading: ToolLoading }
);
const VideoCompressTool = dynamic(() =>
  import("./implementations/video-compress-tool").then((m) => m.VideoCompressTool),
  { loading: ToolLoading }
);
const VideoResizeTool = dynamic(() =>
  import("./implementations/video-resize-tool").then((m) => m.VideoResizeTool),
  { loading: ToolLoading }
);
const VideoFrameRateTool = dynamic(() =>
  import("./implementations/video-frame-rate-tool").then((m) => m.VideoFrameRateTool),
  { loading: ToolLoading }
);
const VideoH264Tool = dynamic(() =>
  import("./implementations/video-h264-tool").then((m) => m.VideoH264Tool),
  { loading: ToolLoading }
);
const VideoThumbnailTool = dynamic(() =>
  import("./implementations/video-thumbnail-tool").then((m) => m.VideoThumbnailTool),
  { loading: ToolLoading }
);
const VideoMetadataRemoveTool = dynamic(() =>
  import("./implementations/video-metadata-remove-tool").then((m) => m.VideoMetadataRemoveTool),
  { loading: ToolLoading }
);
// 音声ツール（mediabunny。MP3書き出し時のみ LAME/WASM を動的に読み込む）
const AudioConvertTool = dynamic(() =>
  import("./implementations/audio-convert-tool").then((m) => m.AudioConvertTool),
  { loading: ToolLoading }
);
const AudioExtractTool = dynamic(() =>
  import("./implementations/audio-extract-tool").then((m) => m.AudioExtractTool),
  { loading: ToolLoading }
);
const AudioTrimTool = dynamic(() =>
  import("./implementations/audio-trim-tool").then((m) => m.AudioTrimTool),
  { loading: ToolLoading }
);
const AudioMergeTool = dynamic(() =>
  import("./implementations/audio-merge-tool").then((m) => m.AudioMergeTool),
  { loading: ToolLoading }
);
const AudioVolumeTool = dynamic(() =>
  import("./implementations/audio-volume-tool").then((m) => m.AudioVolumeTool),
  { loading: ToolLoading }
);
const AudioCompressTool = dynamic(() =>
  import("./implementations/audio-compress-tool").then((m) => m.AudioCompressTool),
  { loading: ToolLoading }
);
// Phase 11: OCR(tesseract.js)を内部で使うため、既存のOCRツールと同様の
// チャンク境界問題が起きないか実機検証したが、こちらは問題なく動作した
// （OCRツール自体を静的importのまま保護する既存の対応方針は変更していない）。
const FilledPdfToExcelTool = dynamic(() =>
  import("./implementations/filled-pdf-to-excel-tool").then((m) => m.FilledPdfToExcelTool),
  { loading: ToolLoading }
);
const FormToIndividualPdfsTool = dynamic(() =>
  import("./implementations/form-to-individual-pdfs-tool").then((m) => m.FormToIndividualPdfsTool),
  { loading: ToolLoading }
);
const PdfFillAnnotateTool = dynamic(() =>
  import("./implementations/pdf-fill-annotate-tool").then((m) => m.PdfFillAnnotateTool),
  { loading: ToolLoading }
);
const ElectronicStampGeneratorTool = dynamic(() =>
  import("./implementations/electronic-stamp-generator-tool").then((m) => m.ElectronicStampGeneratorTool),
  { loading: ToolLoading }
);

// 次工程・軽量便利ツール一括追加（Tool 1〜10）
const DateWeekdayTool = dynamic(() =>
  import("./implementations/date-weekday-tool").then((m) => m.DateWeekdayTool),
  { loading: ToolLoading }
);
const TimeCalculatorTool = dynamic(() =>
  import("./implementations/time-calculator-tool").then((m) => m.TimeCalculatorTool),
  { loading: ToolLoading }
);
const NumberFormatTool = dynamic(() =>
  import("./implementations/number-format-tool").then((m) => m.NumberFormatTool),
  { loading: ToolLoading }
);
const ExcelTransposeTool = dynamic(() =>
  import("./implementations/excel-transpose-tool").then((m) => m.ExcelTransposeTool),
  { loading: ToolLoading }
);
const ExcelBlankRemoveTool = dynamic(() =>
  import("./implementations/excel-blank-remove-tool").then((m) => m.ExcelBlankRemoveTool),
  { loading: ToolLoading }
);
const ExcelReplaceTool = dynamic(() =>
  import("./implementations/excel-replace-tool").then((m) => m.ExcelReplaceTool),
  { loading: ToolLoading }
);
const ExcelMergeCenterTool = dynamic(() =>
  import("./implementations/excel-merge-center-tool").then((m) => m.ExcelMergeCenterTool),
  { loading: ToolLoading }
);
const ExcelDateShiftTool = dynamic(() =>
  import("./implementations/excel-date-shift-tool").then((m) => m.ExcelDateShiftTool),
  { loading: ToolLoading }
);
const WordParagraphCleanupTool = dynamic(() =>
  import("./implementations/word-paragraph-cleanup-tool").then((m) => m.WordParagraphCleanupTool),
  { loading: ToolLoading }
);
const WordRenumberTool = dynamic(() =>
  import("./implementations/word-renumber-tool").then((m) => m.WordRenumberTool),
  { loading: ToolLoading }
);

// 次工程・印刷帳票4ツール追加フェーズ
const ExcelLabelTool = dynamic(() =>
  import("./implementations/excel-label-tool").then((m) => m.ExcelLabelTool),
  { loading: ToolLoading }
);
const EnvelopeAddressTool = dynamic(() =>
  import("./implementations/envelope-address-tool").then((m) => m.EnvelopeAddressTool),
  { loading: ToolLoading }
);
const TicketVoucherTool = dynamic(() =>
  import("./implementations/ticket-voucher-tool").then((m) => m.TicketVoucherTool),
  { loading: ToolLoading }
);
const RosterTemplateTool = dynamic(() =>
  import("./implementations/roster-template-tool").then((m) => m.RosterTemplateTool),
  { loading: ToolLoading }
);

// 年度カレンダー作成（日本の祝日入りのExcel・PDF）
const FiscalCalendarTool = dynamic(() =>
  import("./implementations/fiscal-calendar-tool").then((m) => m.FiscalCalendarTool),
  { loading: ToolLoading }
);
const SequenceGeneratorTool = dynamic(() =>
  import("./implementations/sequence-generator-tool").then((m) => m.SequenceGeneratorTool),
  { loading: ToolLoading }
);
// PowerPoint白黒反転（.pptxの背景・文字・白黒画像を反転）
const PptxInvertTool = dynamic(() =>
  import("./implementations/pptx-invert-tool").then((m) => m.PptxInvertTool),
  { loading: ToolLoading }
);

const IMAGE_TOOL_IDS = new Set([
  "image-resize",
  "image-compress",
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
    case "image-rotate-flip":
    case "image-rotate":
      return <ImageRotateFlipTool initialMode="rotate" />;
    case "image-format-convert":
    case "image-jpg-convert":
      return <ImageFormatConvertTool initialFormat="image/jpeg" />;
    case "image-png-convert":
      return <ImageFormatConvertTool initialFormat="image/png" />;
    case "image-webp-convert":
      return <ImageFormatConvertTool initialFormat="image/webp" />;
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
    case "unit-converter":
      return <UnitConverterTool />;
    case "gradient-generator":
      return <GradientGeneratorTool />;
    case "background-remover":
      return <BackgroundRemoverTool />;
    case "pdf-password-protect":
      return <PdfPasswordProtectTool />;
    case "color-palette-generator":
      return <ColorPaletteTool />;
    case "image-sns-size":
      return <ImageSnsSizeTool />;
    case "image-crop":
      return <ImageCropTool />;
    case "image-batch-convert":
      return <ImageBatchConvertTool />;
    case "pdf-edit":
      return <PdfEditTool initialMode="merge" />;
    case "pdf-fix":
      return <PdfFixTool />;
    case "pdf-merge":
      return <PdfEditTool initialMode="merge" />;
    case "pdf-split":
      return <PdfEditTool initialMode="split" />;
    case "pdf-delete-pages":
      return <PdfEditTool initialMode="delete" />;
    case "pdf-reorder-pages":
      return <PdfEditTool initialMode="reorder" />;
    case "pdf-rotate":
      return <PdfEditTool initialMode="rotate" />;
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
    case "excel-csv-convert":
      return <ExcelCsvConvertTool initialMode="excel-to-csv" />;
    case "csv-to-excel":
      return <ExcelCsvConvertTool initialMode="csv-to-excel" />;
    case "excel-to-csv":
      return <ExcelCsvConvertTool initialMode="excel-to-csv" />;
    case "csv-merge":
      return <CsvMergeTool />;
    case "excel-merge":
      return <ExcelMergeTool />;
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
    case "quote-order-generator":
      return <QuoteOrderGeneratorTool />;
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
      return <PdfEditTool initialMode="extract" />;
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
    case "csv-json-convert":
      return <CsvJsonConvertTool initialMode="csv-to-json" />;
    case "csv-to-json":
      return <CsvJsonConvertTool initialMode="csv-to-json" />;
    case "json-to-csv":
      return <CsvJsonConvertTool initialMode="json-to-csv" />;
    case "text-line-cleaner":
      return <TextLineCleanerTool />;
    case "file-unzip":
      return <FileUnzipTool />;
    case "file-hash":
      return <FileHashTool />;
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
    case "image-layout":
      return <ImageLayoutTool />;
    case "image-passport-photo":
      return <ImagePassportPhotoTool />;
    case "image-merge":
      return <ImageMergeTool />;
    case "image-padding-text":
      return <ImagePaddingTextTool />;
    case "image-tile-split":
      return <ImageTileSplitTool />;
    case "image-mosaic":
      return <ImageMosaicTool />;
    case "text-case-converter":
      return <TextCaseConverterTool />;
    case "csv-column-editor":
      return <CsvColumnEditorTool />;
    case "video-convert":
      return <VideoConvertTool />;
    case "video-compress":
      return <VideoCompressTool />;
    case "video-resize":
      return <VideoResizeTool />;
    case "video-frame-rate":
      return <VideoFrameRateTool />;
    case "video-h264":
      return <VideoH264Tool />;
    case "video-thumbnail":
      return <VideoThumbnailTool />;
    case "video-metadata-remove":
      return <VideoMetadataRemoveTool />;
    case "audio-convert":
      return <AudioConvertTool />;
    case "audio-extract":
      return <AudioExtractTool />;
    case "audio-trim":
      return <AudioTrimTool />;
    case "audio-merge":
      return <AudioMergeTool />;
    case "audio-volume":
      return <AudioVolumeTool />;
    case "audio-compress":
      return <AudioCompressTool />;
    case "filled-pdf-to-excel":
      return <FilledPdfToExcelTool />;
    case "form-to-individual-pdfs":
      return <FormToIndividualPdfsTool />;
    case "pdf-fill-annotate":
      return <PdfFillAnnotateTool />;
    case "electronic-stamp-generator":
      return <ElectronicStampGeneratorTool />;
    case "date-weekday-tool":
      return <DateWeekdayTool />;
    case "time-calculator":
      return <TimeCalculatorTool />;
    case "number-format":
      return <NumberFormatTool />;
    case "excel-transpose":
      return <ExcelTransposeTool />;
    case "excel-blank-remove":
      return <ExcelBlankRemoveTool />;
    case "excel-replace":
      return <ExcelReplaceTool />;
    case "excel-merge-center":
      return <ExcelMergeCenterTool />;
    case "excel-date-shift":
      return <ExcelDateShiftTool />;
    case "word-paragraph-cleanup":
      return <WordParagraphCleanupTool />;
    case "word-renumber":
      return <WordRenumberTool />;
    case "excel-label":
      return <ExcelLabelTool />;
    case "envelope-address":
      return <EnvelopeAddressTool />;
    case "ticket-voucher":
      return <TicketVoucherTool />;
    case "roster-template":
      return <RosterTemplateTool />;
    case "fiscal-calendar":
      return <FiscalCalendarTool />;
    case "sequence-generator":
      return <SequenceGeneratorTool />;
    case "pptx-invert":
      return <PptxInvertTool />;
    default:
      return null;
  }
}
