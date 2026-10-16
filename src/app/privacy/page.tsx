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
            {siteConfig.name}（以下「本サービス」）は、ユーザーが選択した画像・PDF・CSV・Word・Excel・動画・音声などのファイルを、本サービスのサーバーへ送信したり保存したりしない設計としています。現在提供しているツールは、ファイルの処理をお使いのブラウザ（端末）の中で行います。
          </p>
          <p className="mt-2">
            一方、会員登録・ログイン・料金プランのお支払いなど、アカウントに関する機能では、後述のとおり必要な情報をサーバーで取り扱います。ファイルの処理と、アカウントに関する処理は区別してご説明します。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            2. ファイルの処理について（ブラウザ内で完結）
          </h2>
          <p>
            画像の編集・変換、PDFの結合・分割・編集、CSV・Excel・Wordの整形・変換、動画・音声の変換・圧縮、二次元コードの生成、OCR（文字認識）、背景除去など、本サービスのツールによるファイルの処理は、JavaScriptやWebAssemblyによりお使いのブラウザ内で行われます。選択したファイルの内容や処理結果が、本サービスのサーバーへ送信されることはありません。
          </p>
          <p className="mt-2">
            OCRや背景除去などで使用するプログラムや学習済みモデル、フォントのデータは、本サービス自身のサイトから端末へ読み込まれます。ファイルの内容をこれらの配信元へ送るものではありません。
          </p>
          <p className="mt-2">
            処理した結果のファイルは、ユーザーの端末にダウンロードされます。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            3. サーバーで取り扱う情報（会員機能・料金プラン）
          </h2>
          <p>
            ファイルの処理とは別に、会員登録・ログイン・料金プランに関する機能では、次の情報を取り扱います。これらは、本サービスが利用する外部サービス（Supabase、Stripe）上で管理されます。
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>会員登録・ログイン：メールアドレスとパスワードを、認証サービス（Supabase）で管理します。パスワードは暗号化（ハッシュ化）されて保存され、本サービス側で内容を見ることはできません。確認メールやパスワード再設定のメールが送信されます。</li>
            <li>料金プラン（有料プラン）：お支払いはStripeの決済画面で行われます。カード番号などの決済情報は、Stripeが取り扱い、本サービスは受け取りも保存もしません。本サービスには、プランの判定に必要な情報（Stripeの顧客ID・契約ID、プランの種類、契約の状態、更新日など）のみを保存します。</li>
            <li>広告の視聴状況：広告を視聴して一定時間（15分間）ツールを利用できる仕組み（リワード広告）が有効な場合、利用可能な期限を示す署名付きのCookieをお使いのブラウザに保存します。このCookieには、期限の時刻と署名のみが含まれ、氏名やメールアドレスなどは含まれません。</li>
            <li>利用回数：現在、ツールの利用回数をサーバーに新たに記録する処理は行っていません。過去の利用制限のために記録した「回数」のみのログ（ツール・日付ごと）が残っている場合がありますが、ファイルの内容や処理結果は含まれません。</li>
            <li>アクセスログ：本サービスはVercelを利用して提供しており、サーバー運用に伴うアクセスログの取り扱いはVercelの仕様によります。本サービス自身が、アクセスログを独自に収集・保存する処理は実装していません。</li>
          </ul>
          <p className="mt-2">
            将来、サーバーでファイルを処理する機能を提供する場合は、事前に本ポリシーを改定してお知らせします。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            4. ブラウザに保存する情報
          </h2>
          <p>
            ダークモード・ライトモードなどの表示設定を、お使いの端末のlocalStorageに保存する場合があります。また、ログイン状態の維持や、前述の広告視聴状況の確認のために、Cookieを使用します。ユーザーが選択したファイルそのものを、localStorageやCookie、データベースに保存することはありません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            5. 広告配信について
          </h2>
          <p>
            本サービスは、Google AdSenseをはじめとする第三者配信の広告サービスの利用を前提に、広告枠を設けています。広告を視聴して一定時間利用できる仕組みでは、Google Ad Managerのリワード広告を使用します（リワード広告が有効になるまでは使用しません）。実際に広告が表示されるかどうかは、各広告サービスの審査・配信状況によります。
            広告配信事業者は、ユーザーの興味・関心に応じた広告（パーソナライズ広告）を
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
            サービスの操作ボタンと誤認されない形で配置します。広告が表示されない場合や、広告の内容が変わる場合があります。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            6. Cookie・アクセス解析について
          </h2>
          <p>
            本サービスは、ログイン状態の維持と、広告視聴後の利用可能期限の確認のためにCookieを使用します。広告を配信する場合には、広告配信事業者もCookieを使用することがあります（前条をご確認ください）。
          </p>
          <p className="mt-2">
            現在、Google Analyticsなどのアクセス解析ツールは導入していません。今後導入する場合は、本ポリシーを改定してお知らせします。
          </p>
          <p className="mt-2">
            ブラウザの設定によりCookieの受け入れを拒否することもできますが、その場合、ログインなど本サービスの一部機能が正しく動作しない可能性があります。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-neutral-900 dark:text-white">
            7. お問い合わせ
          </h2>
          <p>
            お問い合わせ、不具合の報告、機能改善のご提案は、Googleフォームの
            <a
              href={siteConfig.contactFormUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 text-blue-600 hover:underline dark:text-blue-400"
            >
              お問い合わせフォーム
            </a>
            から受け付けています。フォームに入力された内容は、本サービスのサーバーやデータベースではなく、
            Googleのサービス上で管理され、お問い合わせへの対応およびサービスの改善のために利用します。
            フォームで取得する項目は、フォームの画面に表示されるものに限ります。
          </p>
          <p className="mt-2">
            本ポリシーに関するお問い合わせは
            <a href={`mailto:${siteConfig.contactEmail}`} className="text-blue-600 hover:underline dark:text-blue-400">
              {siteConfig.contactEmail}
            </a>
            でも受け付けています。
          </p>
        </section>

        <p className="text-xs text-neutral-400">最終更新日: 2026年10月</p>
      </div>
    </div>
  );
}
