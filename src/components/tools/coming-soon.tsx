import type { Tool } from "@/lib/tools/types";

const ENGINE_LABEL: Record<Tool["processor"], string> = {
  browser: "ブラウザ処理（予定）",
  server: "サーバー処理（予定）",
  auto: "自動切り替え処理（予定）",
};

export function ComingSoon({ tool }: { tool: Tool }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-ms-card border border-dashed border-ms-border-strong bg-ms-hover-tint px-6 py-16 text-center">
      <span className="text-4xl" aria-hidden="true">
        🚧
      </span>
      <h2 className="text-lg font-semibold text-ms-text">
        「{tool.name}」は準備中です
      </h2>
      <p className="max-w-md text-sm text-ms-muted">
        この機能は近日公開予定です。公開までもうしばらくお待ちください。
      </p>
      <span className="mt-2 rounded-full border border-ms-border bg-ms-surface-strong px-3 py-1 text-xs text-ms-muted">
        {ENGINE_LABEL[tool.processor]}
      </span>
    </div>
  );
}
