import { tools } from "./data";

/**
 * 実際に動作する（"available"）ツールIDの一覧。
 * data.ts の `status` を唯一の情報源とし、ここでは重複して手動管理しない
 * （手動管理していると、新しいツールを追加した際に data.ts の status だけ
 *  更新してここの更新を忘れる、という事故が起きやすいため）。
 * サーバー・クライアント双方から参照できるよう、
 * "use client" を付けないプレーンなモジュールに分離している。
 */
export const AVAILABLE_TOOL_IDS: string[] = tools
  .filter((tool) => tool.status === "available")
  .map((tool) => tool.id);

export function hasImplementation(toolId: string): boolean {
  return AVAILABLE_TOOL_IDS.includes(toolId);
}
