import type { Metadata } from "next";
import Link from "next/link";
import { categories } from "@/lib/tools/categories";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "Mr.Sattoとは",
  description: `${siteConfig.name}（${siteConfig.tagline}）がどんなサービスか、対応分野・料金プラン・プライバシー設計について紹介します。`,
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-neutral-900 dark:text-white">
        {siteConfig.name}とは
      </h1>
      <p className="mb-10 text-lg font-medium text-blue-600 dark:text-blue-400">
        {siteConfig.tagline}
      </p>

      <div className="flex flex-col gap-10 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            名前の由来
          </h2>
          <p>
            「{siteConfig.name}」は、Mr. と「サッと」を組み合わせた名前です。
            画像、PDF、CSV、ファイル、仕事や学生の作業、クリエイターの制作など、
            「ちょっと面倒」「すぐ処理したい」と感じる作業を、簡単かつ素早く解決できる存在を
            目指しています。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            今できること
          </h2>
          <p className="mb-4">
            {siteConfig.name}は、PDFの変換・結合、画像のリサイズ・圧縮、CSV・Excelの整形、ファイル名の一括変更やZIP作成といった、
            仕事や学生の作業で「ちょっと面倒」と感じやすい用途のツールを、ブラウザ上ですぐに使える形で提供しています。
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {categories.map((category) => (
              <Link
                key={category.id}
                href={`/tools/${category.id}`}
                className="flex flex-col items-center gap-1 rounded-lg border border-neutral-200 bg-white p-3 text-center text-xs text-neutral-600 transition-colors hover:border-blue-300 hover:text-blue-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-blue-700 dark:hover:text-blue-400"
              >
                <span className="text-xl" aria-hidden="true">
                  {category.icon}
                </span>
                {category.name}
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            これから目指す姿
          </h2>
          <p>
            現在の{siteConfig.name}は、ツールを1つずつ選んで使う「ツール一覧型」のサービスです。
            将来的には、たとえば
          </p>
          <blockquote className="my-3 rounded-lg border-l-4 border-blue-400 bg-blue-50 px-4 py-3 italic text-neutral-700 dark:border-blue-600 dark:bg-blue-950/30 dark:text-neutral-300">
            「この10枚の画像をInstagram用サイズにして、容量を小さくして、連番で名前をつけてZIPにして」
          </blockquote>
          <p>
            のように依頼するだけで、必要な処理を自動的に組み合わせて実行できる
            「作業を依頼できるサービス」への拡張を目指しています。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            大事にしていること
          </h2>
          <p>
            機能を増やすことよりも、シンプルで分かりやすく、初めての方でもすぐ使えることを
            優先しています。スマートフォンでも快適に使えるよう設計しており、
            多くの処理はファイルをサーバーに送信せずお使いのブラウザ内で完結します。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            料金プランについて
          </h2>
          <p>
            {siteConfig.name}は会員登録なしでもすぐに使い始められます。無料プランでも、広告を見れば
            スタンダード対象ツールを一定時間利用できます。広告なしで使いたい方向けにスタンダードプラン
            （月額550円）、すべてのツールを広告なしで使えるプレミアムプラン（月額980円）もご用意しています。
            詳しい内容は
            <Link href="/pricing" className="text-blue-600 hover:underline dark:text-blue-400">
              料金プラン
            </Link>
            のページをご覧ください。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            もっと知りたい方へ
          </h2>
          <p>
            ファイルの取り扱いについては
            <Link href="/privacy" className="text-blue-600 hover:underline dark:text-blue-400">
              プライバシーポリシー
            </Link>
            を、ご利用条件については
            <Link href="/terms" className="text-blue-600 hover:underline dark:text-blue-400">
              利用規約
            </Link>
            をご確認ください。ご意見・ご要望は
            <Link href="/contact" className="text-blue-600 hover:underline dark:text-blue-400">
              お問い合わせ
            </Link>
            からお気軽にどうぞ。
          </p>
        </section>
      </div>
    </div>
  );
}
