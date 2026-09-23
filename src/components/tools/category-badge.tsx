import Link from "next/link";
import { getCategory } from "@/lib/tools/categories";
import type { CategoryId } from "@/lib/tools/types";

export function CategoryBadge({ category }: { category: CategoryId }) {
  const cat = getCategory(category);
  if (!cat) return null;

  return (
    <Link
      href={`/tools?category=${cat.id}`}
      className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-blue-100 hover:text-blue-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-blue-950 dark:hover:text-blue-300"
    >
      <span aria-hidden="true">{cat.icon}</span>
      {cat.name}
    </Link>
  );
}
