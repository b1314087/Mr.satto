"use client";

import { DocumentGeneratorTool } from "./document-generator-tool";

/** 注文書作成（/tools/order-generator）。実装は共通のDocumentGeneratorToolに委譲する */
export function OrderGeneratorTool() {
  return <DocumentGeneratorTool type="order" />;
}
