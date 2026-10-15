import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { siteConfig } from "@/lib/config/site";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";

export const metadata: Metadata = {
  title: "特定商取引法に基づく表記",
  description: `${siteConfig.name}の有料プランに関する、特定商取引法に基づく表記です。`,
  alternates: {
    canonical: "/tokushoho",
  },
};

const LINK_CLASS = "text-blue-600 hover:underline dark:text-blue-400";

/** 氏名・住所・電話番号は公開せず、請求に応じてお知らせする方針（運営者の判断） */
const DISCLOSE_ON_REQUEST = "請求があった場合には、遅滞なくお知らせします。";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-4 sm:grid-cols-[12rem_1fr] sm:gap-6">
      <dt className="font-semibold text-neutral-900 dark:text-white">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default function TokushohoPage() {
  const standard = PLAN_DEFINITIONS.standard;
  const premium = PLAN_DEFINITIONS.premium;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-neutral-900 dark:text-white">
        特定商取引法に基づく表記
      </h1>
      <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-300">
        {siteConfig.name}の有料プラン（{standard.name}プラン・{premium.name}プラン）に関する表記です。
      </p>

      <dl className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 text-sm leading-relaxed text-neutral-700 dark:divide-neutral-800 dark:border-neutral-800 dark:text-neutral-300">
        <Row label="販売事業者">{DISCLOSE_ON_REQUEST}</Row>
        <Row label="運営統括責任者">{DISCLOSE_ON_REQUEST}</Row>
        <Row label="所在地">{DISCLOSE_ON_REQUEST}</Row>
        <Row label="電話番号">{DISCLOSE_ON_REQUEST}</Row>
        <Row label="お問い合わせ・開示のご請求">
          <p>
            <a
              href={siteConfig.contactFormUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASS}
            >
              お問い合わせフォーム
            </a>
            （Googleフォーム・新しいタブで開きます）、またはメールでお受けしています。
          </p>
          <p className="mt-1">
            メール:{" "}
            <a href={`mailto:${siteConfig.contactEmail}`} className={LINK_CLASS}>
              {siteConfig.contactEmail}
            </a>
          </p>
          <p className="mt-1">
            販売事業者・運営統括責任者・所在地・電話番号は、上記の窓口からご請求ください。
          </p>
        </Row>
        <Row label="販売価格">
          <p>
            {standard.name}プラン: 月額{standard.priceYen.toLocaleString()}円（税込）
          </p>
          <p>
            {premium.name}プラン: 月額{premium.priceYen.toLocaleString()}円（税込）
          </p>
          <p className="mt-1">
            無料プランは0円です。各プランの内容は
            <Link href="/pricing" className={`mx-1 ${LINK_CLASS}`}>
              料金プラン
            </Link>
            のページをご確認ください。
          </p>
        </Row>
        <Row label="商品代金以外の必要料金">
          インターネットの接続料金・通信料は、お客様のご負担となります。
        </Row>
        <Row label="お支払い方法">
          決済サービスStripeを通じたお支払いです。利用できる支払い方法は、お申し込み画面に表示されます。
          カード情報は、{siteConfig.name}では保存しません。
        </Row>
        <Row label="お支払い時期">
          お申し込みの完了時に初回分を、以降は毎月の更新日に、自動でご請求します。
        </Row>
        <Row label="サービスの提供時期">
          お支払い手続きの完了後、すぐにご利用いただけます（契約状況の反映に数秒ほどかかる場合があります）。
        </Row>
        <Row label="契約期間・更新">
          契約期間は1か月です。解約しない限り、毎月自動で更新されます。
        </Row>
        <Row label="解約の方法">
          <p>
            アカウント画面の「お支払い方法の変更・解約」から、いつでも解約できます。
          </p>
          <p className="mt-1">
            解約後も、現在の契約期間の終了までは、有料プランをご利用いただけます。契約期間の終了後は更新されず、無料プランになります。
          </p>
        </Row>
        <Row label="返金・キャンセル">
          デジタルサービスの性質上、法令に定める場合を除き、お支払い済みの料金の返金は行いません。日割り計算も行いません。
        </Row>
        <Row label="お支払いが確認できない場合">
          お支払いの確認が取れない間は、有料プランとしては扱われず、無料プランと同じ扱いになります。
        </Row>
      </dl>

      <p className="mt-6 text-sm text-neutral-600 dark:text-neutral-300">
        サービスの利用条件は
        <Link href="/terms" className={`mx-1 ${LINK_CLASS}`}>
          利用規約
        </Link>
        、個人情報の取り扱いは
        <Link href="/privacy" className={`mx-1 ${LINK_CLASS}`}>
          プライバシーポリシー
        </Link>
        をご確認ください。
      </p>

      <p className="mt-6 text-xs text-neutral-400">最終更新日: 2026年10月</p>
    </div>
  );
}
