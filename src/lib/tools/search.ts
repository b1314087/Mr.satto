import type { Tool } from "./types";

/**
 * ツール検索（13章）。名前・説明・キーワードを対象に部分一致で検索する。
 * 大量のツールを追加しても探しやすいよう、シンプルなスコアリングを行う。
 */
export function searchTools(tools: Tool[], rawQuery: string): Tool[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return tools;

  const scored = tools
    .map((tool) => {
      const haystacks = [
        tool.name.toLowerCase(),
        tool.description.toLowerCase(),
        tool.id.toLowerCase(),
        ...(tool.keywords ?? []).map((k) => k.toLowerCase()),
      ];

      let score = 0;
      for (const h of haystacks) {
        if (h === query) score += 10;
        else if (h.startsWith(query)) score += 5;
        else if (h.includes(query)) score += 2;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.tool);
}
