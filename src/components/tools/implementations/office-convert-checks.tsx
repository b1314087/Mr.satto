"use client";

import type { ConversionCheck } from "@/lib/office-convert/excel-to-word";

/** 変換後の確認の結果と、再現できなかった要素の注意（Excel→Word・Word→Excel 共通） */
export function ConversionChecks({ checks, warnings }: { checks: ConversionCheck[]; warnings: string[] }) {
  const failed = checks.filter((c) => !c.ok);
  return (
    <div className="flex flex-col gap-2">
      <section aria-label="変換後の確認" data-testid="conversion-checks" className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
        <p className="mb-1 text-xs font-semibold text-neutral-700 dark:text-neutral-200">
          変換後の確認{failed.length === 0 ? "：問題は見つかりませんでした" : `：${failed.length}件の注意があります`}
        </p>
        <ul className="flex flex-col gap-0.5 text-xs">
          {checks.map((c) => (
            <li key={c.label} data-ok={c.ok ? "true" : "false"} className={c.ok ? "text-neutral-600 dark:text-neutral-300" : "text-amber-700 dark:text-amber-400"}>
              <span aria-hidden="true">{c.ok ? "✓ " : "！ "}</span>
              {c.label}
              {c.detail ? <span className="text-neutral-400">（{c.detail}）</span> : null}
            </li>
          ))}
        </ul>
      </section>
      {warnings.length > 0 && (
        <section aria-label="変換の注意" data-testid="conversion-warnings" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="mb-1 font-semibold">再現できなかった・変更した点</p>
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
