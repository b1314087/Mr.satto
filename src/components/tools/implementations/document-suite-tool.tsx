"use client";

import { useState } from "react";
import { DocumentGeneratorTool } from "./document-generator-tool";
import { QuoteOrderGeneratorTool } from "./quote-order-generator-tool";
import { Segmented } from "@/components/ui/segmented";
import { DOCUMENT_TYPE_META, createEmptyDocumentForm, type DocumentFormState, type DocumentType } from "@/lib/documents/types";
import { DOCUMENT_SUITE_MODES, type DocumentSuiteMode } from "@/lib/tools/document-suite-modes";
import { useAnnounceToolMode } from "@/lib/guides/tool-mode";

/** 書類の種類から、フォームの書類の型（見積書・注文書の一体作成は見積書の入力を使う） */
function typeOf(mode: DocumentSuiteMode): DocumentType {
  return mode === "quote-order" ? "estimate" : mode;
}

/**
 * 見積書・注文書・請求書作成（総合改修 10）。
 *
 * 作成する書類（見積書／見積書・注文書の一体作成／請求書／注文書）を選ぶと、その書類に必要な設定と入力欄が出る。
 * 書類を切り替えても、宛先・発行者・明細・税などの共通の入力は引き継ぐ（書類ごとに違う項目だけが変わる）。
 * 計算・プレビュー・PDF出力は、統合前の各ツールと同じ処理を使う（機能は減らしていない）。
 */
export function DocumentSuiteTool({ initialMode = "estimate" }: { initialMode?: DocumentSuiteMode }) {
  const [mode, setMode] = useState<DocumentSuiteMode>(initialMode);
  useAnnounceToolMode(mode);
  const [form, setForm] = useState<DocumentFormState>(() => createEmptyDocumentForm(typeOf(initialMode)));

  function changeMode(next: DocumentSuiteMode) {
    setMode(next);
    const nextType = typeOf(next);
    setForm((prev) => {
      if (prev.type === nextType) return prev;
      const prevDefault = DOCUMENT_TYPE_META[prev.type].defaultTitle;
      return {
        ...prev,
        type: nextType,
        // 書類名を変えていなければ、新しい書類の名前にする（自分で変えた名前は残す）
        title: prev.title.trim() === "" || prev.title === prevDefault ? DOCUMENT_TYPE_META[nextType].defaultTitle : prev.title,
        // 有効期限・支払期限・納期は書類ごとに意味が違うため、引き継がない
        secondaryDate: "",
      };
    });
  }

  const modeSwitch = (
    <div className="flex flex-col gap-1.5" data-testid="document-suite-mode-area">
      <p className="text-sm font-semibold text-ms-text">作成する書類</p>
      <Segmented
        ariaLabel="作成する書類"
        testId="document-suite-mode"
        value={mode}
        onChange={changeMode}
        options={DOCUMENT_SUITE_MODES.map((m) => ({ value: m.mode, label: m.label }))}
      />
      <p className="text-xs text-ms-muted">
        {DOCUMENT_SUITE_MODES.find((m) => m.mode === mode)?.description} 書類を切り替えても、宛先・発行者・明細などの入力は引き継ぎます。
      </p>
    </div>
  );

  if (mode === "quote-order") {
    return <QuoteOrderGeneratorTool key="quote-order" form={form} onFormChange={setForm} modeSwitch={modeSwitch} />;
  }
  return <DocumentGeneratorTool key={mode} type={typeOf(mode)} form={form} onFormChange={setForm} modeSwitch={modeSwitch} />;
}
