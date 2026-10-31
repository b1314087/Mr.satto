import { canUseTool } from "@/lib/plans/access";
import type { Plan } from "@/lib/plans/types";
import type { HandoffFileInfo, HandoffFileKind, HandoffReceiveSpec, HandoffSendSpec, HandoffTarget } from "./types";

/**
 * 受け渡し先の判定（工程16）。ツールIDどうしを直接比べる条件は書かず、設定（config.ts）だけで決める。
 *
 * 候補になる条件（すべて満たすこと）：
 * 1. 送り元が送り出しを宣言している
 * 2. 送り先が受け取りを宣言している（未設定なら候補にしない）
 * 3. 送り元・送り先が同じツールではない（同じ画面への受け渡しは意味がない）
 * 4. すべてのファイルの種類が、送り先の受け取れる種類に含まれる
 * 5. ファイル数が、送り先の上限以内
 * 6. 各ファイルのサイズが、送り先の上限以内（0バイトは渡さない）
 * 7. 利用者のプランで送り先のツールを使える
 * 向き（有向）は、送り元の send と送り先の receive の組み合わせだけで決まる。
 */

export interface HandoffSource {
  /** いま開いているツールのID */
  toolId: string;
  /** 統合済みのツールのページで開いている場合の、総合ツールのID（自分自身への受け渡しを除くため） */
  hubId?: string;
  send?: HandoffSendSpec;
}

const MB = 1024 * 1024;

function kindAccepted(receive: HandoffReceiveSpec, kind: HandoffFileKind | null): boolean {
  if (receive.kinds === "any") return true;
  return kind !== null && receive.kinds.includes(kind);
}

function isSelf(source: HandoffSource, target: HandoffTarget): boolean {
  return target.id === source.toolId || (source.hubId !== undefined && target.id === source.hubId);
}

function planAllows(target: HandoffTarget, plan: Plan | null): boolean {
  // プラン不明（ツールページの外など）は、送り先のページ側の利用制限に任せる
  if (plan === null) return true;
  return canUseTool(plan, target.requiredPlan).allowed;
}

/** 送り先が、このファイルの組をそのまま受け取れるか */
export function canReceiveFiles(receive: HandoffReceiveSpec, files: readonly HandoffFileInfo[]): boolean {
  if (files.length === 0 || files.length > receive.maxFiles) return false;
  return files.every((f) => f.size > 0 && f.size <= receive.maxFileSizeMB * MB && kindAccepted(receive, f.kind));
}

/** 実際のファイルをもとに、受け渡し先の候補を返す（設定の順） */
export function findHandoffTargets(
  source: HandoffSource,
  files: readonly HandoffFileInfo[],
  targets: readonly HandoffTarget[],
  plan: Plan | null
): HandoffTarget[] {
  if (!source.send) return [];
  return targets.filter((t) => !isSelf(source, t) && planAllows(t, plan) && canReceiveFiles(t.receive, files));
}

/**
 * 処理の前に「ほかのツールで使う」を出すかの事前判定。送り出しうる種類のどれかを受け取れる送り先が1つでもあれば true。
 * サイズ・数は結果が出るまで分からないため、ここでは見ない（実際の候補は findHandoffTargets で結果のファイルから決める）。
 */
export function hasPotentialHandoffTargets(source: HandoffSource, targets: readonly HandoffTarget[], plan: Plan | null): boolean {
  const send = source.send;
  if (!send || send.kinds.length === 0) return false;
  return targets.some(
    (t) => !isSelf(source, t) && planAllows(t, plan) && send.kinds.some((kind) => kindAccepted(t.receive, kind))
  );
}

/** 候補が1つもないときに、利用者へ伝える理由（いちばん近い理由を1つ） */
export function describeNoTarget(
  source: HandoffSource,
  files: readonly HandoffFileInfo[],
  targets: readonly HandoffTarget[],
  plan: Plan | null
): string {
  if (files.length === 0) return "受け渡せるファイルがありません。ダウンロードしてお使いください。";
  const others = targets.filter((t) => !isSelf(source, t) && planAllows(t, plan));
  const byKind = others.filter((t) => files.every((f) => kindAccepted(t.receive, f.kind)));
  if (byKind.length === 0) return "この形式のファイルを受け取れるツールはありません。ダウンロードしてお使いください。";
  const byCount = byKind.filter((t) => files.length <= t.receive.maxFiles);
  if (byCount.length === 0) return `ファイルが${files.length}個あり、受け取れるツールの上限を超えています。ダウンロードしてお使いください。`;
  if (files.some((f) => f.size === 0)) return "空のファイルは受け渡せません。";
  return "ファイルが大きすぎるため、受け取れるツールがありません。ダウンロードしてお使いください。";
}
