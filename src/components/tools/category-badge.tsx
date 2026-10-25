import Link from "next/link";
import { getCategory } from "@/lib/tools/categories";
import type { CategoryId } from "@/lib/tools/types";

export function CategoryBadge({ category }: { category: CategoryId }) {
  const cat = getCategory(category);
  if (!cat) return null;

  return (
    <Link href={`/tools?category=${cat.id}`} className="ms-chip min-h-0 px-3 py-1 text-xs">
      {cat.name}
    </Link>
  );
}
