"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import {
  AUTH_LINK_MESSAGES,
  classifyAuthLinkError,
  isCodeVerifierMissing,
  parseAuthLinkParams,
  type AuthLinkProblem,
} from "@/lib/auth/auth-link";

/**
 * パスワード再設定メールのリンクを開いたときの処理（src/app/auth/reset-callback/page.tsx）。
 *
 * 1. URLから認証の値を読み取り、すぐにURLから消す（履歴・画面共有・ブックマークに残さない）。
 * 2. Supabaseが返した失敗（期限切れ・使用済みなど）があれば、その理由を表示する。
 * 3. #access_token（どの端末でも使える方式）は、type=recovery のときだけ受け付け、セッションにする。
 *    ?code（以前のメール）は、このブラウザに残る確認用の値と照合してセッションにする。
 * 4. セッションの持ち主をSupabaseに問い合わせて確かめてから、新しいパスワードの入力画面へ移る。
 *
 * 値は画面の中で使うだけで、保存・送信・ログ出力はしない（セッションの保存は、Supabaseの通常のCookieだけ）。
 */
export function ResetCallbackHandler() {
  const router = useRouter();
  const [problem, setProblem] = useState<AuthLinkProblem | null>(null);
  // 開発時（React の StrictMode）に処理が2回動いても、リンクの値を2回使わないようにする
  const started = useRef(false);

  // この画面を開いたまま、別のメールのリンク（# の後ろだけが違うURL）を開いた場合は、ページの読み込みが起きないので、読み込み直して処理する
  useEffect(() => {
    const onHashChange = () => {
      if (/access_token=|error=|error_code=/.test(window.location.hash)) window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const url = new URL(window.location.href);
    const params = parseAuthLinkParams(url.search, url.hash);
    if (url.search || url.hash) {
      window.history.replaceState(window.history.state, "", url.pathname);
    }

    async function run(): Promise<AuthLinkProblem | null> {
      if (params.error || params.errorCode) return classifyAuthLinkError({ code: params.errorCode });

      const supabase = getSupabaseBrowserClient();
      if (!supabase) return "session";

      if (params.accessToken && params.refreshToken) {
        if (params.type !== "recovery") return "invalid";
        const { error } = await supabase.auth.setSession({
          access_token: params.accessToken,
          refresh_token: params.refreshToken,
        });
        if (error) return classifyAuthLinkError(error);
      } else if (params.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(params.code);
        if (error) {
          // 以前に送ったメールのリンクを、申し込んだのとは別のブラウザで開いた場合。新しいメールのリンクなら使える
          return isCodeVerifierMissing(error) ? "invalid" : classifyAuthLinkError(error);
        }
      } else {
        return "invalid";
      }

      // セッションが実際に有効か、Supabaseに問い合わせて確かめる（Cookieの中身だけを信用しない）
      const { data, error } = await supabase.auth.getUser();
      if (error) return classifyAuthLinkError(error) === "network" ? "network" : "session";
      if (!data.user) return "session";
      return null;
    }

    run()
      .then((result) => {
        if (result) {
          setProblem(result);
          return;
        }
        router.replace("/auth/reset-password");
        router.refresh();
      })
      .catch(() => setProblem("network"));
  }, [router]);

  if (!problem) {
    return (
      <p role="status" aria-live="polite" className="text-center text-sm text-ms-muted" data-testid="reset-callback-working">
        リンクを確認しています…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="reset-callback-error" data-problem={problem}>
      <ErrorMessage message={AUTH_LINK_MESSAGES[problem]} />
      <Link href="/auth/forgot-password" className="w-full text-center ms-btn ms-btn-primary">
        再設定のメールをもう一度送る
      </Link>
    </div>
  );
}
