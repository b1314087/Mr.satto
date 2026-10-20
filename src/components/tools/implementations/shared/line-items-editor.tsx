"use client";

import { computeLineAmount, formatYen, parseQuantity, parseUnitPrice } from "@/lib/documents/calc";
import { createEmptyLineItem, nextLineItemId, type LineItemInput } from "@/lib/documents/types";

const cellInputClass =
  "w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 帳票共通: 明細行エディタ（追加・削除・編集、金額はリアルタイム自動計算）。
 *
 * 入力欄は1組だけ用意し、編集欄自身の幅（コンテナクエリ）に応じて並べ方を切り替える。
 *   - 幅が十分あるとき（@2xl = 672px以上）: 品名・数量・単位・単価・金額・削除が1行に並ぶ表形式
 *   - 狭いとき: 1行1カードの形式（品名は1行を使い、数量・単位・単価は3列、金額は右寄せ）
 * 画面全体の幅ではなく編集欄の幅で切り替えるのは、PCでは「入力欄｜プレビュー」の2列配置のため、
 * 画面が広くても編集欄は約440pxしかなく、画面幅で表形式にすると、単価・金額・削除ボタンが
 * 枠の外に隠れていたため。表形式とカード形式で別々の入力欄を持たず、同じ入力欄の並べ方だけを変えるので、
 * 入力欄の表示（プレースホルダー）・入力内容・動作は、どちらの幅でも同じ。（開発指示書■24）
 */
const ROW_COLUMNS = "grid-cols-3 @2xl:grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_7rem_2.5rem]";

export function LineItemsEditor({
  items,
  onChange,
}: {
  items: LineItemInput[];
  onChange: (items: LineItemInput[]) => void;
}) {
  function updateItem(id: string, patch: Partial<LineItemInput>) {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addItem() {
    onChange([...items, createEmptyLineItem(nextLineItemId())]);
  }

  function removeItem(id: string) {
    if (items.length <= 1) {
      // 最後の1行は削除せず空にするだけにする（明細0件の状態を避ける）
      onChange(items.map((item) => (item.id === id ? createEmptyLineItem(item.id) : item)));
      return;
    }
    onChange(items.filter((item) => item.id !== id));
  }

  function amountOf(item: LineItemInput): number {
    return computeLineAmount(parseQuantity(item.quantity), parseUnitPrice(item.unitPrice));
  }

  return (
    <div className="@container flex flex-col gap-3">
      {/* 見出し行（表形式のときだけ） */}
      <div
        className={`hidden gap-2 border-b border-neutral-200 pb-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400 @2xl:grid ${ROW_COLUMNS}`}
        aria-hidden="true"
      >
        <span>品名</span>
        <span>数量</span>
        <span>単位</span>
        <span>単価</span>
        <span className="text-right">金額</span>
        <span />
      </div>

      <div className="flex flex-col gap-3 @2xl:gap-0">
        {items.map((item, idx) => (
          <div
            key={item.id}
            className={`grid items-center gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800 @2xl:rounded-none @2xl:border-0 @2xl:border-b @2xl:border-neutral-100 @2xl:p-0 @2xl:py-2 @2xl:dark:border-neutral-900 ${ROW_COLUMNS}`}
          >
            <span className="col-span-2 row-start-1 text-xs text-neutral-400 @2xl:hidden">明細 {idx + 1}</span>
            <input
              value={item.name}
              onChange={(e) => updateItem(item.id, { name: e.target.value })}
              placeholder="商品名・作業内容"
              aria-label={`明細${idx + 1} 品名`}
              className={`${cellInputClass} col-span-3 row-start-2 min-w-0 @2xl:col-span-1 @2xl:row-start-auto`}
            />
            <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-neutral-400 @2xl:block">
              <span className="@2xl:hidden">数量</span>
              <input
                value={item.quantity}
                onChange={(e) => updateItem(item.id, { quantity: e.target.value })}
                inputMode="decimal"
                placeholder="1"
                aria-label={`明細${idx + 1} 数量`}
                className={`${cellInputClass} min-w-0 text-right`}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-neutral-400 @2xl:block">
              <span className="@2xl:hidden">単位</span>
              <input
                value={item.unit}
                onChange={(e) => updateItem(item.id, { unit: e.target.value })}
                placeholder="式"
                aria-label={`明細${idx + 1} 単位`}
                className={`${cellInputClass} min-w-0`}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-0.5 text-[11px] text-neutral-400 @2xl:block">
              <span className="@2xl:hidden">単価</span>
              <input
                value={item.unitPrice}
                onChange={(e) => updateItem(item.id, { unitPrice: e.target.value })}
                inputMode="decimal"
                placeholder="0"
                aria-label={`明細${idx + 1} 単価`}
                className={`${cellInputClass} min-w-0 text-right`}
              />
            </label>
            <p className="col-span-3 text-right text-sm font-medium text-neutral-700 dark:text-neutral-200 @2xl:col-span-1 @2xl:font-normal">
              <span className="mr-2 text-xs font-normal text-neutral-400 @2xl:hidden">金額</span>
              {formatYen(amountOf(item))}
            </p>
            <button
              type="button"
              onClick={() => removeItem(item.id)}
              aria-label="この明細行を削除"
              title="この明細行を削除"
              className="col-start-3 row-start-1 justify-self-end rounded p-1 text-xs text-red-500 transition-colors hover:text-red-600 @2xl:col-start-auto @2xl:row-start-auto @2xl:justify-self-center @2xl:text-sm @2xl:text-neutral-400 @2xl:hover:text-red-500"
            >
              <span className="@2xl:hidden">削除</span>
              <span className="hidden @2xl:inline" aria-hidden="true">
                ✕
              </span>
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addItem}
        className="w-fit rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        ＋ 明細を追加
      </button>
    </div>
  );
}
