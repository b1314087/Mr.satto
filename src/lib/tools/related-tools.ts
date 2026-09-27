import { tools, getToolsByCategory } from "./data";
import { hasImplementation } from "./registry";
import type { Tool } from "./types";

/**
 * ツール詳細ページの「関連ツール」選定ロジック（Phase 5導入、Phase 21で
 * ページコンポーネントから切り出し）。
 *
 * 「準備中」のツールや自分自身は候補から除外する（Coming Soonのみが表示される
 * 状態を避けるため）。同カテゴリだけで指定件数に満たない場合は、他カテゴリの
 * 主要ツール(featured)で補う。
 *
 * Phase 21の監査で判明した問題：同カテゴリに指定件数(4件)以上ツールがあると、
 * 常に「カテゴリ内の先頭4件」だけを選ぶ実装では、宣言順で5番目以降のツールが
 * どのページの関連ツールにも一切出てこない（内部リンクが一切当たらない
 * 孤立ページになる）ことが判明した（72件中35件が該当）。
 * そこで「自分の次のツールから」円環状に選ぶ方式に変更し、カテゴリ内の
 * 全ツールが直前の最大N件のページから必ずリンクされるようにした
 * （おすすめの中身自体は変えず、選び方の起点だけをツールごとにずらしている。
 * 複雑な推薦アルゴリズムは使わない）。同様の理由で、補完用のfeaturedツールも
 * 呼び出し元ツールごとに開始位置をずらしている。
 *
 * このファイルを唯一の情報源とし、ページ側・テスト側の両方から同じロジックを
 * 参照する（ロジックの二重管理を避けるため）。
 */
export interface RelatedToolsResult {
  /** 実際に表示する関連ツール（最大 max 件） */
  related: Tool[];
  /** 同カテゴリの候補数（0件目の見出し文言の出し分けに使う） */
  sameCategoryCandidateCount: number;
}

export function getRelatedTools(tool: Tool, max = 4): RelatedToolsResult {
  const isRecommendable = (t: Tool) =>
    t.id !== tool.id && t.status === "available" && hasImplementation(t.id);

  const sameCategoryAvailable = getToolsByCategory(tool.category).filter(
    (t) => t.status === "available" && hasImplementation(t.id)
  );
  const selfIndex = sameCategoryAvailable.findIndex((t) => t.id === tool.id);
  const sameCategoryRelated =
    selfIndex >= 0
      ? [...sameCategoryAvailable.slice(selfIndex + 1), ...sameCategoryAvailable.slice(0, selfIndex)]
      : sameCategoryAvailable;

  const related = sameCategoryRelated.slice(0, max);

  if (related.length < max) {
    const usedIds = new Set([tool.id, ...related.map((t) => t.id)]);
    const featuredPool = tools.filter((t) => t.featured && isRecommendable(t) && !usedIds.has(t.id));
    // 同カテゴリの場合と同じ理由で、補完用のfeaturedツールも常に配列の先頭側だけが
    // 選ばれ続けないよう、呼び出し元ツールの全体順の位置を起点にずらす。
    const toolIndex = tools.findIndex((t) => t.id === tool.id);
    const rotatedFeaturedPool =
      featuredPool.length > 0 && toolIndex >= 0
        ? [
            ...featuredPool.slice(toolIndex % featuredPool.length),
            ...featuredPool.slice(0, toolIndex % featuredPool.length),
          ]
        : featuredPool;
    related.push(...rotatedFeaturedPool.slice(0, max - related.length));
  }

  return { related, sameCategoryCandidateCount: sameCategoryRelated.length };
}
