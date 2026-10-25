import { featureFlags } from "@/lib/config/features";
import Link from "next/link";
import { SearchBar } from "@/components/tools/search-bar";
import { CategoryCard } from "@/components/tools/category-card";
import { categories } from "@/lib/tools/categories";
import { getListedTools } from "@/lib/tools/data";
import { siteConfig } from "@/lib/config/site";
import { JsonLd } from "@/components/seo/json-ld";
import { GlassCard } from "@/components/ui/glass-card";
import { BrandMark } from "@/components/ui/brand-mark";
import { buildOrganization, buildWebApplication, buildWebSite } from "@/lib/seo/structured-data";

export default function Home() {
  // 一覧・検索に出るツール（総合ツールに統合済みの旧ツールは含まない）のうち、使えるもの
  const availableTools = getListedTools().filter((t) => t.status === "available");
  const countByCategory = (id: string) => availableTools.filter((t) => t.category === id).length;

  return (
    <div className="flex flex-col">
      <JsonLd data={buildWebSite()} />
      <JsonLd data={buildOrganization()} />
      <JsonLd data={buildWebApplication()} />

      {/* ファーストビュー: 左にサービス名・キャッチコピー・検索、右に大きなロゴ（PCのみ）。
          検索とカテゴリがスクロールなしで見える高さに収める。h1 はサービス名のまま（見た目は小さな見出しにして、
          大きく見せるのはキャッチコピー。SEOの見出し構造は変えない） */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-4 pt-10 sm:px-6 sm:pb-6 sm:pt-14 lg:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="flex flex-col items-start gap-4">
            <h1 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-ms-muted">
              <BrandMark size={22} />
              {siteConfig.name}
            </h1>
            <p className="text-balance text-4xl font-bold leading-[1.25] tracking-tight text-ms-text sm:text-5xl lg:text-[3.5rem]">
              {siteConfig.tagline.split("、").map((part, i, all) => (
                <span key={part} className="block">
                  {part}
                  {i < all.length - 1 ? "、" : ""}
                </span>
              ))}
            </p>
            <p className="max-w-xl text-balance text-sm text-ms-muted sm:text-base">
              画像・PDF・CSV・ファイルなどの面倒な作業を、ブラウザ上でサッと解決できるWebツール集です。
            </p>
            <div className="mt-2 w-full max-w-xl">
              <SearchBar placeholder="ツールを検索（例: 画像 圧縮）" pill />
            </div>
            <p className="text-xs text-ms-muted">
              ツール名や作業内容から探せます ・ 全 {availableTools.length} ツール
            </p>
          </div>
          <div className="hidden justify-center lg:flex" aria-hidden="true">
            <span className="ms-emblem h-56 w-56 xl:h-64 xl:w-64">
              <BrandMark size={150} className="drop-shadow-[0_10px_18px_rgba(37,99,235,0.25)]" />
            </span>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ms-text">カテゴリから探す</h2>
          <Link href="/tools" className="text-sm text-ms-accent hover:underline dark:text-ms-focus">
            全ツール一覧 →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
          {categories.map((category) => (
            <CategoryCard key={category.id} category={category} toolCount={countByCategory(category.id)} />
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-14 pt-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <GlassCard className="flex items-start gap-4 p-5">
            <span aria-hidden="true" className="ms-tile" data-cat="csv-excel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
                <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
              </svg>
            </span>
            <div>
              <h3 className="font-semibold text-ms-text">ファイルを保存しない</h3>
              <p className="mt-1 text-sm text-ms-muted">
                多くの処理はお使いのブラウザ内で完結し、ファイルをサーバーに送信・保存しません。
                {featureFlags.billing ? "AIで読み取る機能（プレミアム）だけは、同意したうえで選んだ内容を、外部のAIサービスへ送信します。" : ""}
              </p>
            </div>
          </GlassCard>
          <GlassCard className="flex items-start gap-4 p-5">
            <span aria-hidden="true" className="ms-tile" data-cat="image">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z" />
              </svg>
            </span>
            <div>
              <h3 className="font-semibold text-ms-text">会員登録不要ですぐ使える</h3>
              <p className="mt-1 text-sm text-ms-muted">
                {featureFlags.billing && featureFlags.ads
                  ? "アカウントを作らなくてもすぐに使い始められます。無料プランでも、広告を見れば1時間、通常ツールを利用できます。"
                  : "アカウントを作らなくても、すぐに使い始められます。通常のツールは無料でご利用いただけます。"}
              </p>
            </div>
          </GlassCard>
        </div>
      </section>
    </div>
  );
}
