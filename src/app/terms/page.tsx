import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "利用規約",
  description: `${siteConfig.name}の利用規約です。`,
  alternates: {
    canonical: "/terms",
  },
};

export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-neutral-900 dark:text-white">利用規約</h1>

      <div className="flex flex-col gap-8 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第1条（適用）
          </h2>
          <p>
            本規約は、{siteConfig.name}（以下「本サービス」）の利用条件を定めるものです。
            ユーザーは本サービスを利用することで、本規約に同意したものとみなします。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第2条（サービスの内容）
          </h2>
          <p>
            本サービスは、画像・PDF・ファイル・CSV/Excelなどの変換・加工を目的としたWebツールを
            無料で提供します。会員登録は不要です。将来的に一部機能を有料化する場合は、
            事前に本サイト上でお知らせします。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第3条（禁止事項）
          </h2>
          <p>ユーザーは本サービスの利用にあたり、以下の行為を行ってはなりません。</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>法令または公序良俗に違反する行為</li>
            <li>本サービスの運営を妨害する行為（過度な負荷をかける行為を含む）</li>
            <li>不正アクセスやその他不正な手段でサービスを利用する行為</li>
            <li>第三者の著作権・肖像権その他の権利を侵害するファイルを処理する行為</li>
            <li>法令に反する目的で本サービスを利用する行為</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第4条（免責事項）
          </h2>
          <p>
            本サービスは現状有姿で提供され、動作の完全性・正確性・特定目的への適合性について
            いかなる保証も行いません。本サービスの利用により生じた損害について、運営者は
            法令で認められる範囲で責任を負わないものとします。処理結果の正確性は必ずユーザー自身でご確認ください。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第5条（サービスの変更・中断・終了）
          </h2>
          <p>
            運営者は、ユーザーへの事前通知なく、本サービスの内容を変更し、または提供を中断・終了することが
            できるものとします。これによりユーザーに生じた損害について、運営者は責任を負いません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第6条（規約の変更）
          </h2>
          <p>
            運営者は、必要と判断した場合、ユーザーへの通知なく本規約を変更できるものとします。
            変更後の規約は、本ページに掲載した時点で効力を生じます。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            第7条（準拠法・管轄）
          </h2>
          <p>
            本規約の解釈にあたっては日本法を準拠法とし、本サービスに関して紛争が生じた場合には、
            運営者の所在地を管轄する裁判所を専属的合意管轄とします。
          </p>
        </section>

        <p className="text-xs text-neutral-400">最終更新日: 2026年9月</p>
      </div>
    </div>
  );
}
