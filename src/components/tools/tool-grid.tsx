import type { Tool } from "@/lib/tools/types";
import { ToolCard } from "./tool-card";

export function ToolGrid({ tools, emptyMessage = "該当するツールが見つかりませんでした" }: {
  tools: Tool[];
  emptyMessage?: string;
}) {
  if (tools.length === 0) {
    return (
      <p className="rounded-ms-card border border-dashed border-ms-border-strong py-12 text-center text-sm text-ms-muted">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
    </div>
  );
}
