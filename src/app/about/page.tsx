import type { Metadata } from "next";
import Link from "next/link";
import { CategoryIcon } from "@/components/ui/category-icon";
import { categories } from "@/lib/tools/categories";
import { siteConfig } from "@/lib/config/site";
import { featureFlags } from "@/lib/config/features";

export const metadata: Metadata = {
  title: "Mr.Sattoとは",
  // 課金がオフの間は、実際に提供していない「料金プラン」に触れない説明文にする
  description: featureFlags.billing
    ? `${siteConfig.name}（${siteConfig.tagline}）がどんなサービスか、対応分野・料金プラン・プライバシー設計について紹介します。`
    : `${siteConfig.name}（${siteConfig.tagline}）がどんなサービスか、対応分野・プライバシー設計について紹介します。`,
  alternates: {
    canonical: "/about",
  },
};

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-ms-text">
        {siteConfig.name}とは
      </h1>
      <p className="mb-10 text-lg font-medium text-ms-accent dark:text-ms-focus">
        {siteConfig.tagline}
      </p>

      <div className="flex flex-col gap-10 text-sm leading-relaxed text-ms-text">
        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
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
          <h2 className="mb-2 text-base font-semibold text-ms-text">
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
                className="ms-glass ms-glass-interactive flex flex-col items-center gap-1 p-3 text-center text-xs text-ms-muted"
              >
                <CategoryIcon id={category.id} size="sm" />
                {category.name}
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            これから目指す姿
          </h2>
          <p>
            現在の{siteConfig.name}は、ツールを1つずつ選んで使う「ツール一覧型」のサービスです。
            将来的には、たとえば
          </p>
          <blockquote className="ms-glass my-3 border-l-4 border-l-ms-accent px-4 py-3 italic text-ms-text">
            「この10枚の画像をInstagram用サイズにして、容量を小さくして、連番で名前をつけてZIPにして」
          </blockquote>
          <p>
            のように依頼するだけで、必要な処理を自動的に組み合わせて実行できる
            「作業を依頼できるサービス」への拡張を目指しています。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            大事にしていること
          </h2>
          <p>
            機能を増やすことよりも、シンプルで分かりやすく、初めての方でもすぐ使えることを
            優先しています。スマートフォンでも快適に使えるよう設計しており、
            多くの処理はファイルをサーバーに送信せずお使いのブラウザ内で完結します。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            {featureFlags.billing ? "料金プランについて" : "ご利用料金について"}
          </h2>
          {!featureFlags.billing ? (
            <p>
              {siteConfig.name}は現在、会員登録なしで、無料でご利用いただけます。
              {featureFlags.ads ? "ダウンロードの際に、広告をご覧いただく場合があります。" : ""}
              {featureFlags.ads
                ? "今後、有料プランを導入する場合があります。"
                : "今後、広告の表示や有料プランを導入する場合があります。"}
              その際は、本サイト上でお知らせします。
            </p>
          ) : (
            <p>
              {siteConfig.name}は会員登録なしでもすぐに使い始められます。
              {featureFlags.ads
                ? "無料プランでも、広告を見れば通常ツールを一定時間利用できます。広告なしで使いたい方、AIによる読み取り補助を使いたい方向けに、すべてのツールを広告なしで使えるプレミアムプラン（月額1,100円・税込）もご用意しています。"
                : "通常のツールは、無料プランで、広告なしでご利用いただけます。AIによる読み取り補助を使いたい方向けに、プレミアムプラン（月額1,100円・税込）もご用意しています。"}
              詳しい内容は
              <Link href="/pricing" className="text-ms-accent hover:underline dark:text-ms-focus">
                料金プラン
              </Link>
              のページをご覧ください。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            もっと知りたい方へ
          </h2>
          <p>
            ファイルの取り扱いについては
            <Link href="/privacy" className="text-ms-accent hover:underline dark:text-ms-focus">
              プライバシーポリシー
            </Link>
            を、ご利用条件については
            <Link href="/terms" className="text-ms-accent hover:underline dark:text-ms-focus">
              利用規約
            </Link>
            をご確認ください。
          </p>
        </section>
      </div>
    </div>
  );
}
