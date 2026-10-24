import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/lib/config/site";
import { HeaderSearch } from "@/components/tools/search-bar";
import { AuthStatusLink } from "@/components/auth/auth-status-link";
import { SiteMenu } from "@/components/layout/site-menu";
import { categories } from "@/lib/tools/categories";
import { featureFlags } from "@/lib/config/features";

const NAV_LINK = "text-ms-muted hover:text-ms-accent dark:hover:text-ms-focus";

/**
 * 全ページ共通ヘッダー（src/app/layout.tsx で1回だけ描画する）。
 *
 * 画面幅ごとの出し分け（並びは order で固定）:
 * - スマホ（〜sm）: [☰] ロゴ ………… [🔍]   … 検索・カテゴリ・テーマ切り替えなどはメニューの中
 * - タブレット（sm〜lg）: [☰] ロゴ [検索欄] ………… [テーマ]
 * - PC（lg〜）: [☰] ロゴ ツール一覧/料金/ログイン [検索欄] ………… [テーマ]
 * ハンバーガーメニュー本体は SiteMenu（クライアント部品）。開閉の状態はそこで閉じていて、
 * ページ本文には影響しない。
 */
export function Header() {
  return (
    <header className="ms-bar sticky top-0 z-40">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 sm:gap-4 sm:px-6">
        <SiteMenu
          categories={categories.map(({ id, name, icon }) => ({ id, name, icon }))}
          showBilling={featureFlags.billing}
          siteName={siteConfig.shortName}
        />

        <Link href="/" className="order-2 flex items-center gap-2 text-lg font-bold text-ms-text">
          <span aria-hidden="true">🧰</span>
          {siteConfig.shortName}
        </Link>

        <nav aria-label="主要ナビゲーション" className="order-3 hidden items-center gap-4 text-sm lg:flex">
          <Link href="/tools" className={NAV_LINK}>
            ツール一覧
          </Link>
          {featureFlags.billing && (
            <>
              <Link href="/pricing" className={NAV_LINK}>
                料金プラン
              </Link>
              <AuthStatusLink className={NAV_LINK} />
            </>
          )}
        </nav>

        <div className="order-4 hidden min-w-0 flex-1 sm:block sm:max-w-xs">
          <HeaderSearch />
        </div>

        <div className="order-5 ml-auto hidden sm:block">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
