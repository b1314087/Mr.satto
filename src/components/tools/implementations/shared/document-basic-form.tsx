"use client";

import { useState, useSyncExternalStore } from "react";
import { DOCUMENT_TYPE_META, type DocumentFormState } from "@/lib/documents/types";
import {
  DOCUMENT_SERIAL_MAX,
  DOCUMENT_SERIAL_OPTIONS,
  buildDocumentNumber,
  formatSerial,
  parseSerialStore,
  readSerialStoreRaw,
  recordSerial,
  serialKey,
  subscribeSerialStore,
  suggestNextSerial,
  writeSerialStore,
  type DocumentNumberTailMode,
} from "@/lib/documents/document-number";

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
 *
 * 書類番号の「自動採番」は「記号-発行日-末尾」。末尾は、通し番号（プルダウンで選ぶ。
 * このブラウザで前回使った番号の次を最初から選んでおく）か、作成した時刻（時分）を選べる。
 */
export function DocumentBasicForm({
  form,
  onChange,
}: {
  form: DocumentFormState;
  onChange: (patch: Partial<DocumentFormState>) => void;
}) {
  const meta = DOCUMENT_TYPE_META[form.type];
  const [tailMode, setTailMode] = useState<DocumentNumberTailMode>("serial");
  // 利用者が選んだ通し番号。種類・発行日が変わったら、選び直し（提案の番号に戻す）
  const [picked, setPicked] = useState<{ key: string; serial: number } | null>(null);
  // サーバーでの表示は「記録なし」として描き、ブラウザで記録を読む（表示のずれを防ぐ）
  const storeRaw = useSyncExternalStore(subscribeSerialStore, readSerialStoreRaw, () => null);
  const store = parseSerialStore(storeRaw);
  const key = serialKey(form.type, form.issueDate);
  const lastUsed = store[key] ?? 0;
  const suggested = suggestNextSerial(store, key);
  const serial = picked && picked.key === key ? picked.serial : suggested;

  function applyNumber() {
    const documentNumber = buildDocumentNumber({ type: form.type, issueDate: form.issueDate, mode: tailMode, serial });
    onChange({ documentNumber });
    if (tailMode === "serial") {
      writeSerialStore(recordSerial(store, key, serial));
      setPicked(null);
    }
  }

  return (
    <div className="@container flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm @xl:col-span-2">
          書類タイトル
          <input
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={meta.defaultTitle}
            className={inputClass}
          />
        </label>

        <div className="flex min-w-0 flex-col gap-2 @xl:col-span-2">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            書類番号
            <div className="flex gap-2">
              <input
                value={form.documentNumber}
                onChange={(e) => onChange({ documentNumber: e.target.value })}
                placeholder="例: INV-20261101-001"
                data-testid="document-number"
                className={`${inputClass} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={applyNumber}
                data-testid="document-number-apply"
                className="shrink-0 whitespace-nowrap rounded-lg border border-neutral-300 px-3 py-2 text-xs text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
              >
                自動採番
              </button>
            </div>
          </label>

          <fieldset className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-600 dark:text-neutral-300">
            <legend className="sr-only">自動採番の末尾の付け方</legend>
            <span aria-hidden="true">末尾：</span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`doc-number-tail-${form.type}`}
                checked={tailMode === "serial"}
                onChange={() => setTailMode("serial")}
                data-testid="document-number-mode-serial"
              />
              通し番号
            </label>
            {tailMode === "serial" && (
              <select
                aria-label="通し番号"
                value={serial}
                onChange={(e) => setPicked({ key, serial: Number(e.target.value) })}
                data-testid="document-number-serial"
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                {DOCUMENT_SERIAL_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {formatSerial(n)}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`doc-number-tail-${form.type}`}
                checked={tailMode === "time"}
                onChange={() => setTailMode("time")}
                data-testid="document-number-mode-time"
              />
              時刻（時分）
            </label>
          </fieldset>
          <p data-testid="document-number-hint" className="text-xs text-neutral-500 dark:text-neutral-400">
            {tailMode === "time"
              ? "「自動採番」を押した時刻を末尾に入れます（例: 15時13分 → 1513）。日付は発行日から取ります。"
              : lastUsed > 0
                ? `この発行日の${meta.label}は、このブラウザで ${formatSerial(lastUsed)} まで使いました。次の番号を選んでいます。${
                    lastUsed >= DOCUMENT_SERIAL_MAX ? `（一覧は ${formatSerial(DOCUMENT_SERIAL_MAX)} までです。それより先は番号の欄を直接書き換えてください）` : ""
                  }`
                : "日付は発行日から。使った番号はこのブラウザに覚え、次回は続きを選びます。"}
          </p>
        </div>

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
