import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { siteConfig } from "@/lib/config/site";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { featureFlags } from "@/lib/config/features";
import { tools } from "@/lib/tools/data";
import { formatLegalVersion, LEGAL_VERSIONS } from "@/lib/legal/versions";

/** プレミアムのプラン限定として提供しているツールが、実際にあるか（ツール一覧の実際の設定から判定する） */
const premiumOnlyToolsExist = tools.some((t) => t.status === "available" && t.requiredPlan === "premium");

export const metadata: Metadata = {
  title: "利用規約",
  description: `${siteConfig.name}の利用規約です。`,
  alternates: {
    canonical: "/terms",
  },
};

const LINK_CLASS = "text-ms-accent hover:underline dark:text-ms-focus";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-ms-text">{title}</h2>
      {children}
    </section>
  );
}

function Clauses({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>;
}

/**
 * 課金がオフの間の、第3〜6条（会員登録・料金・契約・返金）の本文。
 * 提供していない料金や契約条件を載せないため「定めなし」とする。
 * 条番号と、他の条（第2条など）からの参照を保つため、見出しは残す。
 */
function NotProvided({ reason }: { reason: string }) {
  return (
    <p data-testid="terms-clause-not-provided">
      {reason}
      提供を始める場合は、あらかじめ本サイト上でお知らせするよう努め、本規約を改定して定めます（第11条）。
    </p>
  );
}

export default function TermsPage() {
  const premium = PLAN_DEFINITIONS.premium;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-ms-text">利用規約</h1>

      <div className="ms-glass ms-prose-surface flex flex-col gap-8 text-sm leading-relaxed text-ms-text">
        {!featureFlags.billing && (
          <p
            data-testid="terms-billing-notice"
            className="ms-glass px-4 py-3"
          >
            現在、会員登録・有料プラン・広告の表示は、一時的に停止しています。本サービスを恒久的に無料とするものではなく、将来、会員登録・有料プラン・広告の表示を始める場合があります。第3条から第6条については、これらの提供を始める際に定めます。提供を始める場合は、あらかじめ本サイト上でお知らせするよう努めます。
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
                <li>本サービスには、無料プランとプレミアムプランがあります。</li>
                <li>
                  無料プランは、会員登録なしで利用できます。通常ツールは、広告の視聴により一定時間（現在は1時間）利用できる仕組みです。広告視聴の仕組みが有効になっていない間は、広告を視聴しなくても通常ツールを利用できる場合があります。{premiumOnlyToolsExist ? "プレミアム対象ツールは、プレミアムプランでご利用いただけます。" : ""}
                </li>
                <li>
                  プレミアムプランは、会員登録のうえ月額料金をお支払いいただくことで、{featureFlags.ads ? "広告なしで" : ""}すべてのツールを利用できます。あわせて、年度カレンダー作成ツールの「AIで読み取る」補助と、「記入済みPDF→Excel」の「AIで項目を読み取る」補助と、「PDF→Excel」の「AIで表を読み取る」補助（いずれも第2条の2）、および「記入済みPDF→Excel」のページ数・回数の制限なしの利用を、ご利用いただけます。通常の年度カレンダー作成と、通常のPDF→Excel、通常の記入済みPDF→Excel（自動抽出・テンプレート）は、AIを使わずに利用できます。
                </li>
                <li>
                  旧スタンダードプラン（月額550円）は、新規のお申し込みを終了しました。旧プラン（スタンダードプラン、月額980円のプレミアムプラン）でご契約済みの方は、新しい料金への移行が完了するまで、ご契約時の内容・料金のまま提供します。移行の方法と時期は、あらためてご案内します。
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

        {featureFlags.billing && (
          <Section title="第2条の2（AIによる読み取り補助）">
            <Clauses>
              <li>
                「AIで読み取る」は、プレミアムプランの機能で、年度カレンダー作成ツールで読み込んだ予定表（Excel・CSV・PDF・画像）の読み取りを、AI（外部のAIサービス）で補助する機能です。Excel・CSV・文字情報のあるPDFでは、通常の読み取りで日付や予定名を認識できなかった行を、画像・文字情報のないPDF（スキャン）では、画像に写った予定を、AIで読み取ります。「AIで項目を読み取る」は、記入済みPDF→Excelツールで、文字情報のあるPDFの文字（1つのPDFの最大5ページ、合計6,000文字まで）を、AIで項目ごとの表に整理する補助です（スキャンしたPDFは対象外です）。「AIで表を読み取る」は、PDF→Excelツールで、文字情報のあるPDFの文字（同じく最大5ページ、合計6,000文字まで）を、AIで表の行に整理する補助です（スキャンしたPDFは対象外です）。他のツールには、AIによる機能はありません。
              </li>
              <li>
                AIに送信されるのは、ユーザーの操作により選んだ内容だけです。表の場合は、ユーザーが画面で選んだ行・列の文字、画像・文字情報のないPDFの場合は、ブラウザ内で縮小した画像（PDFは先頭の最大4ページ）、「AIで項目を読み取る」「AIで表を読み取る」の場合は、PDFから取り出した文字です（「AIで表を読み取る」でスキャンしたページを読み取るときは、ブラウザ内で縮小した画像（最大4ページ）と、ブラウザ内の文字認識で読み取った文字を送ります）。ファイルそのものは送信しません。送信する内容は、実行の前に画面で確認でき、実行のたびに、ユーザーが送信に同意した場合にのみ処理を行います。画像に写っている文字や、PDFから取り出した文字は、すべてAIに送られます。個人情報、機密情報、第三者の情報など、送信したくない内容は、選択から外してください。
              </li>
              <li>
                AIの読み取り結果は「提案」です。誤りや推測が含まれることがあり、自動では採用されません。ユーザーが元のファイルと見比べて内容を確認し、必要に応じて修正したうえで、採用するかどうかを決めてください。採用した予定やExcelの内容については、ユーザーが責任を負うものとします。
              </li>
              <li>
                AIの利用には、請求期間（Stripeの契約期間）ごとに上限があり、AIトークンという単位で残量を表示します。AIトークンは、本サービス内の利用量を示す単位で、金銭その他と交換することはできません。上限に達した場合は、次の請求期間まで、AIによる読み取りを利用できません。通信の不具合などで処理の結果を確認できなかった場合は、その分の利用枠がすぐには戻らないことがあります。
              </li>
              <li>
                AIの機能は、外部サービスの状況により、一時的に利用できない場合があります。利用できない場合も、通常の年度カレンダー作成、通常のPDF→Excel、通常の記入済みPDF→Excelと、Excel・PDFの出力は利用できます。
              </li>
              <li>
                AIへ送信した内容の取り扱いについては、
                <Link href="/privacy" className={`mx-1 ${LINK_CLASS}`}>
                  プライバシーポリシー
                </Link>
                をご確認ください。
              </li>
            </Clauses>
          </Section>
        )}

        <Section title="第3条（会員登録）">
          {featureFlags.billing ? (
            <Clauses>
              <li>有料プランのご利用には、メールアドレスとパスワードによる会員登録が必要です。</li>
              <li>ユーザーは、登録情報を正確に保ち、パスワードを自己の責任で管理するものとします。</li>
              <li data-testid="terms-consent-record-clause">
                会員登録の際には、本規約とプライバシーポリシーへの同意を確認します。同意した場合、運営者は、同意した文書の種類・版・日時を、会員のアカウントに関連付けて記録します。本規約またはプライバシーポリシーを改定した場合、その後に有料プランをお申し込みいただく際に、あらためて同意をお願いすることがあります。
              </li>
              <li data-testid="terms-account-deletion-clause">
                ユーザーは、アカウント画面の「アカウントの削除」から、いつでも、ご自身のアカウントを削除できます。削除すると、アカウントと関連するデータは元に戻せません（取り扱いは、プライバシーポリシーに従います）。有料プランのご契約が続いている間は、アカウントを削除できません。先に解約し、契約期間が終了してから削除してください。アカウントを削除しても、お支払い済みの料金の返金は行いません（第6条）。
              </li>
              <li>
                登録情報の取り扱いは、
                <Link href="/privacy" className={`mx-1 ${LINK_CLASS}`}>
                  プライバシーポリシー
                </Link>
                に従います。
              </li>
            </Clauses>
          ) : (
            <NotProvided reason="現在、会員登録は提供していないため、本条は定めていません。" />
          )}
        </Section>

        <Section title="第4条（料金・お支払い）">
          {featureFlags.billing ? (
            <Clauses>
              <li>
                有料プランの料金は、プレミアムプランが月額{premium.priceYen.toLocaleString()}円（税込）です。旧料金でご契約済みの方は、第2条のとおり、移行が完了するまでご契約時の料金で請求されます。
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
          ) : (
            <NotProvided reason="現在、有料プランは提供しておらず、料金のお支払いはないため、本条は定めていません。" />
          )}
        </Section>

        <Section title="第5条（契約期間・更新・解約）">
          {featureFlags.billing ? (
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
          ) : (
            <NotProvided reason="現在、有料プランは提供していないため、本条は定めていません。" />
          )}
        </Section>

        <Section title="第6条（返金）">
          {featureFlags.billing ? (
            <p>
              デジタルサービスの性質上、法令に定める場合を除き、お支払い済みの料金の返金は行いません。日割り計算も行いません。
            </p>
          ) : (
            <NotProvided reason="現在、お支払いが発生するサービスは提供していないため、本条は定めていません。" />
          )}
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
              運営者は、必要に応じて、本サービスの内容を変更し、または提供を中断・終了することがあります。AIによる読み取り補助は、外部サービスの提供状況や費用により、内容を変更し、または提供を終了することがあります。
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

        <p className="text-xs text-ms-muted">最終更新日: {formatLegalVersion(LEGAL_VERSIONS.terms)}</p>
      </div>
    </div>
  );
}
