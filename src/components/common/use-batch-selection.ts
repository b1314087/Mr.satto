"use client";

import { useState } from "react";
import { useCurrentPlan } from "@/lib/plans/plan-context";
import { featureFlags } from "@/lib/config/features";
import { canUseBatch, getBatchLimit, type BatchToolKey } from "@/lib/batch/batch-config";
import { checkBatchAccess } from "@/lib/batch/batch-access-actions";

/** 一括処理についての案内（選んだファイルを減らしたとき・プランを確認できなかったときに出す） */
export type BatchNotice =
  | { kind: "premium"; keptName: string }
  | { kind: "limit"; limit: number; dropped: number }
  | { kind: "revoked" };

/**
 * 一括処理に対応したツールで、選ばれたファイルをプランに合わせて受け付ける（共通の部品）。
 *
 * - プレミアム：上限（src/lib/batch/batch-config.ts）までのファイルをまとめて受け付ける。
 * - 無料・スタンダード：最初の1ファイルだけを受け付け、一括処理はプレミアムの機能だと案内する
 *   （1ファイルずつの処理は、これまでどおりそのまま使える）。
 * - 処理を始める直前に confirmBatch() でサーバーにもプランを確認する（表示だけに頼らない）。
 */
export function useBatchSelection(key: BatchToolKey) {
  const plan = useCurrentPlan();
  const limit = getBatchLimit(key);
  const [revoked, setRevoked] = useState(false);
  const [notice, setNotice] = useState<BatchNotice | null>(null);
  const batchAllowed = canUseBatch(plan) && !revoked;

  /**
   * 新しく選ばれたファイルを、今のファイルの一覧に反映した結果を返す。
   * mode が "append" なら今の一覧の後ろに足し、"replace" なら選び直しとして入れ替える。
   */
  function pick(current: readonly File[], incoming: readonly File[], mode: "append" | "replace"): File[] {
    if (incoming.length === 0) return [...current];
    if (!batchAllowed) {
      const tooMany = incoming.length > 1 || (mode === "append" && current.length > 0);
      setNotice(tooMany ? { kind: "premium", keptName: incoming[0].name } : null);
      return [incoming[0]];
    }
    const merged = mode === "append" ? [...current, ...incoming] : [...incoming];
    if (merged.length > limit) {
      setNotice({ kind: "limit", limit, dropped: merged.length - limit });
      return merged.slice(0, limit);
    }
    setNotice(null);
    return merged;
  }

  /**
   * 処理を始める直前に呼ぶ。2ファイル以上を処理するときは、サーバーでプランを確認する。
   * 使えない場合は案内を出して false を返す（呼び出し側は処理を始めない）。
   */
  async function confirmBatch(count: number): Promise<boolean> {
    if (count <= 1) return true;
    if (!featureFlags.billing) return true;
    let ok = false;
    try {
      ok = await checkBatchAccess();
    } catch {
      ok = false;
    }
    if (!ok) {
      setRevoked(true);
      setNotice({ kind: "revoked" });
    }
    return ok;
  }

  return {
    batchAllowed,
    limit,
    notice,
    clearNotice: () => setNotice(null),
    pick,
    confirmBatch,
  };
}
