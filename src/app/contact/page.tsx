import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "お問い合わせ",
  description: `${siteConfig.name}へのお問い合わせ方法です。`,
  alternates: {
    canonical: "/contact",
  },
};

export default function ContactPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="mb-4 text-2xl font-bold text-neutral-900 dark:text-white">お問い合わせ</h1>
      <p className="mb-8 text-sm text-neutral-600 dark:text-neutral-300">
        不具合のご報告、ツールのご要望、その他お問い合わせは下記メールアドレスまでご連絡ください。
        内容を確認の上、順次対応いたします。
      </p>

      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">メールでのお問い合わせ</p>
        <a
          href={`mailto:${siteConfig.contactEmail}`}
          className="mt-1 inline-block text-lg font-semibold text-blue-600 hover:underline dark:text-blue-400"
        >
          {siteConfig.contactEmail}
        </a>
      </div>

      <div className="mt-8 rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        <p className="font-medium text-neutral-700 dark:text-neutral-200">よくあるお問い合わせ</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>新しいツールの追加リクエスト</li>
          <li>特定のファイル形式で変換がうまくいかない場合のご報告</li>
          <li>「準備中」のツールの公開予定について</li>
        </ul>
      </div>
    </div>
  );
}
