import Link from "next/link";
import type { BreadcrumbItem } from "@/lib/seo/structured-data";

/**
 * ページ上部に表示するパンくずリスト（Top→カテゴリ→ツール、など）。
 *
 * 表示内容は必ずこのコンポーネントに渡すitemsから作り、同じitemsを
 * buildBreadcrumbList()にも渡すことで、見た目と構造化データが
 * ズレないようにする（呼び出し側の責務）。
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="パンくずリスト" className="mb-4 flex flex-wrap items-center gap-1 text-xs text-ms-muted">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={item.path} className="flex items-center gap-1">
            {index > 0 && <span aria-hidden="true">/</span>}
            {isLast ? (
              <span className="font-medium text-ms-text" aria-current="page">
                {item.name}
              </span>
            ) : (
              <Link href={item.path} className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
                {item.name}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
