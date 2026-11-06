"use client";

import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * ブラウザ側の「表示用」ログイン確認を、1ページにつき1回にまとめる。
 *
 * これまで、ヘッダーの「ログイン／アカウント」表示・「管理画面」リンク（ヘッダーとメニューの2か所）・
 * フッター広告の判定が、それぞれ別々に supabase.auth.getUser()（Supabaseへの通信）を呼び、
 * 管理画面リンクは /api/admin/me を1つの部品で2回（getUser の後と、ログイン状態の通知の後）呼んでいた。
 * ここで同じ結果を共有し、通信を1回にする。
 *
 * - 確認の仕方は変えない（getUser：Supabaseに問い合わせてトークンを確かめる。getSession には変えない）。
 * - 表示のためだけのもの。ツールの利用可否・権限は、これまでどおりサーバー側（getServerPlan など）で毎回確かめる。
 * - ログイン・ログアウト・ユーザー情報の変更があったら、まとめた結果を捨てて、次に聞かれたときに確かめ直す。
 *   （トークンの自動更新 TOKEN_REFRESHED と、最初の通知 INITIAL_SESSION では、ログインしている人は変わらないので捨てない）
 * - 結果はこのページ（タブ）の中だけで持つ。保存はしない。
 */

let userPromise: Promise<User | null> | null = null;
let adminPromise: { userId: string; promise: Promise<boolean> } | null = null;
let listening = false;
/** getUser で確かめ終わった人のID（まだ確かめていない・未ログインなら null） */
let confirmedUserId: string | null = null;

function listenOnce() {
  if (listening) return;
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  listening = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
    // 読み込み直後、保存されていたセッションを読み戻したときにも SIGNED_IN が届く（確認の途中でも届く）。
    // 確認済みの人と別の人に変わったときだけ捨てる。未ログインの結果は持たないので、ログインした後は必ず確かめ直す。
    if (event === "SIGNED_IN" && !(confirmedUserId && session?.user?.id !== confirmedUserId)) return;
    userPromise = null;
    adminPromise = null;
    confirmedUserId = null;
  });
}

/** ログインしている人（表示用）。Supabase未設定・未ログイン・確認できないときは null */
export function getBrowserUser(): Promise<User | null> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return Promise.resolve(null);
  listenOnce();
  if (!userPromise) {
    const p = supabase.auth
      .getUser()
      .then(({ data }) => data.user ?? null)
      .catch(() => null);
    userPromise = p;
    // 確認できなかった（null）ときは、次に聞かれたときに確かめ直す（通信の一時的な失敗を、ページを開いている間ずっと引きずらない）
    void p.then((user) => {
      if (userPromise !== p) return;
      if (user) confirmedUserId = user.id;
      else userPromise = null;
    });
  }
  return userPromise;
}

/** 管理者か（表示用。/api/admin/me に聞く）。同じ人については、1ページにつき1回だけ聞く */
export function getBrowserAdminStatus(userId: string): Promise<boolean> {
  if (adminPromise && adminPromise.userId === userId) return adminPromise.promise;
  // null＝判定できなかった（通信の失敗・サーバーのエラー）。表示は「管理者ではない」と同じ扱いにする
  const checked: Promise<boolean | null> = fetch("/api/admin/me", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as { admin?: boolean };
      return data.admin === true;
    })
    .catch(() => null);
  const entry = { userId, promise: checked.then((admin) => admin === true) };
  adminPromise = entry;
  // 判定できなかったときだけ、次に聞かれたときに聞き直す（「管理者ではない」という答えは、このページの間は使い回す）
  void checked.then((admin) => {
    if (admin === null && adminPromise === entry) adminPromise = null;
  });
  return entry.promise;
}
