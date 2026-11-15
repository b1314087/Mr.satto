"use client";

import { useState } from "react";
import type { DocumentFormState } from "@/lib/documents/types";
import { memoTemplate, parseDocumentMemo, type MemoImportResult } from "@/lib/documents/memo-import";
import { DocumentMemoAi, documentMemoAiEnabled } from "./document-memo-ai";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 帳票共通: メモを貼り付けて、入力欄をまとめて埋める（AIなし・ブラウザの中だけ）。
 * 書き方は「項目名：中身」を1行ずつ。読めなかった行は、行番号と理由を一覧で出す。
 * 決まった書き方でない文章（メールの文面など）は、プレミアムの「AIでメモの形に整える」で、この書き方に整えられる（任意・同意したときだけ送る）。
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
  // 最初は開いておき、使わない人は見出しを押して閉じられる
  const [open, setOpen] = useState(true);

  function handleImport() {
    const r = parseDocumentMemo(text, form, { deliveryTextField });
    if (Object.keys(r.patch).length > 0) onApply(r.patch);
    if (r.deliveryText !== null) onDeliveryText?.(r.deliveryText);
    setResult(r);
  }

  const example = memoTemplate(form.type, { deliveryTextField });

  return (
    <details
      data-testid="memo-import"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      {/* 見出し：押すと開閉する（右の矢印の向きで、開いているか閉じているかがわかる） */}
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span className="text-base font-bold text-neutral-800 dark:text-neutral-100">メモからまとめて入力</span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">任意</span>
        </span>
        <span className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="group-open:hidden">開く</span>
          <span className="hidden group-open:inline">閉じる</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 transition-transform group-open:rotate-180" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
          </svg>
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          「項目名：中身」を1行ずつ書いたメモを貼り付けると、各欄にまとめて入ります（明細は「品名, 数量, 単位, 単価」の順）。メモは外へ送らず、ブラウザの中だけで読み取ります。
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

        {documentMemoAiEnabled() && (
          <DocumentMemoAi
            docType={form.type}
            text={text}
            onMemo={(memo) => {
              setText(memo);
              setResult(null);
            }}
          />
        )}
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
