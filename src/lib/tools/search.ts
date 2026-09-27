import type { Tool } from "./types";
import { getCategory } from "./categories";

/**
 * ハイスタック（検索対象文字列）1つとトークン1つの一致度をスコアで返す。
 * 完全一致 > 前方一致 > 部分一致（既存の重み付けを維持）。
 */
function matchScore(haystack: string, term: string): number {
  if (haystack === term) return 10;
  if (haystack.startsWith(term)) return 5;
  if (haystack.includes(term)) return 2;
  return 0;
}

/**
 * ツール検索（13章 / Phase 19 4-5章で拡張）。
 *
 * 検索対象は最低限「ツール名・説明・カテゴリ」を含める必要があるため、
 * カテゴリの表示名（例:「画像」）もハイスタックに加える
 * （カテゴリ名はcategories.ts＝Registryを唯一の情報源とし、ここで別名称を作らない）。
 *
 * これまでは入力全体を1つの文字列として扱っていたため、「画像 圧縮」のような
 * 空白区切りの複数語クエリが実質的に機能しなかった（検索バーのプレースホルダーは
 * 複数語検索を例示していたが、実装が伴っていなかった）。
 * 空白でトークンに分割し、すべてのトークンが少なくとも1つのハイスタックに
 * 一致するツールだけを残すAND検索に変更する。1語だけのクエリは従来と同じ挙動。
 * 重量級の検索エンジンは追加せず、既存のクライアントサイドJSのみで実現する
 * （開発指示書35章：不要な新規npmパッケージを追加しない）。
 */
export function searchTools(tools: Tool[], rawQuery: string): Tool[] {
  const terms = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return tools;

  const scored = tools
    .map((tool) => {
      const haystacks = [
        tool.name.toLowerCase(),
        tool.description.toLowerCase(),
        tool.id.toLowerCase(),
        getCategory(tool.category)?.name.toLowerCase() ?? "",
        ...(tool.keywords ?? []).map((k) => k.toLowerCase()),
      ];

      let totalScore = 0;
      for (const term of terms) {
        const bestForTerm = Math.max(0, ...haystacks.map((h) => matchScore(h, term)));
        if (bestForTerm === 0) {
          // AND検索: いずれか1語でもマッチしないツールは除外する
          return { tool, score: 0, matchedAllTerms: false };
        }
        totalScore += bestForTerm;
      }
      return { tool, score: totalScore, matchedAllTerms: true };
    })
    .filter((entry) => entry.matchedAllTerms);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.tool);
}
