import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { siteConfig } from "@/lib/config/site";
import { HeaderSearch } from "@/components/tools/search-bar";
import { AuthStatusLink } from "@/components/auth/auth-status-link";

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/80 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-neutral-900 dark:text-white">
          <span aria-hidden="true">🧰</span>
          {siteConfig.shortName}
        </Link>

        <nav className="flex items-center gap-4 text-sm text-neutral-600 dark:text-neutral-300">
          <Link href="/tools" className="hover:text-blue-600 dark:hover:text-blue-400">
            ツール一覧
          </Link>
          <Link href="/pricing" className="hover:text-blue-600 dark:hover:text-blue-400">
            料金プラン
          </Link>
          <AuthStatusLink />
        </nav>

        <div className="order-last w-full grow sm:order-none sm:w-auto sm:max-w-xs">
          <HeaderSearch />
        </div>

        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
