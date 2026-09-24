import Link from "next/link";
import { SearchBar } from "@/components/tools/search-bar";
import { ToolGrid } from "@/components/tools/tool-grid";
import { categories } from "@/lib/tools/categories";
import { getFeaturedTools, tools } from "@/lib/tools/data";
import { siteConfig } from "@/lib/config/site";
import { JsonLd } from "@/components/seo/json-ld";
import { buildWebApplication, buildWebSite } from "@/lib/seo/structured-data";

export default function Home() {
  const featured = getFeaturedTools();

  return (
    <div className="flex flex-col">
      <JsonLd data={buildWebSite()} />
      <JsonLd data={buildWebApplication()} />

      <section className="border-b border-neutral-200 bg-gradient-to-b from-blue-50 to-white px-4 py-16 text-center dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-950 sm:px-6">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-white sm:text-4xl">
            {siteConfig.name}
          </h1>
          <p className="text-lg font-medium text-blue-600 dark:text-blue-400">
            {siteConfig.tagline}
          </p>
          <p className="text-neutral-600 dark:text-neutral-300">{siteConfig.description}</p>
          <div className="w-full max-w-lg">
            <SearchBar />
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            全 {tools.length} ツール ・ 会員登録不要ですぐ試せる
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">カテゴリから探す</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {categories.map((category) => (
            <Link
              key={category.id}
              href={`/tools/${category.id}`}
              className="flex flex-col items-center gap-2 rounded-xl border border-neutral-200 bg-white p-5 text-center transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-blue-700"
            >
              <span className="text-3xl" aria-hidden="true">
                {category.icon}
              </span>
              <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {category.name}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">おすすめツール</h2>
          <Link href="/tools" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            すべて見る →
          </Link>
        </div>
        <ToolGrid tools={featured} />
      </section>

      <section className="border-t border-neutral-200 bg-neutral-50 px-4 py-12 dark:border-neutral-800 dark:bg-neutral-950 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row">
          <div className="flex-1 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-2xl">🔒</p>
            <h3 className="mt-2 font-semibold text-neutral-900 dark:text-white">
              ファイルを保存しない
            </h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              多くの処理はお使いのブラウザ内で完結し、ファイルをサーバーに送信・保存しません。
            </p>
          </div>
          <div className="flex-1 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-2xl">⚡</p>
            <h3 className="mt-2 font-semibold text-neutral-900 dark:text-white">会員登録不要ですぐ使える</h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              アカウントを作らなくてもすぐに使い始められます。無料プランでも、広告を見れば15分間スタンダードツールを利用できます。
            </p>
          </div>
          <div className="flex-1 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-2xl">📱</p>
            <h3 className="mt-2 font-semibold text-neutral-900 dark:text-white">
              スマホ・PC対応
            </h3>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              スマートフォン、タブレット、PCのどれでも同じように使えます。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
