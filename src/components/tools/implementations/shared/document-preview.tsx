"use client";

import { computeDocumentTotals, formatYen, parseLineItem } from "@/lib/documents/calc";
import { DOCUMENT_TYPE_META, isBankAccountEmpty, type DocumentFormState } from "@/lib/documents/types";

/**
 * 帳票共通: 画面プレビュー。
 * PDF生成前に、入力内容がどう帳票になるかをリアルタイムに確認できるようにする
 * （開発指示書■11・■12）。PDFと完全に同一のレイアウトではないが、
 * 表示される項目・金額・並び順はPDFと一致させている。
 */
export function DocumentPreview({ form }: { form: DocumentFormState }) {
  const meta = DOCUMENT_TYPE_META[form.type];
  const items = form.items
    .filter((item) => !(item.name.trim() === "" && item.unitPrice.trim() === ""))
    .map(parseLineItem);
  const totals = computeDocumentTotals(items, form.taxRatePercent, form.taxRounding);
  const recipientName = form.recipient.companyName.trim() || form.recipient.contactName.trim();

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6 text-sm text-neutral-800 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
      <h3 className="mb-4 text-center text-lg font-bold">{form.title || meta.defaultTitle}</h3>

      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:justify-between">
        <div>
          <p className="font-medium">{recipientName || "お客様"} 御中</p>
          {recipientName && form.recipient.contactName && form.recipient.companyName && (
            <p className="text-xs text-neutral-500">{form.recipient.contactName}</p>
          )}
          {(form.recipient.postalCode || form.recipient.address) && (
            <p className="whitespace-pre-wrap text-xs text-neutral-500">
              {form.recipient.postalCode && `〒${form.recipient.postalCode} `}
              {form.recipient.address}
            </p>
          )}
        </div>

        <div className="text-xs text-neutral-500 sm:text-right">
          <p>書類番号: {form.documentNumber || "（未入力）"}</p>
          <p>発行日: {form.issueDate}</p>
          {form.secondaryDate && (
            <p>
              {meta.secondaryDateLabel}: {form.secondaryDate}
            </p>
          )}
          <div className="mt-2">
            {form.issuer.companyName && (
              <p className="font-medium text-neutral-700 dark:text-neutral-200">
                {form.issuer.companyName}
              </p>
            )}
            {form.issuer.contactName && <p>{form.issuer.contactName}</p>}
            {(form.issuer.postalCode || form.issuer.address) && (
              <p>
                {form.issuer.postalCode && `〒${form.issuer.postalCode} `}
                {form.issuer.address}
              </p>
            )}
            {form.issuer.tel && <p>TEL: {form.issuer.tel}</p>}
            {form.issuer.email && <p>{form.issuer.email}</p>}
          </div>
        </div>
      </div>

      <div className="mb-4 rounded-lg bg-neutral-50 px-4 py-3 dark:bg-neutral-900">
        <div className="flex items-center justify-between">
          <span className="font-medium">
            {form.type === "invoice" ? "ご請求金額（税込）" : "合計金額（税込）"}
          </span>
          <span className="text-lg font-bold">{formatYen(totals.total)}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800">
              <th className="py-1.5 font-normal">品名</th>
              <th className="w-12 py-1.5 text-right font-normal">数量</th>
              <th className="w-12 py-1.5 text-center font-normal">単位</th>
              <th className="w-20 py-1.5 text-right font-normal">単価</th>
              <th className="w-20 py-1.5 text-right font-normal">金額</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-center text-neutral-400">
                  明細を入力するとここに表示されます
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="whitespace-pre-wrap py-1.5">{item.name || "（品名未入力）"}</td>
                  <td className="py-1.5 text-right">{item.quantity}</td>
                  <td className="py-1.5 text-center">{item.unit}</td>
                  <td className="py-1.5 text-right">{formatYen(item.unitPrice)}</td>
                  <td className="py-1.5 text-right">{formatYen(item.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-col items-end gap-1 text-xs">
        <div className="flex w-44 justify-between">
          <span className="text-neutral-500">小計</span>
          <span>{formatYen(totals.subtotal)}</span>
        </div>
        <div className="flex w-44 justify-between">
          <span className="text-neutral-500">消費税（{form.taxRatePercent}%）</span>
          <span>{formatYen(totals.tax)}</span>
        </div>
        <div className="flex w-44 justify-between border-t border-neutral-200 pt-1 text-sm font-semibold dark:border-neutral-800">
          <span>合計</span>
          <span>{formatYen(totals.total)}</span>
        </div>
      </div>

      {meta.showBankAccount && !isBankAccountEmpty(form.bankAccount) && (
        <div className="mt-4 text-xs text-neutral-500">
          <p className="mb-1 font-medium text-neutral-700 dark:text-neutral-200">【お振込先】</p>
          <p>{[form.bankAccount.bankName, form.bankAccount.branchName].filter(Boolean).join(" ")}</p>
          <p>
            {[form.bankAccount.accountType, form.bankAccount.accountNumber].filter(Boolean).join(" ")}
          </p>
          <p>{form.bankAccount.accountHolder}</p>
        </div>
      )}

      {form.notes.trim() && (
        <div className="mt-4 text-xs text-neutral-500">
          <p className="mb-1 font-medium text-neutral-700 dark:text-neutral-200">備考</p>
          <p className="whitespace-pre-wrap">{form.notes}</p>
        </div>
      )}
    </div>
  );
}
