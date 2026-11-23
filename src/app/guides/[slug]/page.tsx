import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/tools/breadcrumb";
import { JsonLd } from "@/components/seo/json-ld";
import { ArticleBody, ArticleToolCard } from "@/components/articles/article-body";
import { buildArticle, buildBreadcrumbList, type BreadcrumbItem } from "@/lib/seo/structured-data";
import { articles, getArticle, readingMinutes, sortedArticles, tableOfContents } from "@/lib/articles";
import { siteConfig } from "@/lib/config/site";

/** 使い方ガイドの記事ページ（2026-11-23）。記事はビルドのときにすべて作っておく */

export const dynamicParams = false;

export function generateStaticParams() {
  return articles.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const a = getArticle(slug);
  if (!a) return {};
  return {
    title: a.title,
    description: a.description,
    alternates: { canonical: `/guides/${a.slug}` },
    openGraph: {
      type: "article",
      title: a.title,
      description: a.description,
      url: `${siteConfig.url}/guides/${a.slug}`,
      publishedTime: a.publishedAt,
      modifiedTime: a.updatedAt,
    },
  };
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = getArticle(slug);
  if (!a) notFound();
  const toc = tableOfContents(a);
  const path = `/guides/${a.slug}`;
  const breadcrumb: BreadcrumbItem[] = [
    { name: "ホーム", path: "/" },
    { name: "使い方ガイド", path: "/guides" },
    { name: a.title, path },
  ];
  // 本文のカードで案内していない関連ツールだけを、最後にまとめて出す
  const inBody = new Set(a.blocks.flatMap((b) => (b.t === "tool" ? [b.id] : [])));
  const moreTools = a.relatedTools.filter((id) => !inBody.has(id));
  const others = sortedArticles()
    .filter((x) => x.slug !== a.slug)
    .sort((x, y) => Number(y.topic === a.topic) - Number(x.topic === a.topic))
    .slice(0, 4);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <JsonLd data={buildBreadcrumbList(breadcrumb)} />
      <JsonLd data={buildArticle({ title: a.title, description: a.description, path, publishedAt: a.publishedAt, updatedAt: a.updatedAt })} />
      <Breadcrumb items={breadcrumb} />

      <article data-testid="guide-article">
        <header className="mb-6">
          <p className="mb-2 text-xs font-semibold text-ms-accent dark:text-ms-focus">使い方ガイド・{a.topic}</p>
          <h1 className="text-2xl font-bold leading-snug text-ms-text">{a.title}</h1>
          <p className="mt-3 text-xs text-ms-muted">
            <time dateTime={a.publishedAt}>{formatDate(a.publishedAt)}公開</time>
            {a.updatedAt !== a.publishedAt && (
              <>
                ・<time dateTime={a.updatedAt}>{formatDate(a.updatedAt)}更新</time>
              </>
            )}
            ・約{readingMinutes(a)}分で読めます・{siteConfig.name}編集部
          </p>
        </header>

        <p className="ms-glass mb-6 border-l-4 border-l-ms-accent px-4 py-3 text-sm font-medium leading-[1.8] text-ms-text">{a.lead}</p>

        {toc.length > 2 && (
          <nav aria-label="目次" className="mb-8 rounded-lg border border-ms-border px-4 py-3" data-testid="guide-toc">
            <p className="mb-2 text-xs font-bold text-ms-muted">目次</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="text-ms-accent hover:underline dark:text-ms-focus">
                    {t.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <ArticleBody blocks={a.blocks} />

        {moreTools.length > 0 && (
          <section className="mt-12" aria-labelledby="guide-more-tools">
            <h2 id="guide-more-tools" className="mb-2 text-lg font-semibold text-ms-text">
              この記事で紹介したほかのツール
            </h2>
            {moreTools.map((id) => (
              <ArticleToolCard key={id} id={id} />
            ))}
          </section>
        )}

        <p className="mt-10 text-xs leading-relaxed text-ms-muted">
          記事の内容は、公開・更新した時点の情報です。ツールの画面や機能は、改善のために変わることがあります。内容の誤りや分かりにくい点は、
          <a href={siteConfig.contactFormUrl} target="_blank" rel="noopener noreferrer" className="mx-1 text-ms-accent hover:underline dark:text-ms-focus">
            お問い合わせフォーム<span aria-hidden="true"> ↗</span>
            <span className="sr-only">（Googleフォーム・新しいタブで開きます）</span>
          </a>
          からお知らせください。
        </p>
      </article>

      {others.length > 0 && (
        <section className="mt-12" aria-labelledby="guide-others">
          <h2 id="guide-others" className="mb-3 text-lg font-semibold text-ms-text">
            ほかの使い方ガイド
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {others.map((x) => (
              <li key={x.slug}>
                <Link href={`/guides/${x.slug}`} className="ms-glass ms-glass-interactive flex h-full flex-col gap-1 p-4">
                  <span className="text-sm font-semibold leading-snug text-ms-text">{x.title}</span>
                  <span className="text-[11px] text-ms-muted">{x.topic}・約{readingMinutes(x)}分</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/guides" className="mt-4 inline-block text-sm text-ms-accent hover:underline dark:text-ms-focus">
            使い方ガイドの一覧へ →
          </Link>
        </section>
      )}
    </div>
  );
}
