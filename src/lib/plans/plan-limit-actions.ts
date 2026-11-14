"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import { isAllowedCount } from "./tool-limits";

/**
 * ツールの「一度に扱える数」（src/lib/plans/tool-limits.ts）を、処理を始める直前にサーバーのプランで確かめる。
 *
 * 画面の上限は、ページを開いた時点のプランで決まる。その後にログアウトしたり、契約・お試し・無料付与が終わったりしても、
 * 開いたままの画面で多い件数を処理できてしまわないよう、無料の上限を超える件数を処理するときだけ、ここで確認する。
 * ファイルの中身はサーバーへ送らない（ツールの名前と件数だけ）。
 * 引数はブラウザから渡されるので信用しない（知らないツール名・数でない値は、使えないものとして扱う）。
 */
export async function checkPlanLimitAccess(key: string, count: number): Promise<boolean> {
  const { plan } = await getServerPlan();
  return isAllowedCount(key, count, plan);
}
