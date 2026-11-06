"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getBrowserAdminStatus, getBrowserUser } from "@/lib/auth/browser-session";

/**
 * 管理者としてログインしているときだけ出す「管理画面」リンク。
 *
 * ページ自体は誰にでも同じ内容で配るため（ページを動的にしないため）、ブラウザ側で
 * 「ログインしている人だけ」サーバーに聞く（/api/admin/me）。管理者でなければ、何も表示しない。
 * 表示だけの話で、管理画面の入口は、サーバー側で毎回確認する（src/app/admin/layout.tsx）。
 *
 * ログインの確認と /api/admin/me への問い合わせは、ヘッダーとメニューの両方の部品で共有し、
 * 1ページにつき1回にまとめる（src/lib/auth/browser-session.ts）。
 */
export function AdminLink({ className }: { className?: string }) {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;

    async function check() {
      const user = await getBrowserUser();
      if (cancelled) return;
      if (!user) {
        setIsAdmin(false);
        return;
      }
      const admin = await getBrowserAdminStatus(user.id);
      if (!cancelled) setIsAdmin(admin);
    }

    void check();
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      // 最初の通知（INITIAL_SESSION）と、トークンの自動更新では、ログインしている人は変わらないので聞き直さない
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if (session) void check();
      else setIsAdmin(false);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (!isAdmin) return null;
  return (
    <Link href="/admin" className={className} data-testid="admin-link">
      管理画面
    </Link>
  );
}
