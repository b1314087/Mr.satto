"use client";

import { DocumentGeneratorTool } from "./document-generator-tool";

/**
 * 請求書作成（/tools/invoice-generator）。実装は共通のDocumentGeneratorToolに委譲する。
 *
 * 以前から存在した「簡易請求書作成」（旧 simple-invoice, coming-soon のまま
 * 未実装だった枠）は、この本格版に統合した（開発指示書■18の選択肢A）。
 * data.ts側もこのツールに一本化し、同内容のツールを2つ並べる状態にはしていない。
 */
export function InvoiceGeneratorTool() {
  return <DocumentGeneratorTool type="invoice" />;
}
