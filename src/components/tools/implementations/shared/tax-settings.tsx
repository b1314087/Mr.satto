"use client";

import {
  TAX_RATE_OPTIONS,
  TAX_ROUNDING_LABELS,
  type TaxRatePercent,
  type TaxRounding,
} from "@/lib/documents/types";

const selectClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

const ROUNDING_OPTIONS = Object.keys(TAX_ROUNDING_LABELS) as TaxRounding[];

/**
 * 帳票共通: 消費税率・端数処理設定。
 * 端数処理の基本値は「切り捨て」（開発指示書■3）。
 */
export function TaxSettings({
  taxRatePercent,
  taxRounding,
  onChange,
}: {
  taxRatePercent: TaxRatePercent;
  taxRounding: TaxRounding;
  onChange: (patch: { taxRatePercent?: TaxRatePercent; taxRounding?: TaxRounding }) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <label className="flex flex-col gap-1.5 text-sm">
        消費税率
        <select
          value={taxRatePercent}
          onChange={(e) => onChange({ taxRatePercent: Number(e.target.value) as TaxRatePercent })}
          className={selectClass}
        >
          {TAX_RATE_OPTIONS.map((rate) => (
            <option key={rate} value={rate}>
              {rate}%
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        端数処理
        <select
          value={taxRounding}
          onChange={(e) => onChange({ taxRounding: e.target.value as TaxRounding })}
          className={selectClass}
        >
          {ROUNDING_OPTIONS.map((key) => (
            <option key={key} value={key}>
              {TAX_ROUNDING_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
