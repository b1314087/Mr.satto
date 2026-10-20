"use client";

import { DOCUMENT_TYPE_META, generateDocumentNumber, type DocumentFormState } from "@/lib/documents/types";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * レイアウトは、画面全体の幅（sm: など）ではなく、このフォーム自身の幅（コンテナクエリ）で切り替える。
 * PCでは「入力欄｜プレビュー」の2列配置のため、画面が広くてもフォームの幅は約440pxしかなく、
 * 画面幅で2列にすると、書類番号の入力欄と「自動採番」ボタンが列に収まらず、ボタンが枠の外に隠れていた。
 *
 * 帳票共通: 基本情報フォーム（書類番号・発行日・タイトル・2つ目の日付・備考）。
 * 見積書=有効期限 / 請求書=支払期限 / 注文書=納期 と、2つ目の日付の
 * ラベルだけが帳票タイプごとに異なるため、DOCUMENT_TYPE_META から取得する。
 */
export function DocumentBasicForm({
  form,
  onChange,
}: {
  form: DocumentFormState;
  onChange: (patch: Partial<DocumentFormState>) => void;
}) {
  const meta = DOCUMENT_TYPE_META[form.type];

  return (
    <div className="@container flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          書類タイトル
          <input
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={meta.defaultTitle}
            className={inputClass}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          書類番号
          <div className="flex gap-2">
            <input
              value={form.documentNumber}
              onChange={(e) => onChange({ documentNumber: e.target.value })}
              placeholder="例: 2026-0001"
              className={`${inputClass} min-w-0 flex-1`}
            />
            <button
              type="button"
              onClick={() => onChange({ documentNumber: generateDocumentNumber(form.type) })}
              className="shrink-0 whitespace-nowrap rounded-lg border border-neutral-300 px-3 py-2 text-xs text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              自動採番
            </button>
          </div>
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          発行日
          <input
            type="date"
            value={form.issueDate}
            onChange={(e) => onChange({ issueDate: e.target.value })}
            className={inputClass}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1.5 text-sm">
          {meta.secondaryDateLabel}（任意）
          <input
            type="date"
            value={form.secondaryDate}
            onChange={(e) => onChange({ secondaryDate: e.target.value })}
            className={inputClass}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        備考（任意）
        <textarea
          value={form.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          rows={3}
          placeholder="納品条件や特記事項など"
          className={`${inputClass} resize-y`}
        />
      </label>
    </div>
  );
}
