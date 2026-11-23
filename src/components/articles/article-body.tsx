import Link from "next/link";
import { CategoryIcon } from "@/components/ui/category-icon";
import { getToolById } from "@/lib/tools/data";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { getArticle, type ArticleBlock } from "@/lib/articles";

/**
 * 使い方ガイド（記事）の本文（2026-11-23）。
 * 記事は決まった形のかたまりで書くので、HTMLをそのまま差し込むことはない（dangerouslySetInnerHTML を使わない）。
 */

/** ツールへの案内カード */
export function ArticleToolCard({ id, note }: { id: string; note?: string }) {
  const tool = getToolById(id);
  if (!tool) return null;
  const lead = note ?? getToolSeoContent(id)?.lead ?? tool.description;
  return (
    <Link
      href={`/tools/${tool.id}`}
      data-testid="article-tool-card"
      data-tool-id={tool.id}
      className="ms-glass ms-glass-interactive my-4 flex items-start gap-3 p-4 no-underline"
    >
      <CategoryIcon id={tool.category} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ms-text">{tool.name}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ms-muted">{lead}</span>
      </span>
      <span className="shrink-0 self-center text-xs font-semibold text-ms-accent dark:text-ms-focus">使ってみる →</span>
    </Link>
  );
}

/** ほかの記事への案内 */
function ArticleGuideLink({ slug, note }: { slug: string; note?: string }) {
  const a = getArticle(slug);
  if (!a) return null;
  return (
    <p className="my-4 text-sm">
      <span className="text-ms-muted">関連ガイド：</span>
      <Link href={`/guides/${a.slug}`} data-testid="article-guide-link" className="font-semibold text-ms-accent hover:underline dark:text-ms-focus">
        {a.title}
      </Link>
      {note && <span className="text-ms-muted">（{note}）</span>}
    </p>
  );
}

function Block({ b }: { b: ArticleBlock }) {
  switch (b.t) {
    case "p":
      return <p className="my-4 leading-[1.9]">{b.text}</p>;
    case "h2":
      return (
        <h2 id={b.id} className="mb-3 mt-12 scroll-mt-24 border-b border-ms-border pb-2 text-xl font-bold text-ms-text">
          {b.text}
        </h2>
      );
    case "h3":
      return <h3 className="mb-2 mt-8 text-base font-semibold text-ms-text">{b.text}</h3>;
    case "ul":
      return (
        <ul className="my-4 list-disc space-y-1.5 pl-6 leading-[1.8]">
          {b.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="my-4 list-decimal space-y-2 pl-6 leading-[1.8]">
          {b.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case "tip":
      return (
        <aside className="my-5 rounded-lg border-l-4 border-l-ms-accent bg-blue-50/60 px-4 py-3 dark:bg-blue-950/30">
          <p className="mb-1 text-xs font-bold text-ms-accent dark:text-ms-focus">ポイント{b.title ? `：${b.title}` : ""}</p>
          <p className="text-sm leading-[1.8]">{b.text}</p>
        </aside>
      );
    case "warn":
      return (
        <aside className="my-5 rounded-lg border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
          <p className="mb-1 text-xs font-bold text-amber-800 dark:text-amber-300">注意</p>
          <p className="text-sm leading-[1.8]">{b.text}</p>
        </aside>
      );
    case "table":
      return (
        <div className="my-5 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} scope="col" className="border border-ms-border bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-ms-border px-3 py-2 align-top leading-relaxed">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {b.caption && <p className="mt-1.5 text-xs text-ms-muted">{b.caption}</p>}
        </div>
      );
    case "example":
      return (
        <figure className="my-5">
          <figcaption className="mb-1.5 text-xs font-semibold text-ms-muted">{b.title}</figcaption>
          <pre className="overflow-x-auto whitespace-pre rounded-lg border border-ms-border bg-white px-4 py-3 font-sans text-[13px] leading-[1.9] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
            {b.lines.join("\n")}
          </pre>
        </figure>
      );
    case "tool":
      return <ArticleToolCard id={b.id} note={b.note} />;
    case "guide":
      return <ArticleGuideLink slug={b.slug} note={b.note} />;
  }
}

export function ArticleBody({ blocks }: { blocks: ArticleBlock[] }) {
  return (
    <div className="text-[15px] text-ms-text" data-testid="article-body">
      {blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </div>
  );
}
