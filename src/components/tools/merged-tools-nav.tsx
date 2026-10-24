import Link from "next/link";
import type { Tool } from "@/lib/tools/types";

/**
 * 総合ツール（hub）に統合済みのツールの個別ページへのリンク。
 *
 * 統合済みの旧ツールは、ツール一覧・検索・関連ツールにはカードとして出さないが、個別URLは残している。
 * 総合ツールのページと各旧ページの下に、同じ画面で使える各ページへのリンクを並べて、
 * 内部リンクを保つ（旧ページが孤立しない）。自分自身へのリンクは出さない。
 * 統合の対応は data.ts の `mergedInto` が唯一の情報源。
 */
export function MergedToolsNav({ hub, members, currentId }: { hub: Tool; members: Tool[]; currentId: string }) {
  const links = [hub, ...members].filter((t) => t.id !== currentId);
  if (links.length === 0) return null;
  return (
    <nav
      aria-label="同じ画面で使える各ページ"
      data-testid="merged-tools-nav"
      className="mt-3 text-xs text-neutral-500 dark:text-neutral-400"
    >
      <span className="mr-2">同じ画面で使える各ページ:</span>
      <ul className="inline-flex flex-wrap gap-x-3 gap-y-1 align-top">
        {links.map((t) => (
          <li key={t.id}>
            <Link href={`/tools/${t.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
              {t.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
