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
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";

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
export function DocumentGeneratorTool({
  type,
  form: controlledForm,
  onFormChange,
  modeSwitch,
}: {
  type: DocumentType;
  /** 総合改修 10：「見積書・注文書・請求書作成」で書類を切り替えても、入力を引き継ぐため、外から渡せるようにした */
  form?: DocumentFormState;
  onFormChange?: (updater: (prev: DocumentFormState) => DocumentFormState) => void;
  /** 書類の切り替え（設定の一番上に置く） */
  modeSwitch?: React.ReactNode;
}) {
  const [ownForm, setOwnForm] = useState<DocumentFormState>(() => createEmptyDocumentForm(type));
  const form = controlledForm ?? ownForm;
  const meta = DOCUMENT_TYPE_META[type];

  function patch(p: Partial<DocumentFormState>) {
    if (onFormChange) onFormChange((prev) => ({ ...prev, ...p }));
    else setOwnForm((prev) => ({ ...prev, ...p }));
  }

  const previewStep = meta.showBankAccount ? 7 : 6;
  const actionStep = meta.showBankAccount ? 8 : 7;

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      // PDF出力は、プレビューを見てから行う（スマホでもプレビューの下に出す）
      after={
        <section className="flex flex-col gap-3">
          <StepHeading n={actionStep} as="h2">
            PDF出力
          </StepHeading>
          <DocumentActions form={form} />
        </section>
      }
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
      {modeSwitch}
      <DocumentMemoImport form={form} onApply={patch} />

      {/* 総合改修 3-1・10：設定は内容ごとの折りたたみ（全ツール共通の見た目） */}
      <SettingsStack testId="document-settings">
        <SettingsSection n={1} title="基本情報" summary={[form.title || meta.defaultTitle, form.issueDate].filter(Boolean).join("・")}>
          <DocumentBasicForm form={form} onChange={patch} />
        </SettingsSection>

        <SettingsSection n={2} title="宛先" summary={form.recipient.companyName || form.recipient.contactName || "未入力"}>
          <PartyInfoForm label="宛先情報" party={form.recipient} onChange={(recipient) => patch({ recipient })} />
        </SettingsSection>

        <SettingsSection n={3} title="発行者（自社情報）" summary={form.issuer.companyName || form.issuer.contactName || "未入力"}>
          <PartyInfoForm label="発行者情報" party={form.issuer} onChange={(issuer) => patch({ issuer })} />
        </SettingsSection>

        <SettingsSection n={4} title="明細" summary={`${form.items.filter((it) => it.name.trim() !== "").length}件`}>
          <LineItemsEditor items={form.items} onChange={(items) => patch({ items })} />
        </SettingsSection>

        <SettingsSection n={5} title="税・金額" summary={`消費税${form.taxRatePercent}%`}>
          <TaxSettings taxRatePercent={form.taxRatePercent} taxRounding={form.taxRounding} onChange={patch} />
        </SettingsSection>

        {meta.showBankAccount && (
          <SettingsSection
            n={6}
            title="振込先（任意）"
            summary={form.bankAccount.bankName ? `入力済み：${form.bankAccount.bankName}` : "任意"}
            defaultOpen={Boolean(form.bankAccount.bankName || form.bankAccount.accountNumber)}
            testId="bank-account-settings"
          >
            <BankAccountForm bankAccount={form.bankAccount} onChange={(bankAccount) => patch({ bankAccount })} />
          </SettingsSection>
        )}
      </SettingsStack>
    </PreviewSplitLayout>
  );
}
