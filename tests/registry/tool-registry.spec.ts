import { test, expect } from "@playwright/test";
import { tools } from "@/lib/tools/data";
import { AVAILABLE_TOOL_IDS, hasImplementation } from "@/lib/tools/registry";
import { categories } from "@/lib/tools/categories";
import { PLAN_IDS } from "@/lib/plans/types";

/**
 * Tool Registry整合性テスト（Phase 14 優先度1位）。
 *
 * `src/lib/tools/data.ts` の `tools` 配列を単一の情報源としてデータ駆動で検証するため、
 * 将来ツールが追加・変更されても、このテストファイル自体を書き換えずに
 * 自動的に検証対象が広がる（Phase 14の要件どおり）。
 */

const VALID_STATUS = ["available", "coming-soon"];
const VALID_PROCESSOR = ["browser", "server", "auto"];
const VALID_CATEGORY_IDS = categories.map((c) => c.id);
const VALID_REQUIRED_PLAN = PLAN_IDS.filter((p) => p !== "free"); // "standard" | "premium"

test.describe("Tool Registry整合性", () => {
  test("tools配列が空でない", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  test("重複するtool IDが存在しない", () => {
    const ids = tools.map((t) => t.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates, `重複ID: ${duplicates.join(", ")}`).toEqual([]);
  });

  for (const tool of tools) {
    test(`[${tool.id}] 必須メタデータが揃っている`, () => {
      expect(tool.id, "idが空").toBeTruthy();
      expect(tool.name, `${tool.id}: nameが空`).toBeTruthy();
      expect(tool.description, `${tool.id}: descriptionが空`).toBeTruthy();
      expect(VALID_CATEGORY_IDS, `${tool.id}: 未知のcategory "${tool.category}"`).toContain(tool.category);
      expect(VALID_STATUS, `${tool.id}: 未知のstatus "${tool.status}"`).toContain(tool.status);
      expect(VALID_PROCESSOR, `${tool.id}: 未知のprocessor "${tool.processor}"`).toContain(tool.processor);
      expect(
        VALID_REQUIRED_PLAN,
        `${tool.id}: requiredPlanは"standard"か"premium"のみが有効（"free"は無効）`
      ).toContain(tool.requiredPlan);
      // id は URL の一部として使われるため、kebab-case（半角英数字とハイフンのみ）であること。
      expect(tool.id, `${tool.id}: idはkebab-case（半角英数字とハイフン）である必要があります`).toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/
      );
    });
  }

  test("status=availableのツールはすべてAVAILABLE_TOOL_IDSに含まれる（registry.tsとdata.tsの整合性）", () => {
    const availableInData = tools.filter((t) => t.status === "available").map((t) => t.id);
    for (const id of availableInData) {
      expect(hasImplementation(id), `${id}: data.tsではavailableだがhasImplementation()がfalse`).toBe(true);
    }
    expect(new Set(AVAILABLE_TOOL_IDS)).toEqual(new Set(availableInData));
  });

  test("coming-soonのツールはAVAILABLE_TOOL_IDSに含まれない", () => {
    const comingSoon = tools.filter((t) => t.status === "coming-soon").map((t) => t.id);
    for (const id of comingSoon) {
      expect(AVAILABLE_TOOL_IDS, `${id}: coming-soonなのにAVAILABLE_TOOL_IDSに含まれている`).not.toContain(id);
    }
  });
});

test.describe("Tool Registry × 実ページ（HTTPレベルの整合性）", () => {
  const availableTools = tools.filter((t) => t.status === "available" && hasImplementation(t.id));

  test("利用可能なツールは1つ以上存在する", () => {
    expect(availableTools.length).toBeGreaterThan(0);
  });

  for (const tool of availableTools) {
    test(`[${tool.id}] ページが200で開ける`, async ({ page }) => {
      const response = await page.goto(`/tools/${tool.id}`);
      expect(response?.status(), `/tools/${tool.id} が200以外`).toBe(200);
    });
  }

  const comingSoonTools = tools.filter((t) => t.status === "coming-soon");
  for (const tool of comingSoonTools) {
    test(`[${tool.id}] coming-soonページも200で開ける（準備中表示）`, async ({ page }) => {
      const response = await page.goto(`/tools/${tool.id}`);
      expect(response?.status(), `/tools/${tool.id} (coming-soon) が200以外`).toBe(200);
    });
  }
});
