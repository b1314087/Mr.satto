import Link from "next/link";
import type { Tool } from "@/lib/tools/types";
import { getCategory } from "@/lib/tools/categories";
import { TOOL_TIER_LABELS } from "@/lib/plans/types";
import { cn } from "@/lib/utils/cn";
import { featureFlags } from "@/lib/config/features";
import { glassCardClasses } from "@/components/ui/glass-card";

/**
 * 料金区分バッジ（Phase 19 9章）。
 *
 * 表示名は必ずTOOL_TIER_LABELS（src/lib/plans/types.ts）を参照し、
 * ここで別の文言をハードコードしない（プラン名の唯一の情報源を守る）。
 * standard/premiumで色分けし、一目で区別できるようにする
 * （準備中バッジのamber色とは被らない配色にする）。
 */
function PlanBadge({ requiredPlan }: { requiredPlan: Tool["requiredPlan"] }) {
  const label = TOOL_TIER_LABELS[requiredPlan];
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

/**
 * appearance: "default"（従来の見た目）/ "glass"（UI刷新で使う、ガラス調の見た目）。
 * 既定は "default" のまま。"glass" を指定した画面だけ見た目が変わる。
 * 「準備中」のカードは、どちらの場合も同じ（破線・低コントラスト）にして、実装済みと区別する。
 */
export function ToolCard({ tool, appearance = "default" }: { tool: Tool; appearance?: "default" | "glass" }) {
  const category = getCategory(tool.category);
  const isComingSoon = tool.status === "coming-soon";

  return (
    <Link
      href={`/tools/${tool.id}`}
      aria-label={isComingSoon ? `${tool.name}（準備中・まだ利用できません）` : tool.name}
      className={cn(
        "group flex flex-col gap-2 p-4",
        (isComingSoon || appearance !== "glass") && "rounded-xl border transition-all",
        isComingSoon
          ? // Phase 19 10章: 実装済みツールと同じクリック体験にしない
            // （持ち上がるホバー演出や「使える」印象を与える枠線色の変化をつけず、
            // 破線・低コントラストな配色にとどめる）。
            "border-dashed border-neutral-300 bg-neutral-50/60 opacity-80 hover:opacity-100 dark:border-neutral-700 dark:bg-neutral-900/40"
          : appearance === "glass"
            ? glassCardClasses({ interactive: true })
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
        ) : featureFlags.billing ? (
          // 課金オフの間は料金プランが存在しないため、料金区分のバッジは出さない。
          <PlanBadge requiredPlan={tool.requiredPlan} />
        ) : null}
      </div>
      <h3
        className={cn(
          "font-semibold",
          isComingSoon
            ? "text-neutral-500 dark:text-neutral-400"
            : appearance === "glass"
              ? "text-ms-text group-hover:text-ms-accent dark:group-hover:text-ms-focus"
              : "text-neutral-900 group-hover:text-blue-700 dark:text-neutral-100 dark:group-hover:text-blue-400"
        )}
      >
        {tool.name}
      </h3>
      <p className={cn("line-clamp-2 text-sm", appearance === "glass" && !isComingSoon ? "text-ms-muted" : "text-neutral-500 dark:text-neutral-400")}>
        {tool.description}
      </p>
    </Link>
  );
}
