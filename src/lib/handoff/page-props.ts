import { canUseTool } from "@/lib/plans/access";
import type { Plan } from "@/lib/plans/types";
import { getToolById, isListedTool, tools } from "@/lib/tools/data";
import { hasImplementation } from "@/lib/tools/registry";
import type { Tool } from "@/lib/tools/types";
import type { HandoffReceiveSpec, HandoffSendSpec, HandoffTarget } from "./types";

/**
 * ツールページ（サーバー）で、受け渡しの入口（ToolHandoffProvider）へ渡す値を作る（工程16）。
 * ツール一覧（data.ts）は重いため、画面側では読み込まず、ここで必要な分だけに絞って渡す。
 */

export interface HandoffPageProps {
  toolId: string;
  toolName: string;
  hubId?: string;
  send?: HandoffSendSpec;
  receive?: HandoffReceiveSpec;
  receiveBlockedReason: string | null;
  targets: HandoffTarget[];
}

/**
 * 受け渡し先の候補になりうるツール：利用可能・実装あり・一覧に出る（統合済みの旧ページは除く）・受け取りの設定あり。
 * 実際の候補は、結果のファイルを見て画面側で絞り込む（src/lib/handoff/targets.ts）。
 */
export function getHandoffTargets(): HandoffTarget[] {
  return tools
    .filter((t) => t.status === "available" && hasImplementation(t.id) && isListedTool(t) && t.handoff?.receive)
    .map((t) => ({ id: t.id, name: t.name, receive: t.handoff!.receive!, requiredPlan: t.requiredPlan }));
}

let cachedTargets: HandoffTarget[] | null = null;

export function buildHandoffPageProps(tool: Tool, plan: Plan | null): HandoffPageProps {
  cachedTargets ??= getHandoffTargets();
  // 統合済みの旧ページ（例：/tools/pdf-rotate）は、総合ツールと同じ画面なので、送り出しは総合ツールの設定を使う
  const hub = tool.mergedInto ? getToolById(tool.mergedInto) : undefined;
  const allowed = plan === null || canUseTool(plan, tool.requiredPlan).allowed;
  return {
    toolId: tool.id,
    toolName: hub?.name ?? tool.name,
    hubId: hub?.id,
    send: tool.handoff?.send ?? hub?.handoff?.send,
    receive: tool.handoff?.receive,
    receiveBlockedReason: allowed ? null : "このツールは、ご利用中のプランでは使えないため、受け渡されたファイルを受け取れませんでした。",
    targets: cachedTargets,
  };
}
