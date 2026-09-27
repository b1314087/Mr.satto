import Link from "next/link";
import type { Tool } from "@/lib/tools/types";
import { getCategory } from "@/lib/tools/categories";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { cn } from "@/lib/utils/cn";

/**
 * 料金区分バッジ（Phase 19 9章）。
 *
 * 表示名は必ずPLAN_DEFINITIONS（src/lib/plans/types.ts）を参照し、
 * ここで別の文言をハードコードしない（プラン名の唯一の情報源を守る）。
 * standard/premiumで色分けし、一目で区別できるようにする
 * （準備中バッジのamber色とは被らない配色にする）。
 */
function PlanBadge({ requiredPlan }: { requiredPlan: Tool["requiredPlan"] }) {
  const label = PLAN_DEFINITIONS[requiredPlan].name;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        requiredPlan === "premium"
          ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          : "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
      )}
    >
      {label}
    </span>
  );
}

export function ToolCard({ tool }: { tool: Tool }) {
  const category = getCategory(tool.category);
  const isComingSoon = tool.status === "coming-soon";

  return (
    <Link
      href={`/tools/${tool.id}`}
      aria-label={isComingSoon ? `${tool.name}（準備中・まだ利用できません）` : tool.name}
      className={cn(
        "group flex flex-col gap-2 rounded-xl border p-4 transition-all",
        isComingSoon
          ? // Phase 19 10章: 実装済みツールと同じクリック体験にしない
            // （持ち上がるホバー演出や「使える」印象を与える枠線色の変化をつけず、
            // 破線・低コントラストな配色にとどめる）。
            "border-dashed border-neutral-300 bg-neutral-50/60 opacity-80 hover:opacity-100 dark:border-neutral-700 dark:bg-neutral-900/40"
          : "border-neutral-200 bg-white hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-blue-700"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xl" aria-hidden="true">
          {category?.icon ?? "🔧"}
        </span>
        {isComingSoon ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            準備中
          </span>
        ) : (
          <PlanBadge requiredPlan={tool.requiredPlan} />
        )}
      </div>
      <h3
        className={cn(
          "font-semibold",
          isComingSoon
            ? "text-neutral-500 dark:text-neutral-400"
            : "text-neutral-900 group-hover:text-blue-700 dark:text-neutral-100 dark:group-hover:text-blue-400"
        )}
      >
        {tool.name}
      </h3>
      <p className="line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
        {tool.description}
      </p>
    </Link>
  );
}
