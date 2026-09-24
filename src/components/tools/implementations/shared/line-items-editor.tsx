"use client";

import { computeLineAmount, formatYen, parseQuantity, parseUnitPrice } from "@/lib/documents/calc";
import { createEmptyLineItem, nextLineItemId, type LineItemInput } from "@/lib/documents/types";

const cellInputClass =
  "w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/**
 * 帳票共通: 明細行エディタ（追加・削除・編集、金額はリアルタイム自動計算）。
 *
 * PC（sm以上）ではテーブル形式、スマートフォンでは1行1カードの形式にして、
 * 明細表を無理に横長のまま縮小しないようにする（開発指示書■24）。
 */
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
    <div className="flex flex-col gap-3">
      {/* PC・タブレット: テーブル形式 */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <th className="py-2 pr-2 font-normal">品名</th>
              <th className="w-20 px-2 font-normal">数量</th>
              <th className="w-20 px-2 font-normal">単位</th>
              <th className="w-28 px-2 font-normal">単価</th>
              <th className="w-28 px-2 text-right font-normal">金額</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-2 pr-2">
                  <input
                    value={item.name}
                    onChange={(e) => updateItem(item.id, { name: e.target.value })}
                    placeholder="商品名・作業内容"
                    className={cellInputClass}
                  />
                </td>
                <td className="px-2">
                  <input
                    value={item.quantity}
                    onChange={(e) => updateItem(item.id, { quantity: e.target.value })}
                    inputMode="decimal"
                    placeholder="1"
                    className={`${cellInputClass} text-right`}
                  />
                </td>
                <td className="px-2">
                  <input
                    value={item.unit}
                    onChange={(e) => updateItem(item.id, { unit: e.target.value })}
                    placeholder="式"
                    className={cellInputClass}
                  />
                </td>
                <td className="px-2">
                  <input
                    value={item.unitPrice}
                    onChange={(e) => updateItem(item.id, { unitPrice: e.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    className={`${cellInputClass} text-right`}
                  />
                </td>
                <td className="px-2 text-right text-sm text-neutral-700 dark:text-neutral-200">
                  {formatYen(amountOf(item))}
                </td>
                <td className="px-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    aria-label="この明細行を削除"
                    title="この明細行を削除"
                    className="rounded p-1 text-neutral-400 transition-colors hover:text-red-500"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* スマートフォン: カード形式 */}
      <div className="flex flex-col gap-3 sm:hidden">
        {items.map((item, idx) => (
          <div
            key={item.id}
            className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-400">明細 {idx + 1}</span>
              <button
                type="button"
                onClick={() => removeItem(item.id)}
                className="text-xs text-red-500 hover:text-red-600"
              >
                削除
              </button>
            </div>
            <input
              value={item.name}
              onChange={(e) => updateItem(item.id, { name: e.target.value })}
              placeholder="商品名・作業内容"
              className={cellInputClass}
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                value={item.quantity}
                onChange={(e) => updateItem(item.id, { quantity: e.target.value })}
                inputMode="decimal"
                placeholder="数量"
                className={cellInputClass}
              />
              <input
                value={item.unit}
                onChange={(e) => updateItem(item.id, { unit: e.target.value })}
                placeholder="単位"
                className={cellInputClass}
              />
              <input
                value={item.unitPrice}
                onChange={(e) => updateItem(item.id, { unitPrice: e.target.value })}
                inputMode="decimal"
                placeholder="単価"
                className={cellInputClass}
              />
            </div>
            <p className="text-right text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {formatYen(amountOf(item))}
            </p>
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
