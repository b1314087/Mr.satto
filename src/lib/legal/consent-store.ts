import "server-only";

import { getSupabaseServiceClient } from "@/lib/supabase/service";
import {
  buildConsentRows,
  missingConsents,
  type ConsentSource,
} from "./consent";
import type { LegalDocument } from "./versions";

/**
 * 同意の記録の読み書き（サーバー専用）。terms_consents テーブルは、Service Role だけが読み書きできる
 * （supabase/migrations/0004_terms_consents.sql）。ブラウザから同意の記録を作る・書き換える経路は無い。
 *
 * 呼び出し元は、userId を必ず検証済みのセッション（getCurrentUser）または Supabase Auth の応答から得ること。
 * ブラウザから送られた値をそのまま渡してはならない。
 */

/** 現行の版への同意を記録する。すでに記録があれば何もしない（追記専用・重複なし）。成功したら true */
export async function recordCurrentConsents(userId: string, source: ConsentSource): Promise<boolean> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return false;
  const { error } = await supabase
    .from("terms_consents")
    .upsert(buildConsentRows(userId, source), { onConflict: "user_id,document,version", ignoreDuplicates: true });
  if (error) {
    // ユーザーの識別子と、エラーの種類だけを記録する（メールアドレス等は出さない）
    console.error("[consent] failed to record", { userId, code: error.code });
    return false;
  }
  return true;
}

export type ConsentState = { ok: true; missing: LegalDocument[] } | { ok: false };

/** 現行の版への同意がまだ無い文書を調べる。読み取れなかったとき（テーブル未作成など）は ok:false */
export async function getConsentState(userId: string): Promise<ConsentState> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { ok: false };
  const { data, error } = await supabase.from("terms_consents").select("document, version").eq("user_id", userId);
  if (error) {
    console.error("[consent] failed to read", { userId, code: error.code });
    return { ok: false };
  }
  return { ok: true, missing: missingConsents(data ?? []) };
}
