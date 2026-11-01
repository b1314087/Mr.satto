"use client";

import { useState } from "react";
import type { DocumentFormState } from "@/lib/documents/types";
import { memoTemplate, parseDocumentMemo, type MemoImportResult } from "@/lib/documents/memo-import";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 帳票共通: メモを貼り付けて、入力欄をまとめて埋める（AIなし・ブラウザの中だけ）。
 * 書き方は「項目名：中身」を1行ずつ。読めなかった行は、行番号と理由を一覧で出す。
 */
export function DocumentMemoImport({
  form,
  onApply,
  deliveryTextField = false,
  onDeliveryText,
}: {
  form: DocumentFormState;
  onApply: (patch: Partial<DocumentFormState>) => void;
  /** 見積書・注文書の一体作成：「納期」を注文書の納期の欄（自由な文字）に入れる */
  deliveryTextField?: boolean;
  onDeliveryText?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<MemoImportResult | null>(null);

  function handleImport() {
    const r = parseDocumentMemo(text, form, { deliveryTextField });
    if (Object.keys(r.patch).length > 0) onApply(r.patch);
    if (r.deliveryText !== null) onDeliveryText?.(r.deliveryText);
    setResult(r);
  }

  const example = memoTemplate(form.type, { deliveryTextField });

  return (
    <details data-testid="memo-import" className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <summary className="cursor-pointer text-sm font-semibold text-neutral-700 dark:text-neutral-200">
        メモを貼り付けて、まとめて入力する（任意）
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          「項目名：中身」を1行ずつ書いたメモを貼り付けて「メモから入力する」を押すと、各欄に入ります。
          メモに書いた項目だけを書き換えます（明細を書いたときは、明細を書いた内容に置き換えます）。
          明細は「品名, 数量, 単位, 単価」の順です。メモは外へ送らず、このブラウザの中だけで読み取ります。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          aria-label="貼り付けるメモ"
          placeholder="ここにメモを貼り付けます。書き方は「記入例を入れる」で確かめられます"
          data-testid="memo-import-text"
          className={`${inputClass} resize-y font-mono text-xs leading-relaxed`}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleImport}
            disabled={text.trim() === ""}
            data-testid="memo-import-apply"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            メモから入力する
          </button>
          <button
            type="button"
            onClick={() => {
              setText(example);
              setResult(null);
            }}
            data-testid="memo-import-example"
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
          >
            記入例を入れる
          </button>
        </div>

        <div role="status" aria-live="polite" data-testid="memo-import-result" className="text-xs">
          {result && result.applied.length > 0 && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              {result.applied.length}項目を入れました：{result.applied.join("・")}
            </p>
          )}
          {result && result.applied.length === 0 && result.issues.length === 0 && (
            <p className="text-neutral-500 dark:text-neutral-400">入れる項目が見つかりませんでした。</p>
          )}
        </div>
        {result && result.issues.length > 0 && (
          <div
            data-testid="memo-import-issues"
            className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          >
            <p className="font-semibold">次の行は読めなかったため、入れていません（{result.issues.length}行）</p>
            <ul className="mt-1 flex flex-col gap-1">
              {result.issues.map((i) => (
                <li key={i.line} className="break-all">
                  {i.line}行目「{i.text}」：{i.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
