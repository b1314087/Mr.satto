"use client";

import { ImageCanvasTool } from "./implementations/image-canvas-tool";
import { QrGeneratorTool } from "./implementations/qr-generator-tool";
import { BusinessCardQrTool } from "./implementations/business-card-qr-tool";
import { PasswordGeneratorTool } from "./implementations/password-generator-tool";
import { CharCountTool } from "./implementations/char-count-tool";
import { JsonFormatterTool } from "./implementations/json-formatter-tool";
import { CsvFormatTool } from "./implementations/csv-format-tool";
import { PomodoroTimerTool } from "./implementations/pomodoro-timer-tool";
import { ColorPaletteTool } from "./implementations/color-palette-tool";
import { ImageSnsSizeTool } from "./implementations/image-sns-size-tool";
import { ImageCropTool } from "./implementations/image-crop-tool";
import { ImageBatchConvertTool } from "./implementations/image-batch-convert-tool";
import { PdfMergeTool } from "./implementations/pdf-merge-tool";
import { PdfSplitTool } from "./implementations/pdf-split-tool";
import { PdfDeletePagesTool } from "./implementations/pdf-delete-pages-tool";
import { PdfReorderPagesTool } from "./implementations/pdf-reorder-pages-tool";
import { PdfRotateTool } from "./implementations/pdf-rotate-tool";
import { ImageToPdfTool } from "./implementations/image-to-pdf-tool";
import { PdfToImageTool } from "./implementations/pdf-to-image-tool";

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
    default:
      return null;
  }
}
