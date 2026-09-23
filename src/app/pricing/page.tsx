import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";
import { PLAN_DEFINITIONS, PLAN_IDS } from "@/lib/plans/types";

export const metadata: Metadata = {
  title: "料金プラン",
  description: `${siteConfig.name}の料金プラン（無料・スタンダード・プレミアム）のご案内です。`,
  alternates: {
    canonical: "/pricing",
  },
};

const PLAN_TOOL_ACCESS_LABEL: Record<string, string> = {
  standard: "スタンダード対象ツールを利用可能",
  all: "すべてのツールを利用可能",
};

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-neutral-900 dark:text-white">料金プラン</h1>
      <p className="mb-10 text-sm text-neutral-600 dark:text-neutral-300">
        {siteConfig.name}は3つのプランでご利用いただけます。
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const plan = PLAN_DEFINITIONS[id];
          return (
            <div
              key={plan.id}
              className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div>
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {plan.name}
                </h2>
                <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-white">
                  {plan.priceYen === 0 ? "0円" : `${plan.priceYen.toLocaleString()}円`}
                  {plan.priceYen > 0 && (
                    <span className="ml-1 text-sm font-normal text-neutral-400">/月</span>
                  )}
                </p>
              </div>

              <ul className="flex flex-col gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {PLAN_TOOL_ACCESS_LABEL[plan.toolAccess]}
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {plan.adsRequired ? "広告視聴あり" : "広告なし"}
                </li>
              </ul>

              <p className="text-xs text-neutral-500 dark:text-neutral-400">{plan.description}</p>

              <button
                type="button"
                disabled
                title="現在準備中です。決済機能は今後提供予定です"
                className="mt-auto w-full cursor-not-allowed rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
              >
                {plan.priceYen === 0 ? "現在のプラン" : "準備中"}
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-neutral-400 dark:text-neutral-500">
        ※ 現在、有料プランへのお申し込み・お支払い機能は準備中です。プレミアム対象ツール（見積書作成・請求書作成・注文書作成など）は順次公開予定です。
      </p>
    </div>
  );
}
