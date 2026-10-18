import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { siteConfig } from "@/lib/config/site";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { featureFlags } from "@/lib/config/features";

export const metadata: Metadata = {
  title: "利用規約",
  description: `${siteConfig.name}の利用規約です。`,
  alternates: {
    canonical: "/terms",
  },
};

const LINK_CLASS = "text-blue-600 hover:underline dark:text-blue-400";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">{title}</h2>
      {children}
    </section>
  );
}

function Clauses({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>;
}

export default function TermsPage() {
  const standard = PLAN_DEFINITIONS.standard;
  const premium = PLAN_DEFINITIONS.premium;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-neutral-900 dark:text-white">利用規約</h1>

      <div className="flex flex-col gap-8 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {!featureFlags.billing && (
          <p
            data-testid="terms-billing-notice"
            className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900"
          >
            現在、会員登録・有料プラン・広告の表示は、一時的に停止しています。本サービスを恒久的に無料とするものではなく、将来、会員登録・有料プラン・広告の表示を始める場合があります。以下のうち、会員登録・有料プラン・お支払いに関する定めは、これらの提供を始めた場合に適用されます。提供を始める場合は、あらかじめ本サイト上でお知らせするよう努めます。
          </p>
        )}
        <Section title="第1条（適用）">
          <Clauses>
            <li>本規約は、{siteConfig.name}（以下「本サービス」）の利用条件を定めるものです。</li>
            {featureFlags.billing ? (
              <li>
                本サービスの運営者（以下「運営者」）の氏名・所在地・連絡先は、
                <Link href="/tokushoho" className={`mx-1 ${LINK_CLASS}`}>
                  特定商取引法に基づく表記
                </Link>
                のとおり、請求に応じてお知らせします。
              </li>
            ) : (
              <li data-testid="terms-contact-clause">
                本サービスの運営者（以下「運営者」）の氏名・所在地は、請求があった場合には、遅滞なくお知らせします。ご請求やお問い合わせは、
                <a
                  href={siteConfig.contactFormUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`mx-1 ${LINK_CLASS}`}
                >
                  お問い合わせフォーム
                </a>
                またはメール（
                <a href={`mailto:${siteConfig.contactEmail}`} className={LINK_CLASS}>
                  {siteConfig.contactEmail}
                </a>
                ）で受け付けています。
              </li>
            )}
            <li>
              ユーザーは本サービスを利用することで、本規約に同意したものとみなします。会員登録の際には、本規約への同意をあらためて確認します。
            </li>
          </Clauses>
        </Section>

        <Section title="第2条（サービスの内容とプラン）">
          <Clauses>
            <li>
              本サービスは、画像・PDF・ファイル・CSV/Excelなどの変換・加工を目的としたWebツールを、ブラウザ上で提供します。
            </li>
            {featureFlags.billing ? (
              <>
                <li>本サービスには、無料プラン、スタンダードプラン、プレミアムプランがあります。</li>
                <li>
                  無料プランは、会員登録なしで利用できます。スタンダード対象ツールは、広告の視聴により一定時間（現在は1時間）利用できる仕組みです。広告視聴の仕組みが有効になっていない間は、広告を視聴しなくてもスタンダード対象ツールを利用できる場合があります。プレミアム対象ツールは、プレミアムプランでご利用いただけます。
                </li>
                <li>
                  スタンダードプランとプレミアムプランは、会員登録のうえ月額料金をお支払いいただくことで、広告なしで利用できます。スタンダードプランはスタンダード対象ツールを、プレミアムプランはすべてのツールを利用できます。
                </li>
                <li>
                  各ツールをどのプランで利用できるかは、各ツールのページおよび
                  <Link href="/pricing" className={`mx-1 ${LINK_CLASS}`}>
                    料金プラン
                  </Link>
                  のページの表示によります。
                </li>
              </>
            ) : (
              <>
                <li data-testid="terms-current-offering">
                  現在は、すべてのツールを、会員登録なしで無料でご利用いただけます。これは、収益化（有料プラン・広告表示）を一時的に停止していることによるもので、恒久的に無料で提供することをお約束するものではありません。
                </li>
                <li>
                  将来、無料プラン・有料プランの区分、月額料金、広告の表示などを導入し、ツールの利用条件を変更する場合があります。導入する場合は、あらかじめ本サイト上でお知らせするよう努め、必要に応じて本規約を変更します（第11条）。
                </li>
              </>
            )}
          </Clauses>
        </Section>

        <Section title="第3条（会員登録）">
          <Clauses>
            <li>有料プランのご利用には、メールアドレスとパスワードによる会員登録が必要です。</li>
            <li>ユーザーは、登録情報を正確に保ち、パスワードを自己の責任で管理するものとします。</li>
            <li>
              登録情報の取り扱いは、
              <Link href="/privacy" className={`mx-1 ${LINK_CLASS}`}>
                プライバシーポリシー
              </Link>
              に従います。
            </li>
          </Clauses>
        </Section>

        <Section title="第4条（料金・お支払い）">
          <Clauses>
            <li>
              有料プランの料金は、スタンダードプランが月額{standard.priceYen.toLocaleString()}円（税込）、プレミアムプランが月額{premium.priceYen.toLocaleString()}円（税込）です。
            </li>
            <li>
              お支払いは、決済サービスStripeを通じて行います。運営者は、カード情報を保存しません。
            </li>
            <li>
              お申し込みの完了時に初回分を、以降は毎月の更新日に、自動でご請求します。
            </li>
            <li>
              お支払いの確認が取れない間（お支払いの確認中、未払いなど）は、有料プランとしては扱われず、無料プランと同じ扱いになります。
            </li>
            <li>キャンペーンコードをご利用の場合は、そのコードに定められた条件に従います。</li>
          </Clauses>
        </Section>

        <Section title="第5条（契約期間・更新・解約）">
          <Clauses>
            <li>有料プランの契約期間は1か月で、解約しない限り、毎月自動で更新されます。</li>
            <li>
              解約は、アカウント画面の「お支払い方法の変更・解約」から、いつでも行えます。
            </li>
            <li>
              解約後も、現在の契約期間の終了までは、有料プランをご利用いただけます。契約期間の終了後は更新されず、無料プランになります。
            </li>
            <li>
              プランの変更は、アカウント画面の「お支払い方法の変更・解約」から開く、決済サービスの管理画面で行えます（変更できる内容は、その画面に表示されます）。
            </li>
          </Clauses>
        </Section>

        <Section title="第6条（返金）">
          <p>
            デジタルサービスの性質上、法令に定める場合を除き、お支払い済みの料金の返金は行いません。日割り計算も行いません。
          </p>
        </Section>

        <Section title="第7条（禁止事項）">
          <p>ユーザーは本サービスの利用にあたり、以下の行為を行ってはなりません。</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>法令または公序良俗に違反する行為</li>
            <li>本サービスの運営を妨害する行為（過度な負荷をかける行為を含む）</li>
            <li>不正アクセスやその他不正な手段でサービスを利用する行為</li>
            <li>広告の視聴状況や契約状況を、不正な手段で偽る行為</li>
            <li>他のユーザーのアカウントを、無断で利用する行為</li>
            <li>第三者の著作権・肖像権その他の権利を侵害するファイルを処理する行為</li>
            <li>法令に反する目的で本サービスを利用する行為</li>
          </ul>
        </Section>

        <Section title="第8条（利用の停止）">
          <p>
            ユーザーが本規約に違反した場合、運営者は、そのユーザーの本サービスの利用を停止することがあります。
          </p>
        </Section>

        <Section title="第9条（免責事項）">
          <Clauses>
            <li>
              運営者は、本サービスの動作の完全性・正確性・特定目的への適合性を保証するものではありません。処理結果の正確性は、ユーザー自身でご確認ください。
            </li>
            <li>
              運営者は、運営者に故意または重大な過失がある場合や、法令により責任を負う場合を除き、本サービスの利用により生じた損害について責任を負いません。
            </li>
          </Clauses>
        </Section>

        <Section title="第10条（サービスの変更・中断・終了）">
          <Clauses>
            <li>
              運営者は、必要に応じて、本サービスの内容を変更し、または提供を中断・終了することがあります。
            </li>
            <li>有料プランの提供を終了する場合は、本サイト上で事前にお知らせするよう努めます。</li>
          </Clauses>
        </Section>

        <Section title="第11条（規約の変更）">
          <p>
            運営者は、必要と判断した場合、本規約を変更することがあります。変更後の規約は、本ページに掲載した時点から効力を生じます。重要な変更は、本サイト上でお知らせするよう努めます。
          </p>
        </Section>

        <Section title="第12条（準拠法・管轄）">
          <p>
            本規約の解釈にあたっては日本法を準拠法とし、本サービスに関して紛争が生じた場合には、
            運営者の所在地を管轄する裁判所を専属的合意管轄とします。
          </p>
        </Section>

        <p className="text-xs text-neutral-400">最終更新日: 2026年10月</p>
      </div>
    </div>
  );
}
