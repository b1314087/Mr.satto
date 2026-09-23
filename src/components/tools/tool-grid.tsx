import type { Tool } from "@/lib/tools/types";
import { ToolCard } from "./tool-card";

export function ToolGrid({ tools, emptyMessage = "該当するツールが見つかりませんでした" }: {
  tools: Tool[];
  emptyMessage?: string;
}) {
  if (tools.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-300 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
    </div>
  );
}
