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
    default:
      return null;
  }
}
