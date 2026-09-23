import type { Tool } from "@/lib/tools/types";

const ENGINE_LABEL: Record<Tool["processor"], string> = {
  browser: "ブラウザ処理（予定）",
  server: "サーバー処理（予定）",
  auto: "自動切り替え処理（予定）",
};

export function ComingSoon({ tool }: { tool: Tool }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-6 py-16 text-center dark:border-neutral-700 dark:bg-neutral-900">
      <span className="text-4xl" aria-hidden="true">
        🚧
      </span>
      <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
        「{tool.name}」は準備中です
      </h2>
      <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">
        この機能は近日公開予定です。公開までもうしばらくお待ちください。
      </p>
      <span className="mt-2 rounded-full bg-neutral-200 px-3 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {ENGINE_LABEL[tool.processor]}
      </span>
    </div>
  );
}
