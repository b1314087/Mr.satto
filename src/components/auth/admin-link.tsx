"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * 管理者としてログインしているときだけ出す「管理画面」リンク。
 *
 * ページ自体は誰にでも同じ内容で配るため（ページを動的にしないため）、ブラウザ側で
 * 「ログインしている人だけ」サーバーに聞く（/api/admin/me）。管理者でなければ、何も表示しない。
 * 表示だけの話で、管理画面の入口は、サーバー側で毎回確認する（src/app/admin/layout.tsx）。
 */
export function AdminLink({ className }: { className?: string }) {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/admin/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { admin?: boolean };
        if (!cancelled) setIsAdmin(data.admin === true);
      } catch {
        // 判定できないときは、出さない
      }
    }

    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      if (data.user) void check();
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
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
