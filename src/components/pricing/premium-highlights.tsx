import Link from "next/link";
import { tools } from "@/lib/tools/data";
import { BATCH_LIMITS } from "@/lib/batch/batch-config";
import { PremiumTag } from "@/components/ui/premium-badge";

/**
 * 料金ページの「プレミアムでできること」（2026-11-17）。
 * プレミアムの強みである「AIの補助」と「複数ファイルの一括処理」を、どのツールで使えるかと一緒に、短く見せる。
 * ツール名・対応ツールは src/lib/tools/data.ts（hasAi）と src/lib/batch/batch-config.ts（BATCH_LIMITS）から作るので、
 * ツールを増やしたり減らしたりしても、ここを書き換える必要はない。
 */

type ToolChip = { id: string; name: string };

/** 公開中のツールだけを、ツール一覧の名前で返す（統合済み・準備中のIDは除く） */
function availableTools(ids: readonly string[]): ToolChip[] {
  return ids
    .map((id) => tools.find((t) => t.id === id && t.status === "available" && !t.mergedInto))
    .filter((t): t is (typeof tools)[number] => Boolean(t))
    .map((t) => ({ id: t.id, name: t.name }));
}

/** 一括処理の対応ツールのうち、カードに名前を並べる数（残りは「ほか○ツール」にまとめる） */
const BATCH_CHIP_COUNT = 6;

function Chips({ items, testId }: { items: ToolChip[]; testId: string }) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {items.map((t) => (
        <li key={t.id}>
          <Link
            href={`/tools/${t.id}`}
            className="inline-block rounded-full border border-ms-border px-2.5 py-1 text-xs text-ms-text hover:border-ms-accent hover:text-ms-accent dark:hover:text-ms-focus"
          >
            {t.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function PremiumHighlights() {
  const aiTools = availableTools(tools.filter((t) => t.hasAi === "cloud").map((t) => t.id));
  const batchTools = availableTools(Object.keys(BATCH_LIMITS));
  const batchMax = Math.max(...Object.values(BATCH_LIMITS));
  const shownBatch = batchTools.slice(0, BATCH_CHIP_COUNT);
  const restBatch = batchTools.length - shownBatch.length;

  return (
    <section className="mt-10" data-testid="premium-highlights">
      <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-ms-text">
        プレミアムでできること <PremiumTag />
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {aiTools.length > 0 && (
          <div className="ms-glass flex flex-col gap-3 p-5" data-testid="premium-highlight-ai">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-xl">✨</span>
              <h3 className="font-semibold text-ms-text">AIの補助</h3>
            </div>
            <p className="text-sm text-ms-muted">書類の読み取り・メモからの入力を、AIが手伝います。</p>
            <Chips items={aiTools} testId="premium-highlight-ai-tools" />
          </div>
        )}
        <div className="ms-glass flex flex-col gap-3 p-5" data-testid="premium-highlight-batch">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-xl">📚</span>
            <h3 className="font-semibold text-ms-text">複数ファイルの一括処理</h3>
          </div>
          <p className="text-sm text-ms-muted">
            最大{batchMax}ファイルに、同じ処理をまとめてかけられます（{batchTools.length}ツール）。
          </p>
          <Chips items={shownBatch} testId="premium-highlight-batch-tools" />
          {restBatch > 0 && <p className="text-xs text-ms-muted">ほか{restBatch}ツール</p>}
        </div>
      </div>
    </section>
  );
}
