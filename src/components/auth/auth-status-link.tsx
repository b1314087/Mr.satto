"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * ヘッダーの「ログイン / アカウント」表示専用リンク。
 *
 * 表示の出し分けだけが目的で、権限判定には一切使わない
 * （実際の権限判定は必ずサーバー側の getServerPlan() を経由する。
 * src/lib/auth/user.ts のコメント参照）。ここでの状態はSupabaseの
 * ブラウザセッションを見ているだけの表示用ヒントであり、これを
 * 書き換えても実際のツール利用可否には影響しない。
 */
export function AuthStatusLink() {
  // Supabase未設定の場合は「未ログイン」で確定できるため、初期値として
  // 直接算出する（エフェクト内での同期的なsetStateを避けるため）。
  // 設定済みの場合はセッション確認が終わるまでnull（表示なし）。
  const [signedIn, setSignedIn] = useState<boolean | null>(() =>
    isSupabaseConfigured() ? null : false,
  );

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setSignedIn(data.user !== null);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(session !== null);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (signedIn === null) return null;

  return signedIn ? (
    <Link href="/account" className="hover:text-blue-600 dark:hover:text-blue-400">
      アカウント
    </Link>
  ) : (
    <Link href="/login" className="hover:text-blue-600 dark:hover:text-blue-400">
      ログイン
    </Link>
  );
}
