"use client";

import { useState } from "react";
import { DocumentBasicForm } from "./shared/document-basic-form";
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

  const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  const previewStep = meta.showBankAccount ? CIRCLED[6] : CIRCLED[5];
  const actionStep = meta.showBankAccount ? CIRCLED[7] : CIRCLED[6];

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        入力した内容はこの画面上で{meta.label}のPDFを作成するためだけに使われます。サーバーへの送信・保存は行われず、画面を閉じると内容は消えます。
      </p>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">① 基本情報</h2>
        <DocumentBasicForm form={form} onChange={patch} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">② 宛先</h2>
          <PartyInfoForm
            label="宛先情報"
            party={form.recipient}
            onChange={(recipient) => patch({ recipient })}
          />
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            ③ 発行者（自社情報）
          </h2>
          <PartyInfoForm label="発行者情報" party={form.issuer} onChange={(issuer) => patch({ issuer })} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">④ 明細</h2>
        <LineItemsEditor items={form.items} onChange={(items) => patch({ items })} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">⑤ 税・金額</h2>
        <TaxSettings taxRatePercent={form.taxRatePercent} taxRounding={form.taxRounding} onChange={patch} />
      </section>

      {meta.showBankAccount && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            ⑥ 振込先
          </h2>
          <BankAccountForm
            bankAccount={form.bankAccount}
            onChange={(bankAccount) => patch({ bankAccount })}
          />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          {previewStep} プレビュー
        </h2>
        <DocumentPreview form={form} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          {actionStep} PDF出力
        </h2>
        <DocumentActions form={form} />
      </section>
    </div>
  );
}
