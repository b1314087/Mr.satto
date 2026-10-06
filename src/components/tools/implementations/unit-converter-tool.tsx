"use client";

import { useMemo, useState } from "react";
import {
  UNIT_CATEGORIES,
  convertUnit,
  formatUnitNumber,
  getUnitCategory,
  type UnitCategoryId,
} from "@/lib/units/units";

/**
 * 単位変換。入力値を変えるたびに、選んだ単位への結果と、同じ種類の全単位への換算表を
 * その場で表示する(プレビュー=結果の一覧)。処理はブラウザ内の計算のみ。
 */
export function UnitConverterTool() {
  const [categoryId, setCategoryId] = useState<UnitCategoryId>("length");
  const category = getUnitCategory(categoryId);
  const [fromId, setFromId] = useState("m");
  const [toId, setToId] = useState("ft");
  const [input, setInput] = useState("1");
  const [copied, setCopied] = useState<string | null>(null);

  const parsed = input.trim() === "" ? NaN : Number(input.replace(/,/g, ""));
  const valid = Number.isFinite(parsed);

  const { result, error } = useMemo(() => {
    if (!valid) return { result: null as number | null, error: input.trim() === "" ? null : "数値を入力してください" };
    try {
      return { result: convertUnit(categoryId, fromId, toId, parsed), error: null };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : "変換できません" };
    }
  }, [categoryId, fromId, toId, parsed, valid, input]);

  const table = useMemo(() => {
    if (!valid) return [];
    return category.units.map((u) => {
      try {
        return { unit: u, value: convertUnit(categoryId, fromId, u.id, parsed) as number | null };
      } catch {
        return { unit: u, value: null };
      }
    });
  }, [category, categoryId, fromId, parsed, valid]);

  function changeCategory(next: UnitCategoryId) {
    const cat = getUnitCategory(next);
    setCategoryId(next);
    setFromId(cat.units[0].id);
    setToId(cat.units[Math.min(1, cat.units.length - 1)].id);
    setCopied(null);
  }

  function swap() {
    setFromId(toId);
    setToId(fromId);
    if (result !== null && Number.isFinite(result)) setInput(String(Number(result.toPrecision(10))));
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* クリップボードが使えない環境では何もしない */
    }
  }

  const fromUnit = category.units.find((u) => u.id === fromId);
  const toUnit = category.units.find((u) => u.id === toId);

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label="単位の種類" className="flex flex-wrap gap-2">
        {UNIT_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === categoryId}
            onClick={() => changeCategory(c.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              c.id === categoryId
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex flex-col gap-2">
          <label htmlFor="unit-value" className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            変換する値
          </label>
          <input
            id="unit-value"
            type="text"
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-lg tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
          <select
            aria-label="変換元の単位"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {category.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}（{u.symbol}）
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={swap}
          aria-label="変換元と変換先を入れ替える"
          className="mb-1 rounded-full border border-neutral-300 p-2 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          ⇄
        </button>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変換結果</span>
          <output
            data-testid="unit-result"
            className="flex min-h-[2.75rem] w-full items-center rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-lg font-semibold tabular-nums dark:border-neutral-800 dark:bg-neutral-900"
          >
            {result !== null ? formatUnitNumber(result) : "—"}
          </output>
          <select
            aria-label="変換先の単位"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {category.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}（{u.symbol}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {result !== null && fromUnit && toUnit && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-700 dark:text-neutral-200">
            {formatUnitNumber(parsed)} {fromUnit.symbol} = <strong>{formatUnitNumber(result)} {toUnit.symbol}</strong>
          </p>
          <button
            type="button"
            onClick={() => copy(`${formatUnitNumber(parsed)} ${fromUnit.symbol} = ${formatUnitNumber(result)} ${toUnit.symbol}`, "sentence")}
            className="rounded-md bg-white px-2.5 py-1 text-xs text-neutral-600 shadow-sm ring-1 ring-neutral-200 hover:bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700"
          >
            {copied === "sentence" ? "コピーしました" : "式をコピー"}
          </button>
        </div>
      )}

      <section aria-labelledby="unit-table-heading" className="flex flex-col gap-2">
        <h2 id="unit-table-heading" className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
          すべての単位への換算（基準: {category.baseLabel}）
        </h2>
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <tbody>
              {table.map(({ unit, value }) => (
                <tr
                  key={unit.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    unit.id === toId ? "bg-blue-50 dark:bg-blue-950/30" : ""
                  }`}
                >
                  <th scope="row" className="w-1/2 px-3 py-2 font-normal text-neutral-600 dark:text-neutral-300">
                    {unit.label}（{unit.symbol}）
                  </th>
                  <td className="px-3 py-2 tabular-nums">{value === null ? "—" : formatUnitNumber(value)}</td>
                  <td className="w-16 px-3 py-2 text-right">
                    {value !== null && (
                      <button
                        type="button"
                        onClick={() => copy(formatUnitNumber(value).replace(/,/g, ""), unit.id)}
                        className="text-xs text-neutral-500 hover:text-blue-600 dark:text-neutral-400"
                      >
                        {copied === unit.id ? "済" : "コピー"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {table.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-neutral-400">数値を入力すると換算表が表示されます</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {category.note && <p className="text-xs text-neutral-500 dark:text-neutral-400">{category.note}</p>}
      </section>
    </div>
  );
}
