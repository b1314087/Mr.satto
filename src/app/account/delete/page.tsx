import type { Metadata } from "next";
import Link from "next/link";
import { getServerPlan } from "@/lib/plans/current-plan";
import { hasOpenSubscription } from "@/lib/plans/effective-plan";
import { DeleteAccountForm } from "@/components/account/delete-account-form";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "アカウントの削除",
  description: "Mr.Sattoのアカウントと、関連するデータを削除します。",
  robots: { index: false, follow: false },
};

export default async function DeleteAccountPage() {
  const serverPlan = await getServerPlan();

  if (!serverPlan.userId) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
        <h1 className="mb-3 text-2xl font-bold text-ms-text">アカウントの削除</h1>
        <p className="mb-6 text-sm text-ms-muted">アカウントを削除するには、ログインが必要です。</p>
        <Link href="/login?next=/account/delete" className="ms-btn ms-btn-primary">
          ログイン
        </Link>
      </div>
    );
  }

  const contractOpen = hasOpenSubscription(serverPlan.subscription);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold text-ms-text">アカウントの削除</h1>

      <div className="flex flex-col gap-5 ms-glass p-6 text-sm leading-relaxed text-ms-text">
        <div>
          <p className="mb-2 font-medium">削除すると、次のデータが消え、元に戻せません。</p>
          <ul className="list-disc space-y-1 pl-5 text-ms-muted">
            <li>アカウント（メールアドレス・パスワード）とプロフィール</li>
            <li>契約情報の記録、ツールの利用状況、AI機能の利用記録</li>
            <li>利用規約等への同意の記録</li>
          </ul>
        </div>

        <div className="text-xs text-ms-muted">
          <p className="mb-1">ご注意</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              有料プランのご契約が続いている間は、削除できません。先に、アカウント画面の「契約・お支払いの管理」から解約し、契約期間が終了してから削除してください。
              すでにお支払いいただいた料金の返金は、削除によっては行われません。
            </li>
            <li>
              決済サービス（Stripe）に記録されたお支払いの履歴は、会計・税務上の保存や不正防止などのため、この削除では消えない場合があります。
              詳しくは
              <Link href="/privacy" className="text-ms-accent hover:underline dark:text-ms-focus">
                プライバシーポリシー
              </Link>
              をご確認ください。
            </li>
            <li>バックアップに残るデータの扱いは、プライバシーポリシーをご確認ください。</li>
          </ul>
        </div>

        {contractOpen ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <p className="mb-2">現在、有料プランのご契約が続いているため、削除できません。</p>
            <Link href="/account" className="text-ms-accent hover:underline dark:text-ms-focus">
              アカウント画面で、契約状況の確認・解約をする
            </Link>
          </div>
        ) : (
          <DeleteAccountForm />
        )}

        <p className="text-xs text-ms-muted">
          ご不明な点は、
          <a href={siteConfig.contactFormUrl} target="_blank" rel="noopener noreferrer" className="text-ms-accent hover:underline dark:text-ms-focus">
            お問い合わせフォーム
          </a>
          からご連絡ください。
        </p>
      </div>
    </div>
  );
}
