"use client";

import {
  TAX_RATE_OPTIONS,
  TAX_ROUNDING_LABELS,
  type TaxRatePercent,
  type TaxRounding,
} from "@/lib/documents/types";
import { Segmented } from "@/components/ui/segmented";

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
  // 選択肢が3つずつなので、プルダウンではなくセグメントボタンで選ぶ（UI・UX改善）
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <Segmented
        label="消費税率"
        value={String(taxRatePercent)}
        onChange={(v) => onChange({ taxRatePercent: Number(v) as TaxRatePercent })}
        options={TAX_RATE_OPTIONS.map((rate) => ({ value: String(rate), label: `${rate}%` }))}
        testId="tax-rate"
      />
      <Segmented
        label="端数処理"
        value={taxRounding}
        onChange={(v) => onChange({ taxRounding: v })}
        options={ROUNDING_OPTIONS.map((key) => ({ value: key, label: TAX_ROUNDING_LABELS[key] }))}
        testId="tax-rounding"
      />
    </div>
  );
}
