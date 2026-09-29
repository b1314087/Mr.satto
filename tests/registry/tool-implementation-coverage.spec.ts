import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { tools } from "@/lib/tools/data";
import { getRelatedTools } from "@/lib/tools/related-tools";

/**
 * Tool Registry整合性テスト（Phase 23 追加）。
 *
 * 既存の tests/registry/tool-registry.spec.ts は data.ts の status を基準に
 * AVAILABLE_TOOL_IDS（registry.ts）との整合性を検証しているが、実際に
 * ツール詳細ページ（src/app/tools/[tool]/page.tsx）が「ツールを表示するか
 * ComingSoonを表示するか」を判定する hasImplementation() は data.ts の
 * status だけを見ており、実装コンポーネント本体
 * （src/components/tools/tool-registry.tsx の switch文/IMAGE_TOOL_IDS）に
 * 実際に対応するcaseが存在するかまでは検証していなかった。
 *
 * そのため、開発者がdata.tsで新しいツールをstatus:"available"にしただけで
 * tool-registry.tsx側へcaseを追加し忘れた場合、ページ自体はHTTP 200を返す
 * （既存テストの「200で開ける」チェックだけでは検知できない）が、
 * ToolImplementation()のswitch文がdefault: return nullに落ちて
 * 中身が空白のツールページが公開されてしまう、という不整合が発生しうる。
 * このテストはその不整合をソース静的解析で検知する。
 */

function readToolRegistrySource(): string {
  const filePath = path.join(process.cwd(), "src/components/tools/tool-registry.tsx");
  return fs.readFileSync(filePath, "utf8");
}

function extractImplementedToolIds(source: string): Set<string> {
  const caseIds = [...source.matchAll(/case\s+"([a-z0-9-]+)"\s*:/g)].map((m) => m[1]);
  const imageSetMatch = source.match(/IMAGE_TOOL_IDS = new Set\(\[([\s\S]*?)\]\)/);
  const imageIds = imageSetMatch ? [...imageSetMatch[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]) : [];
  return new Set([...caseIds, ...imageIds]);
}

test.describe("Tool Registry × 実装コンポーネントの整合性", () => {
  test("status=availableの全ツールが、tool-registry.tsxに対応するcase/IMAGE_TOOL_IDSを持つ", () => {
    const source = readToolRegistrySource();
    const implemented = extractImplementedToolIds(source);
    const availableTools = tools.filter((t) => t.status === "available");

    const missing = availableTools.filter((t) => !implemented.has(t.id));
    expect(
      missing.map((t) => t.id),
      "data.tsではavailableだが、tool-registry.tsxのToolImplementation()に対応する" +
        "case/IMAGE_TOOL_IDSが無い（実際のツールページが空白になる）"
    ).toEqual([]);
  });

  test("tool-registry.tsxのcase/IMAGE_TOOL_IDSに、data.tsに存在しない・coming-soonなIDが無い", () => {
    const source = readToolRegistrySource();
    const implemented = extractImplementedToolIds(source);
    const idStatus = new Map(tools.map((t) => [t.id, t.status]));

    const stale = [...implemented].filter((id) => idStatus.get(id) !== "available");
    expect(
      stale,
      "tool-registry.tsxに実装があるが、data.ts側でavailableになっていない（削除済み/coming-soonのまま" +
        "実装だけ残っている）ID"
    ).toEqual([]);
  });
});

test.describe("関連ツール（Related Tools）の整合性", () => {
  const availableTools = tools.filter((t) => t.status === "available");

  for (const tool of availableTools) {
    test(`[${tool.id}] 関連ツールに自分自身・存在しないID・非公開ツールを含まない`, () => {
      const { related } = getRelatedTools(tool);

      expect(related.some((r) => r.id === tool.id), `${tool.id}: 自分自身が関連ツールに含まれている`).toBe(false);

      for (const r of related) {
        const found = tools.find((t) => t.id === r.id);
        expect(found, `${tool.id}: 関連ツール${r.id}がdata.tsに存在しない`).toBeTruthy();
        expect(found?.status, `${tool.id}: 関連ツール${r.id}が"available"ではない`).toBe("available");
      }
    });
  }
});
