import Link from "next/link";
import type { Tool } from "@/lib/tools/types";
import { getCategory } from "@/lib/tools/categories";
import { TOOL_TIER_LABELS } from "@/lib/plans/types";
import { cn } from "@/lib/utils/cn";
import { featureFlags } from "@/lib/config/features";
import { glassCardClasses } from "@/components/ui/glass-card";
import { CategoryIcon } from "@/components/ui/category-icon";

/**
 * 料金区分バッジ（Phase 19 9章）。
 *
 * 表示名は必ずTOOL_TIER_LABELS（src/lib/plans/types.ts）を参照し、
 * ここで別の文言をハードコードしない（プラン名の唯一の情報源を守る）。
 * 「通常」は目立たせない中立色、「プレミアム」だけ紫で区別する
 * （準備中バッジのamber色とは被らない配色。青は操作・選択の強調のために取っておく）。
 */
function PlanBadge({ requiredPlan }: { requiredPlan: Tool["requiredPlan"] }) {
  const label = TOOL_TIER_LABELS[requiredPlan];
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        requiredPlan === "premium"
          ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          : "border border-ms-border bg-ms-hover-tint text-ms-muted"
      )}
    >
      {label}
    </span>
  );
}

/**
 * 「AI実装」バッジ（AI機能が入っているツールだけに付ける。カテゴリ別一覧のコンパクト表示で使う）。
 * 料金区分（通常・プレミアム）や準備中の色とは別の緑系にして、区別する。
 */
function AiBadge() {
  return (
    <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
      AI実装
    </span>
  );
}

/** AIの印を出すか。外部AIの補助機能は、課金スイッチがオフの間は使えないため出さない。 */
function showsAiBadge(tool: Tool): boolean {
  return tool.hasAi === "local" || (tool.hasAi === "cloud" && featureFlags.billing);
}

/**
 * ツールのカード。全ツール一覧・カテゴリ別一覧・関連ツールなど、すべての一覧で共通に使う。
 *
 * - 実装済みのツール: ガラス調（半透明＋背景ぼかし＋細い境界線＋上端のハイライト＋影）。
 *   ホバーで少し浮き、キーボードのフォーカスでは青い枠が出る（定義は globals.css の .ms-glass 系）。
 * - 準備中のツール: ガラスにせず、破線・低コントラストの別の見た目にして、実装済みと区別する
 *   （ホバーで浮かない・枠の色も変えない。まだ使えない印象を与えないため）。
 * - カード全体が1つのリンク（<a>）。JavaScriptでの遷移には置き換えていない。
 */
export function ToolCard({ tool, compact = false }: { tool: Tool; compact?: boolean }) {
  const category = getCategory(tool.category);
  const isComingSoon = tool.status === "coming-soon";

  const badge = isComingSoon ? (
    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      準備中
    </span>
  ) : featureFlags.billing ? (
    // 課金オフの間は料金プランが存在しないため、料金区分のバッジは出さない。
    <PlanBadge requiredPlan={tool.requiredPlan} />
  ) : null;

  const surface = isComingSoon
    ? // Phase 19 10章: 実装済みツールと同じクリック体験にしない
      // （持ち上がるホバー演出や「使える」印象を与える枠線色の変化をつけず、
      // 破線・低コントラストな配色にとどめる）。
      "ms-focus-ring rounded-ms-card border border-dashed border-ms-border-strong bg-ms-hover-tint"
    : glassCardClasses({ interactive: true });

  const titleColor = isComingSoon ? "text-ms-muted" : "text-ms-text group-hover:text-ms-accent dark:group-hover:text-ms-focus";

  const linkProps = {
    href: `/tools/${tool.id}`,
    "aria-label": isComingSoon ? `${tool.name}（準備中・まだ利用できません）` : tool.name,
  };

  // コンパクト表示（カテゴリ別一覧）: アイコン・名前・バッジを1行に並べ、説明文は出さない。
  // 1画面に並べられるツールの数を増やすための、低いカード。
  if (compact) {
    // 「通常」は出さない（ほとんどのツールが通常のため、情報にならない）。出すのは、準備中・プレミアム限定・AI実装だけ。
    const showPlan = !isComingSoon && featureFlags.billing && tool.requiredPlan === "premium";
    return (
      <Link {...linkProps} className={cn("group flex h-full items-center gap-3 px-3 py-2.5", surface)}>
        <CategoryIcon id={category?.id ?? "other"} size="sm" />
        <h3 className={cn("min-w-0 flex-1 text-sm font-semibold leading-snug", titleColor)}>{tool.name}</h3>
        {isComingSoon && badge}
        {showPlan && <PlanBadge requiredPlan={tool.requiredPlan} />}
        {!isComingSoon && showsAiBadge(tool) && <AiBadge />}
      </Link>
    );
  }

  return (
    <Link {...linkProps} className={cn("group flex h-full flex-col gap-2 p-4", surface)}>
      <div className="flex items-start justify-between gap-2">
        <CategoryIcon id={category?.id ?? "other"} size="md" />
        {badge}
      </div>
      <h3 className={cn("font-semibold", titleColor)}>{tool.name}</h3>
      <p className="line-clamp-2 text-sm text-ms-muted">{tool.description}</p>
    </Link>
  );
}
