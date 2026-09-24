"use client";

import { DocumentGeneratorTool } from "./document-generator-tool";

/** 見積書作成（/tools/estimate-generator）。実装は共通のDocumentGeneratorToolに委譲する */
export function EstimateGeneratorTool() {
  return <DocumentGeneratorTool type="estimate" />;
}
