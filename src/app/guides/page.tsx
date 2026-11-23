import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/tools/breadcrumb";
import { JsonLd } from "@/components/seo/json-ld";
import { buildBreadcrumbList, type BreadcrumbItem } from "@/lib/seo/structured-data";
import { readingMinutes, sortedArticles, type Article } from "@/lib/articles";
import { siteConfig } from "@/lib/config/site";

/**
 * 使い方ガイド（記事）の一覧（2026-11-23）。
 * 書類・PDF・画像・Excelなどの「困りごと」を解決する手順を、ツールの使い方と合わせて紹介する。
 */

export const metadata: Metadata = {
  title: "使い方ガイド",
  description: `PDFの圧縮・結合、画像の容量を小さくする方法、CSVの文字化けの直し方、送付状や封筒の宛名の書き方など、書類・ファイルの「ちょっと面倒」を解決する手順を、${siteConfig.name}のツールの使い方と合わせて解説します。`,
  alternates: { canonical: "/guides" },
};

const TOPIC_ORDER: Article["topic"][] = ["PDF", "書類作成", "Excel・CSV", "画像", "安全・プライバシー", "動画・音声"];

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

export default function GuidesPage() {
  const list = sortedArticles();
  const breadcrumb: BreadcrumbItem[] = [
    { name: "ホーム", path: "/" },
    { name: "使い方ガイド", path: "/guides" },
  ];
  const topics = TOPIC_ORDER.filter((t) => list.some((a) => a.topic === t));
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <JsonLd data={buildBreadcrumbList(breadcrumb)} />
      <Breadcrumb items={breadcrumb} />
      <h1 className="mb-3 text-2xl font-bold text-ms-text">使い方ガイド</h1>
      <p className="mb-8 text-sm leading-relaxed text-ms-muted">
        書類・PDF・画像・Excelなど、仕事や学校でよくある「ちょっと面倒」な作業の進め方を、手順と注意点つきで解説しています。
        記事の中で紹介しているツールは、ブラウザですぐに使えます。
      </p>

      {topics.map((topic) => (
        <section key={topic} className="mb-10" aria-labelledby={`topic-${topic}`}>
          <h2 id={`topic-${topic}`} className="mb-3 text-lg font-semibold text-ms-text">
            {topic}
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="guide-list">
            {list
              .filter((a) => a.topic === topic)
              .map((a) => (
                <li key={a.slug}>
                  <Link href={`/guides/${a.slug}`} data-testid="guide-card" className="ms-glass ms-glass-interactive flex h-full flex-col gap-2 p-4">
                    <span className="text-sm font-semibold leading-snug text-ms-text">{a.title}</span>
                    <span className="line-clamp-3 text-xs leading-relaxed text-ms-muted">{a.description}</span>
                    <span className="mt-auto text-[11px] text-ms-muted">
                      {formatDate(a.updatedAt)}更新・約{readingMinutes(a)}分で読めます
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
