import "server-only";

import { cookies, headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth/user";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { supabaseServiceConfig } from "@/lib/supabase/service-config";
import {
  FALLBACK_MARK_COOKIE,
  fallbackClaimantHash,
  isFallbackMarkForToday,
  msUntilNextJstMidnight,
  signFallbackMark,
  type FallbackIdentity,
} from "./fallback-claim-core";

/**
 * 広告が出ないときの救済（1日1回・日本時間）を記録する（src/lib/plans/fallback-grant-policy.ts の説明を参照）。
 *
 * 結果：
 *   "claimed"   今日はじめて救済を使った（記録した）
 *   "used"      今日はすでに使っている
 *
 * データベースの記録が使えない（未設定・テーブル未作成・通信の失敗）ときは、署名付きCookieだけで1日1回にする。
 * 保存するのは「その日だけ有効な識別値」と日付だけ。ファイルや、その内容・名前は受け取らない。
 */
export type FallbackClaimResult = "claimed" | "used";

function cookieSecret(): string | null {
  return process.env.TEMP_ACCESS_SECRET || null;
}

function hashSecret(): string | null {
  return process.env.VISIT_HASH_SECRET || supabaseServiceConfig.serviceRoleKey || null;
}

async function currentIdentity(): Promise<FallbackIdentity> {
  const user = await getCurrentUser().catch(() => null);
  if (user) return { kind: "user", userId: user.id };
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return { kind: "anonymous", ip, userAgent: h.get("user-agent") ?? "" };
}

/** データベースに今日の救済を記録する。true = 今回はじめて記録した、false = すでにある、null = 使えない */
async function claimInDatabase(identity: FallbackIdentity, now: Date): Promise<boolean | null> {
  const service = getSupabaseServiceClient();
  const secret = hashSecret();
  if (!service || !secret) return null;
  try {
    const { data, error } = await service.rpc("claim_ad_fallback", { p_claimant_hash: fallbackClaimantHash(secret, identity, now) });
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

/** 今日すでに救済を使ったか（Cookie の印だけを見る。データベースへの記録はしない） */
export async function hasClaimedFallbackToday(now: Date = new Date()): Promise<boolean> {
  const secret = cookieSecret();
  if (!secret) return false;
  const cookieStore = await cookies();
  return isFallbackMarkForToday(secret, cookieStore.get(FALLBACK_MARK_COOKIE)?.value, now);
}

export async function claimDailyFallback(now: Date = new Date()): Promise<FallbackClaimResult> {
  if (await hasClaimedFallbackToday(now)) return "used";
  const identity = await currentIdentity();
  const db = await claimInDatabase(identity, now);
  // データベースで「すでにある」と分かった場合も、Cookieに印を付けて、次からはデータベースに問い合わせない
  await setMark(now);
  if (db === false) return "used";
  return "claimed";
}

async function setMark(now: Date): Promise<void> {
  const secret = cookieSecret();
  if (!secret) return;
  const cookieStore = await cookies();
  cookieStore.set(FALLBACK_MARK_COOKIE, signFallbackMark(secret, now), {
    maxAge: Math.ceil(msUntilNextJstMidnight(now) / 1000),
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
}
