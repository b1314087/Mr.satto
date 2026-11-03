"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import { canUseBatch } from "./batch-config";

/**
 * 一括処理を始める直前に、サーバーで現在のプランを確認する。
 *
 * 画面に表示しているプランは、ページを開いた時点のもの。その後にログアウトしたり、
 * 契約が終わったりした場合でも、一括処理を使えないようにするため、処理の直前にもう一度確かめる。
 * ファイルの中身はサーバーへ送らない（プランの確認だけを行う）。
 */
export async function checkBatchAccess(): Promise<boolean> {
  const { plan } = await getServerPlan();
  return canUseBatch(plan);
}
