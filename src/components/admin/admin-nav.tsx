import Link from "next/link";

const NAV_ITEMS = [
  { href: "/admin", label: "ダッシュボード" },
  { href: "/admin/members", label: "会員一覧" },
  { href: "/admin/usage", label: "利用状況" },
] as const;

/** /admin配下の共通ナビゲーション。シンプルなテキストリンクのみ(最小構成)。 */
export function AdminNav() {
  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b border-neutral-200 pb-4 dark:border-neutral-800">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
