import Link from "next/link";
import { siteConfig } from "@/lib/config/site";

export function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {siteConfig.shortName}
          </p>
          <p className="mt-1 max-w-md text-xs text-neutral-500 dark:text-neutral-400">
            ファイルはブラウザ上で処理され、サーバーに保存されません。
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-600 dark:text-neutral-300">
          <Link href="/tools" className="hover:text-blue-600 dark:hover:text-blue-400">
            ツール一覧
          </Link>
          <Link href="/privacy" className="hover:text-blue-600 dark:hover:text-blue-400">
            プライバシーポリシー
          </Link>
          <Link href="/terms" className="hover:text-blue-600 dark:hover:text-blue-400">
            利用規約
          </Link>
          <Link href="/contact" className="hover:text-blue-600 dark:hover:text-blue-400">
            お問い合わせ
          </Link>
        </nav>
      </div>
      <div className="border-t border-neutral-200 px-4 py-4 text-center text-xs text-neutral-400 dark:border-neutral-800 sm:px-6">
        © {new Date().getFullYear()} {siteConfig.shortName}
      </div>
    </footer>
  );
}
