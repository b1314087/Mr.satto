/**
 * 「見積書・注文書・請求書作成」総合ツールの書類（モード）の定義（総合改修 10）。
 *
 * 見積書作成・見積書・注文書の一体作成・請求書作成・注文書作成の4ツールを1つに統合した。
 * 旧4ツールの個別URL（/tools/estimate-generator など）はそのまま残し、開くと、その書類を選んだ状態の総合ツールが出る。
 * data.ts の `mergedInto: "document-suite"` との一致は tests/tools/document-suite.spec.ts で検証している。
 */

export const DOCUMENT_SUITE_TOOL_ID = "document-suite";

export type DocumentSuiteMode = "estimate" | "quote-order" | "invoice" | "order";

export interface DocumentSuiteModeInfo {
  mode: DocumentSuiteMode;
  label: string;
  /** この書類の個別ページ（統合済みの旧ツール）のツールID */
  toolId: string;
  description: string;
}

export const DOCUMENT_SUITE_MODES: DocumentSuiteModeInfo[] = [
  { mode: "estimate", label: "見積書", toolId: "estimate-generator", description: "見積書をPDFで作ります。" },
  { mode: "quote-order", label: "見積書・注文書の一体作成", toolId: "quote-order-generator", description: "A4の1枚に、上が見積書・下が注文書を作ります。" },
  { mode: "invoice", label: "請求書", toolId: "invoice-generator", description: "振込先付きの請求書をPDFで作ります。" },
  { mode: "order", label: "注文書", toolId: "order-generator", description: "注文書をPDFで作ります。" },
];
