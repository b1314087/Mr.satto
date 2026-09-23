import Link from "next/link";
import type { Tool } from "@/lib/tools/types";
import { getCategory } from "@/lib/tools/categories";

export function ToolCard({ tool }: { tool: Tool }) {
  const category = getCategory(tool.category);

  return (
    <Link
      href={`/tools/${tool.id}`}
      className="group flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-blue-700"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xl" aria-hidden="true">
          {category?.icon ?? "🔧"}
        </span>
        {tool.status === "coming-soon" && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            準備中
          </span>
        )}
      </div>
      <h3 className="font-semibold text-neutral-900 group-hover:text-blue-700 dark:text-neutral-100 dark:group-hover:text-blue-400">
        {tool.name}
      </h3>
      <p className="line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
        {tool.description}
      </p>
    </Link>
  );
}
