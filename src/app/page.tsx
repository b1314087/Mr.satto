import { featureFlags } from "@/lib/config/features";
import Link from "next/link";
import { SearchBar } from "@/components/tools/search-bar";
import { CategoryCard } from "@/components/tools/category-card";
import { categories } from "@/lib/tools/categories";
import { getListedTools } from "@/lib/tools/data";
import { siteConfig } from "@/lib/config/site";
import { JsonLd } from "@/components/seo/json-ld";
import { GlassCard } from "@/components/ui/glass-card";
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

      {/* ファーストビュー: サービス名・一言・検索。検索とカテゴリがスクロールなしで見える高さに収める */}
      <section className="px-4 pb-6 pt-10 text-center sm:px-6 sm:pb-8 sm:pt-14">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-ms-text sm:text-4xl">{siteConfig.name}</h1>
          <p className="text-lg font-medium text-ms-text">{siteConfig.tagline}</p>
          <p className="text-balance text-sm text-ms-muted sm:text-base">
            画像・PDF・CSV・ファイルなどの面倒な作業を、ブラウザ上でサッと解決できるWebツール集です。
          </p>
          <div className="mt-3 w-full max-w-xl">
            <SearchBar placeholder="ツールを検索（例: 画像 圧縮）" />
          </div>
          <p className="text-xs text-ms-muted">
            ツール名や作業内容から探せます ・ 全 {availableTools.length} ツール
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ms-text">カテゴリから探す</h2>
          <Link href="/tools" className="text-sm text-ms-accent hover:underline dark:text-ms-focus">
            全ツール一覧 →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {categories.map((category) => (
            <CategoryCard key={category.id} category={category} toolCount={countByCategory(category.id)} />
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-14 pt-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <GlassCard className="p-5">
            <p className="text-2xl" aria-hidden="true">
              🔒
            </p>
            <h3 className="mt-2 font-semibold text-ms-text">ファイルを保存しない</h3>
            <p className="mt-1 text-sm text-ms-muted">
              多くの処理はお使いのブラウザ内で完結し、ファイルをサーバーに送信・保存しません。
            </p>
          </GlassCard>
          <GlassCard className="p-5">
            <p className="text-2xl" aria-hidden="true">
              ⚡
            </p>
            <h3 className="mt-2 font-semibold text-ms-text">会員登録不要ですぐ使える</h3>
            <p className="mt-1 text-sm text-ms-muted">
              {featureFlags.billing && featureFlags.ads
                ? "アカウントを作らなくてもすぐに使い始められます。無料プランでも、広告を見れば1時間、通常ツールを利用できます。"
                : "アカウントを作らなくても、すぐに使い始められます。通常のツールは無料でご利用いただけます。"}
            </p>
          </GlassCard>
        </div>
      </section>
    </div>
  );
}
