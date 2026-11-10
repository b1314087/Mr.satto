"use client";

import { useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { DocumentBasicForm } from "./shared/document-basic-form";
import { DocumentMemoImport } from "./shared/document-memo-import";
import { PartyInfoForm } from "./shared/party-info-form";
import { LineItemsEditor } from "./shared/line-items-editor";
import { TaxSettings } from "./shared/tax-settings";
import { BankAccountForm } from "./shared/bank-account-form";
import { DocumentPreview } from "./shared/document-preview";
import { DocumentActions } from "./shared/document-actions";
import {
  DOCUMENT_TYPE_META,
  createEmptyDocumentForm,
  type DocumentFormState,
  type DocumentType,
} from "@/lib/documents/types";
import { StepHeading } from "@/components/ui/step-heading";
import { AdvancedSettings } from "@/components/ui/advanced-settings";

/**
 * 帳票作成ツールの共通実装（Phase 2-C）。
 *
 * 見積書・請求書・注文書の3ツールは、この1つのコンポーネントを
 * type（DocumentType）だけ変えて使い回す。将来「納品書」「領収書」等を
 * 追加する場合も、DocumentType の union と DOCUMENT_TYPE_META に
 * 追加するだけで、この画面をそのまま再利用できる（開発指示書■29・■30）。
 *
 * 画面の流れ（開発指示書■23）:
 *   ①基本情報 → ②宛先 → ③発行者 → ④明細 → ⑤税・金額
 *     → （請求書のみ）⑥振込先 → プレビュー → PDF出力
 */
export function DocumentGeneratorTool({ type }: { type: DocumentType }) {
  const [form, setForm] = useState<DocumentFormState>(() => createEmptyDocumentForm(type));
  const meta = DOCUMENT_TYPE_META[type];

  function patch(p: Partial<DocumentFormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  const previewStep = meta.showBankAccount ? 7 : 6;
  const actionStep = meta.showBankAccount ? 8 : 7;

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
      <section className="flex flex-col gap-3">
        <StepHeading n={previewStep} as="h2">
          プレビュー
        </StepHeading>
        <div data-testid="tool-preview">
          <DocumentPreview form={form} />
        </div>
      </section>
      }
    >
      <DocumentMemoImport form={form} onApply={patch} />

      <section className="flex flex-col gap-3">
        <StepHeading n={1} as="h2">基本情報</StepHeading>
        <DocumentBasicForm form={form} onChange={patch} />
      </section>

      <section className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <div className="flex flex-col gap-3">
          <StepHeading n={2} as="h2">宛先</StepHeading>
          <PartyInfoForm
            label="宛先情報"
            party={form.recipient}
            onChange={(recipient) => patch({ recipient })}
          />
        </div>
        <div className="flex flex-col gap-3">
          <StepHeading n={3} as="h2">発行者（自社情報）</StepHeading>
          <PartyInfoForm label="発行者情報" party={form.issuer} onChange={(issuer) => patch({ issuer })} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <StepHeading n={4} as="h2">明細</StepHeading>
        <LineItemsEditor items={form.items} onChange={(items) => patch({ items })} />
      </section>

      <section className="flex flex-col gap-3">
        <StepHeading n={5} as="h2">税・金額</StepHeading>
        <TaxSettings taxRatePercent={form.taxRatePercent} taxRounding={form.taxRounding} onChange={patch} />
      </section>

      {meta.showBankAccount && (
        <section className="flex flex-col gap-3">
          <StepHeading n={6} as="h2">振込先</StepHeading>
          {/* 振込先は任意なので、ふだんは閉じておく。入力済みなら、閉じていても銀行名を出す */}
          <AdvancedSettings
            title="振込先を入れる"
            summary={form.bankAccount.bankName ? `入力済み：${form.bankAccount.bankName}` : "任意"}
            defaultOpen={Boolean(form.bankAccount.bankName || form.bankAccount.accountNumber)}
            testId="bank-account-settings"
          >
            <BankAccountForm
              bankAccount={form.bankAccount}
              onChange={(bankAccount) => patch({ bankAccount })}
            />
          </AdvancedSettings>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <StepHeading n={actionStep} as="h2">
          PDF出力
        </StepHeading>
        <DocumentActions form={form} />
      </section>
    </PreviewSplitLayout>
  );
}
