import { notFound } from "next/navigation";
import { categories } from "@/lib/tools/categories";
import { getToolById } from "@/lib/tools/data";

/**
 * 存在しないツール・カテゴリのURLを、読み込み画面（loading.tsx）より先に404にするための入口。
 *
 * このフォルダには、ページを開いている間に出す読み込み画面（loading.tsx）がある。
 * 読み込み画面を出したあとでページ側が「存在しない」と判定すると、すでに「成功（200）」と
 * 返したあとになってしまい、検索エンジンには「存在するページ」に見えてしまう（いわゆるソフト404）。
 * レイアウトは読み込み画面の外側で動くため、ここで先に判定すれば、正しく404を返せる。
 * ページ側（page.tsx）の判定は、そのまま残している。
 */
export default async function ToolRouteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tool: string }>;
}) {
  const { tool } = await params;
  if (!categories.some((c) => c.id === tool) && !getToolById(tool)) notFound();
  return <>{children}</>;
}
