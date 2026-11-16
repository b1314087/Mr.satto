import type { Metadata } from "next";
import { ResetCallbackHandler } from "@/components/auth/reset-callback-handler";

/**
 * パスワード再設定メール内のリンクの遷移先（URLは以前のまま。Supabaseの「Redirect URLs」の設定も変えずに済む）。
 *
 * 以前はサーバー側の処理（route.ts）で、?code= を同じブラウザの確認用の値と照合していたため、
 * 申し込んだブラウザ以外（スマートフォンのメールアプリなど）で開くと失敗していた。
 * 今は、この画面（ブラウザ側）で次の2つを受け付ける。
 *   - #access_token=…（新しい方式。どのブラウザ・端末で開いても使える。src/lib/supabase/client.ts）
 *   - ?code=…（以前に送ったメールのリンク。申し込んだのと同じブラウザで開いた場合だけ使える）
 * 認証が終わったら、新しいパスワードの入力画面（/auth/reset-password）へ移る。
 */
export const metadata: Metadata = {
  title: "パスワードの再設定を確認しています",
  description: "パスワード再設定のリンクを確認しています。",
  robots: { index: false, follow: false },
  // このページのURLには、認証の値が付くことがある。外部へ送られないようにする（# の後ろはもともと送られない）
  referrer: "no-referrer",
};

export default function ResetCallbackPage() {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-ms-text">パスワードを再設定</h1>
      <div className="ms-glass p-6">
        <ResetCallbackHandler />
      </div>
    </div>
  );
}
