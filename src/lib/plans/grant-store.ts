import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { TRIAL_DAYS, grantEndMs, isGrantActive, type GrantSource, type PremiumGrant } from "./grants";

/**
 * プレミアムの付与（premium_grants）と、無料お試しの記録（premium_trial_claims）の読み書き。
 * テーブルは supabase/migrations/0008_premium_grants.sql（手動適用）。まだ適用していない間は、
 * 「付与なし」として動く（読み取り）／「まだ準備できていない」と返す（書き込み）。
 *
 * 書き込みは Service Role（RLSを経由しない）。呼び出し元が、必ず「管理者」または「ログイン中の本人」を確認してから使う。
 */

const TABLE_MISSING_CODES = new Set(["42P01", "PGRST205"]);

interface RawGrant {
  user_id: string;
  source: string;
  starts_at: string;
  ends_at: string;
  note?: string | null;
}

function toGrant(row: RawGrant | null | undefined): PremiumGrant | null {
  if (!row || (row.source !== "admin" && row.source !== "trial")) return null;
  return { source: row.source, startsAt: row.starts_at, endsAt: row.ends_at };
}

/** ログイン中の本人の付与（期限切れでも返す。有効かどうかは isGrantActive で判定する） */
export async function fetchOwnGrant(userId: string): Promise<PremiumGrant | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("premium_grants")
    .select("user_id, source, starts_at, ends_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return toGrant(data as RawGrant);
}

export interface GrantListEntry extends PremiumGrant {
  note: string | null;
  /** いま有効か（取得した時点で判定） */
  active: boolean;
}

/** 管理画面用: 全員の付与（管理者と確認した呼び出し元だけが使う） */
export async function fetchAllGrants(): Promise<{ status: "ok" | "not_ready" | "unavailable"; map: Map<string, GrantListEntry> }> {
  const map = new Map<string, GrantListEntry>();
  const nowMs = Date.now();
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { status: "unavailable", map };
  const { data, error } = await supabase.from("premium_grants").select("user_id, source, starts_at, ends_at, note").limit(5000);
  if (error) return { status: TABLE_MISSING_CODES.has(error.code ?? "") ? "not_ready" : "unavailable", map };
  for (const row of (data ?? []) as RawGrant[]) {
    const grant = toGrant(row);
    if (grant) map.set(row.user_id, { ...grant, note: row.note ?? null, active: isGrantActive(grant, nowMs) });
  }
  return { status: "ok", map };
}

export type GrantWriteResult = { ok: true; endsAt: string } | { ok: false; reason: "not_ready" | "unavailable" | "invalid" };

/** 付与する（すでにあれば上書き）。期限は days（1〜上限の整数）か、endMs（終了時刻）のどちらかで指定する */
export async function grantPremium(args: {
  userId: string;
  source: GrantSource;
  days?: number;
  endMs?: number;
  grantedBy: string | null;
  note?: string | null;
  nowMs?: number;
}): Promise<GrantWriteResult> {
  const now = args.nowMs ?? Date.now();
  const end = args.endMs ?? (args.days === undefined ? null : grantEndMs(now, args.days));
  if (end === null || end <= now) return { ok: false, reason: "invalid" };
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { ok: false, reason: "unavailable" };
  const row = {
    user_id: args.userId,
    source: args.source,
    starts_at: new Date(now).toISOString(),
    ends_at: new Date(end).toISOString(),
    granted_by: args.grantedBy,
    note: args.note ? args.note.slice(0, 200) : null,
    updated_at: new Date(now).toISOString(),
  };
  const { error } = await supabase.from("premium_grants").upsert(row, { onConflict: "user_id" });
  if (error) return { ok: false, reason: TABLE_MISSING_CODES.has(error.code ?? "") ? "not_ready" : "unavailable" };
  return { ok: true, endsAt: row.ends_at };
}

/** 付与を取り消す（行を消す）。無料お試しの「使った記録」は残る */
export async function revokeGrant(userId: string): Promise<{ ok: boolean }> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { ok: false };
  const { error } = await supabase.from("premium_grants").delete().eq("user_id", userId);
  return { ok: !error };
}

export type TrialResult =
  | { ok: true; endsAt: string }
  | { ok: false; reason: "already_used" | "already_active" | "not_ready" | "unavailable" };

/**
 * 3日間の無料お試しを始める（アカウントごとに1回だけ）。
 * 先に「使った記録」を入れる（主キーの重複で、同時に2回押されても1回だけ通る）。付与に失敗したら、記録を戻す。
 */
export async function startTrial(userId: string, nowMs: number = Date.now()): Promise<TrialResult> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { ok: false, reason: "unavailable" };

  // いま有効な付与があるときは、始めない（管理者の付与を、お試しで短く上書きしないため）
  const { data: existing, error: readError } = await supabase
    .from("premium_grants")
    .select("user_id, source, starts_at, ends_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return { ok: false, reason: TABLE_MISSING_CODES.has(readError.code ?? "") ? "not_ready" : "unavailable" };
  if (isGrantActive(toGrant(existing as RawGrant | null), nowMs)) return { ok: false, reason: "already_active" };

  const { error: claimError } = await supabase.from("premium_trial_claims").insert({ user_id: userId });
  if (claimError) {
    if (claimError.code === "23505") return { ok: false, reason: "already_used" };
    return { ok: false, reason: TABLE_MISSING_CODES.has(claimError.code ?? "") ? "not_ready" : "unavailable" };
  }

  const granted = await grantPremium({ userId, source: "trial", days: TRIAL_DAYS, grantedBy: null, nowMs });
  if (!granted.ok) {
    await supabase.from("premium_trial_claims").delete().eq("user_id", userId);
    return { ok: false, reason: granted.reason === "not_ready" ? "not_ready" : "unavailable" };
  }
  return { ok: true, endsAt: granted.endsAt };
}

/** 無料お試しを、すでに使ったか（読み取れないときは「使った」とみなして、ボタンを出さない） */
export async function hasUsedTrial(userId: string): Promise<boolean> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return true;
  const { data, error } = await supabase.from("premium_trial_claims").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) return true;
  return Boolean(data);
}
