import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description: `${siteConfig.name}のプライバシーポリシーです。`,
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-neutral-900 dark:text-white">
        プライバシーポリシー
      </h1>

      <div className="flex flex-col gap-8 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            1. 基本方針
          </h2>
          <p>
            {siteConfig.name}（以下「本サービス」）は、ユーザーがアップロードした画像・PDF・CSVなどのファイルを
            サービス上で恒久的に保存しません。可能な処理はお使いのブラウザ内で完結させ、
            ファイルを外部サーバーへ送信しない設計を基本方針としています。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            2. ブラウザ処理について
          </h2>
          <p>
            画像圧縮・リサイズ・QRコード生成など多くの機能は、JavaScriptによりお使いの端末（ブラウザ）内で
            処理されます。この場合、元のファイルが本サービスのサーバーへ送信されることはありません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            3. サーバー処理について（将来提供予定の機能を含む）
          </h2>
          <p>
            高度なOCRや複雑なPDF変換など、処理速度・精度・端末性能の都合上サーバー処理が適切な機能については、
            将来的にファイルを一時的にサーバーへ送信し処理する場合があります。その場合も、
          </p>
          <p className="mt-2 rounded-lg bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900">
            ファイル送信 → サーバーで一時処理 → 結果を返却 → 一時データを削除
          </p>
          <p className="mt-2">
            という流れを基本とし、ファイルを恒久的に保存することは前提としません。
            ただし、インフラのログや一時ファイルなど、サービス運用環境上の痕跡が
            技術的に「絶対にゼロ」であることまでは保証できません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            4. ブラウザに保存する情報
          </h2>
          <p>
            ダークモード設定や直近に使用したツールなど、ファイルそのものを含まない軽量なUI設定のみを
            お使いの端末のlocalStorageに保存する場合があります。ユーザーがアップロードしたファイル自体を
            localStorageやデータベースに保存することはありません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            5. アクセス解析等
          </h2>
          <p>
            Phase 1時点では、有料の外部API・広告・アカウント機能などは導入していません。
            将来的に利用状況の把握のためアクセス解析ツールを導入する場合は、本ページを更新してお知らせします。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            6. お問い合わせ
          </h2>
          <p>
            本ポリシーに関するお問い合わせは
            <a href={`mailto:${siteConfig.contactEmail}`} className="text-blue-600 hover:underline dark:text-blue-400">
              {siteConfig.contactEmail}
            </a>
            までご連絡ください。
          </p>
        </section>

        <p className="text-xs text-neutral-400">最終更新日: 2026年9月</p>
      </div>
    </div>
  );
}
