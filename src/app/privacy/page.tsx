import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description: `${siteConfig.name}のプライバシーポリシーです。`,
  alternates: {
    canonical: "/privacy",
  },
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
            5. 広告配信について
          </h2>
          <p>
            本サービスは、Google AdSenseをはじめとする第三者配信の広告サービスを利用する場合があります。
            このような広告配信事業者は、ユーザーの興味・関心に応じた広告（パーソナライズ広告）を
            表示するために、Cookie（匿名の識別子を含む）を使用することがあります。
          </p>
          <p className="mt-2">
            Googleが広告配信に使用するCookieを無効にしたい場合は、
            <a
              href="https://adssettings.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Googleの広告設定
            </a>
            から行うことができます。また、第三者配信事業者のCookie使用を無効にする方法については、
            <a
              href="https://www.google.com/policies/technologies/ads/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              広告に関するポリシー
            </a>
            のページをご確認ください。
          </p>
          <p className="mt-2">
            広告は「広告」「スポンサーリンク」等と分かるように表示し、ダウンロードボタンなど
            サービスの操作ボタンと誤認されない形で配置します。本ページ執筆時点では実際の広告配信を
            開始していませんが、上記のとおり導入する可能性があるため、あらかじめ記載しています。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            6. Cookie・アクセス解析について
          </h2>
          <p>
            本サービスは、サービス改善やアクセス状況の把握を目的として、Google Analyticsなどの
            アクセス解析ツールを導入する場合があります。これらのツールはCookieを利用してデータを
            収集しますが、氏名・住所・電話番号など個人を特定できる情報は含みません。
            収集されたデータは各サービス提供者のプライバシーポリシーに基づいて管理されます。
          </p>
          <p className="mt-2">
            ブラウザの設定によりCookieの受け入れを拒否することもできますが、その場合、本サービスの
            一部機能が正しく動作しない可能性があります。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            7. お問い合わせ
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
