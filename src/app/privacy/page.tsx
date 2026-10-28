import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";
import { featureFlags } from "@/lib/config/features";
import { formatLegalVersion, LEGAL_VERSIONS } from "@/lib/legal/versions";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description: `${siteConfig.name}のプライバシーポリシーです。`,
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  // 機能スイッチ（src/lib/config/features.ts）の状態に応じて、実際に提供していない機能の
  // 説明を出さないよう、記述を出し分ける（広告・課金を再開すると、元の説明が自動で表示される）。
  const { ads, billing } = featureFlags;
  const cookiePurposes = [billing && "ログイン状態の維持", ads && "前述の広告視聴状況の確認"]
    .filter(Boolean)
    .join("や、");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-ms-text">
        プライバシーポリシー
      </h1>

      <div className="ms-glass ms-prose-surface flex flex-col gap-8 text-sm leading-relaxed text-ms-text">
        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            1. 基本方針
          </h2>
          <p>
            {siteConfig.name}（以下「本サービス」）は、ユーザーが選択した画像・PDF・CSV・Word・Excel・動画・音声などのファイルを、本サービスのサーバーへ送信したり保存したりしない設計としています。現在提供しているツールは、ファイルの処理をお使いのブラウザ（端末）の中で行います。
          </p>
          {billing && (
            <p className="mt-2">
              ただし、プレミアムプランの「AIで読み取る」補助を、ユーザーご自身が選んで、送信内容を確認し、同意して実行した場合に限り、選んだ行・列の文字、または縮小した画像（画像ファイルや、文字情報のないPDFのページ）をAIサービスへ送信します（詳しくは「AIによる読み取り補助について」をご覧ください）。それ以外の場合に、ファイルの内容が送信されることはありません。
            </p>
          )}
          {billing && (
            <p className="mt-2">
              一方、会員登録・ログイン・料金プランのお支払いなど、アカウントに関する機能では、後述のとおり必要な情報をサーバーで取り扱います。ファイルの処理と、アカウントに関する処理は区別してご説明します。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            2. ファイルの処理について（ブラウザ内で完結）
          </h2>
          <p>
            画像の編集・変換、PDFの結合・分割・編集、CSV・Excel・Wordの整形・変換、動画・音声の変換・圧縮、二次元コードの生成、OCR（文字認識）、背景除去など、本サービスのツールによるファイルの処理は、JavaScriptやWebAssemblyによりお使いのブラウザ内で行われます。選択したファイルの内容や処理結果が、本サービスのサーバーへ送信されることはありません{billing ? "（ユーザーが同意して実行した、AIによる読み取り補助を除きます）" : ""}。
          </p>
          <p className="mt-2">
            OCRや背景除去などで使用するプログラムや学習済みモデル、フォントのデータは、本サービス自身のサイトから端末へ読み込まれます。ファイルの内容をこれらの配信元へ送るものではありません。
          </p>
          <p className="mt-2">
            処理した結果のファイルは、ユーザーの端末にダウンロードされます。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            {billing ? "3. サーバーで取り扱う情報（会員機能・料金プラン）" : "3. サーバーで取り扱う情報"}
          </h2>
          <p>
            {billing
              ? "ファイルの処理とは別に、会員登録・ログイン・料金プランに関する機能では、次の情報を取り扱います。これらは、本サービスが利用する外部サービス（Supabase、Stripe）上で管理されます。"
              : "現在、本サービスは、会員登録・ログイン・有料プランを一般のご利用者向けには提供していません。ファイルの処理とは別に、次の情報を取り扱う場合があります。会員登録や有料プランの提供を始める場合は、取り扱う情報について、本ポリシーを改定してお知らせします。"}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {billing && <li>会員登録・ログイン：メールアドレスとパスワードを、認証サービス（Supabase）で管理します。パスワードは暗号化（ハッシュ化）されて保存され、本サービス側で内容を見ることはできません。確認メールやパスワード再設定のメールが送信されます。</li>}
            {billing && <li>料金プラン（有料プラン）：お支払いはStripeの決済画面で行われます。カード番号などの決済情報は、Stripeが取り扱い、本サービスは受け取りも保存もしません。本サービスには、プランの判定に必要な情報（Stripeの顧客ID・契約ID、プランの種類、契約の状態、更新日など）のみを保存します。</li>}
            {ads && <li>広告の視聴状況：広告を視聴して一定時間（1時間）ツールを利用できる仕組み（リワード広告）が有効な場合、利用可能な期限を示す署名付きのCookieをお使いのブラウザに保存します。このCookieには、期限の時刻と署名のみが含まれ、氏名やメールアドレスなどは含まれません。</li>}
            {billing && <li data-testid="privacy-consent-record">同意の記録：会員登録時、およびアカウント画面で同意した際に、利用規約・プライバシーポリシーに同意した事実として、ユーザーの識別子、文書の種類、文書の版、同意した日時、同意した経路（会員登録時またはアカウント画面）を、本サービスのデータベース（Supabase）に記録します。メールアドレスやIPアドレスは、この記録には含めません。この記録は、アカウントを削除すると、あわせて削除されます。</li>}
            {billing && <li>AIの利用枠の管理：AIによる読み取り補助の上限を管理するため、ユーザーの識別子、請求期間、利用日時、使用したAIモデルの種類、使用量（AIトークンに換算できる値）を記録します。送信した文字や画像、AIの出力、元のファイルは、この記録に含まれず、本サービスのサーバーやデータベースに保存しません。</li>}
            <li>利用回数：現在、ツールの利用回数をサーバーに新たに記録する処理は行っていません。過去の利用制限のために記録した「回数」のみのログ（ツール・日付ごと）が残っている場合がありますが、ファイルの内容や処理結果は含まれません。</li>
            <li>アクセスログ：本サービスはVercelを利用して提供しており、サーバー運用に伴うアクセスログの取り扱いはVercelの仕様によります。本サービス自身が、アクセスログを独自に収集・保存する処理は実装していません。</li>
          </ul>
          <p className="mt-2">
            {billing
              ? "AIによる読み取り補助のほかに、サーバーでファイルを処理する機能を提供する場合は、事前に本ポリシーを改定してお知らせします。"
              : "将来、サーバーでファイルを処理する機能を提供する場合は、事前に本ポリシーを改定してお知らせします。"}
          </p>
        </section>

        {billing && (
          <section data-testid="privacy-ai">
            <h2 className="mb-2 text-base font-semibold text-ms-text">
              3-2. AIによる読み取り補助について（プレミアムプラン）
            </h2>
            <p>
              年度カレンダー作成ツールの「AIで読み取る」は、外部のAIサービス（OpenAI社のAPI）で、予定表を読み取る補助です。ほかのツールでは、AIは使いません。通常の年度カレンダー作成（Excel・CSV・文字情報のあるPDFの読み取りを含みます）は、AIを使わずに、お使いのブラウザの中だけで処理されます。なお、ログイン・プランの確認・AIの利用枠の記録のために、本サービスのサーバーと通信することはありますが、通常の処理で、ファイルの内容が送信されることはありません。
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                対応するファイルと送信する内容：（1）Excel（.xlsx・.xlsm）・CSV（文字情報のあるPDFから読み取った表も同様です）：通常の読み取りで日付や予定名を認識できなかった行のうち、ユーザーが画面で選んだ行・列の文字だけを送信します（最大100行・12列まで、1つのセルは200文字まで、列の見出しは40文字までに切り詰めます）。あわせて、対象年度の範囲と、読み取りの種類（標準・高精度）も送信します。ファイルそのものや、選ばなかった行・列は送信しません。（2）画像（PNG・JPEG）：ブラウザの中でJPEGに縮小した画像を、最大4枚まで送信します。元のファイルは送信しません。（3）PDF：文字情報のあるPDFは、通常はAIを使わず、ブラウザの中で表として読み取ります（その表の行・列を、上の（1）のとおり、選んでAIに送ることはできます）。文字情報のないPDF（スキャンした画像のPDF）、または、ユーザーが「画像としてAIで読み取る」を選んだPDFは、先頭の最大4ページを、ブラウザの中で画像（JPEG）にして送信します。PDFファイルそのものは送信しません。
              </li>
              <li>画像・PDFの注意：送信する画像に写っている文字は、すべてAIに送られます。他の方の個人情報などが写っていないか、送信前に画面で確認してください。送る画像は、実行の前に画面に表示されます。</li>
              <li>同意：実行のたびに、送信内容を確認したうえで同意（チェック）していただいた場合にのみ、送信します。同意は、実行ごとに確認し、次回以降に引き継ぎません。同意がない場合は、本サービスのサーバー側でも、AIによる処理を行いません。通常のツールの利用に、この同意は必要ありません。</li>
              <li>送信先：OpenAIのAPIです。本サービスのサーバーを経由して送信します。APIキーは本サービスのサーバーで管理し、ブラウザには渡しません。</li>
              <li>本サービス側での保存：送信した文字、画像、AIの出力、元のファイルは、本サービスのサーバーやデータベースに保存しません（上記の利用枠の記録を除きます）。AIの処理の記録（ログ）には、処理の結果や利用量などを残しますが、送信した内容やAIの出力は含めません。送信した画像・読み取り結果は、お使いのブラウザの画面の中でのみ保持され、画面を閉じたり、読み込み直したりすると消えます。</li>
              <li>
                OpenAI側での取り扱い：本サービスは、OpenAIの応答を保存しない設定（store=false）で送信します。OpenAIの公式ドキュメント（2026年10月確認）によると、APIに送信したデータは、ユーザーが明示的に提供に同意しない限り、モデルの学習や改善には使われません。一方で、不正利用の監視のための記録（ログ）が、既定で最長30日間保持されることがあり、法令上必要な場合などには、それより長く保持されることがあります。また、画像は、送信時に不正な内容の検査を受け、問題が疑われた場合は、確認のために保持されることがあります。保持の内容や期間は、OpenAIの規約・ポリシーの変更により変わることがあるため、最新の情報は、
                <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer" className="mx-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
                  OpenAIの公式ドキュメント（Data controls in the OpenAI platform）
                </a>
                をご確認ください。
              </li>
              <li>国外での処理：OpenAIは海外の事業者であり、送信した内容は日本国外で処理される場合があります。</li>
              <li>個人情報・機密情報：氏名、連絡先、機密情報など、送信したくない内容を含む行・列・画像は、選択から外してください。他の方の個人情報を含む場合は、その方の同意など、必要な手続きをご自身でご確認ください。</li>
              <li>AIの出力の確認：AIの読み取り結果には、誤りや推測が含まれることがあります。自動では採用されません。元のファイルと見比べて内容を確認したうえで、ご自身の責任で採用してください。</li>
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            4. ブラウザに保存する情報
          </h2>
          <p>
            ダークモード・ライトモードなどの表示設定を、お使いの端末のlocalStorageに保存する場合があります。{cookiePurposes && `また、${cookiePurposes}のために、Cookieを使用します。`}ユーザーが選択したファイルそのものを、localStorageやCookie、データベースに保存することはありません。
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            5. 広告配信について
          </h2>
          {ads ? (
            <>
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
                  className="text-ms-accent hover:underline dark:text-ms-focus"
                >
                  Googleの広告設定
                </a>
                から行うことができます。また、第三者配信事業者のCookie使用を無効にする方法については、
                <a
                  href="https://www.google.com/policies/technologies/ads/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ms-accent hover:underline dark:text-ms-focus"
                >
                  広告に関するポリシー
                </a>
                のページをご確認ください。
              </p>
              <p className="mt-2">
                広告は「広告」「スポンサーリンク」等と分かるように表示し、ダウンロードボタンなど
                サービスの操作ボタンと誤認されない形で配置します。広告が表示されない場合や、広告の内容が変わる場合があります。
              </p>
            </>
          ) : (
            <p>
              現在、本サービスは広告を表示していません。広告の配信を始める場合は、広告配信事業者が使用するCookieなどの取り扱いについて、本ポリシーを改定してお知らせします。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            6. Cookie・アクセス解析について
          </h2>
          <p>
            {billing || ads
              ? `本サービスは、${[
                  billing && "ログイン状態の維持",
                  ads && "広告視聴後（広告を表示できなかった場合の代替の利用権を含みます）の利用可能期限の確認",
                ]
                  .filter(Boolean)
                  .join("と、")}のためにCookieを使用します。${ads ? "広告を配信する場合には、広告配信事業者もCookieを使用することがあります（前条をご確認ください）。" : ""}`
              : "現在、本サービスは、管理上必要な場合を除き、Cookieを使用していません。"}
          </p>
          <p className="mt-2">
            現在、Google Analyticsなどのアクセス解析ツールは導入していません。今後導入する場合は、本ポリシーを改定してお知らせします。
          </p>
          {(billing || ads) && (
            <p className="mt-2">
              ブラウザの設定によりCookieの受け入れを拒否することもできますが、その場合、ログインなど本サービスの一部機能が正しく動作しない可能性があります。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            7. お問い合わせ
          </h2>
          <p>
            お問い合わせ、不具合の報告、機能改善のご提案は、Googleフォームの
            <a
              href={siteConfig.contactFormUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 text-ms-accent hover:underline dark:text-ms-focus"
            >
              お問い合わせフォーム
            </a>
            から受け付けています。フォームに入力された内容は、本サービスのサーバーやデータベースではなく、
            Googleのサービス上で管理され、お問い合わせへの対応およびサービスの改善のために利用します。
            フォームで取得する項目は、フォームの画面に表示されるものに限ります。
          </p>
          <p className="mt-2">
            本ポリシーに関するお問い合わせは
            <a href={`mailto:${siteConfig.contactEmail}`} className="text-ms-accent hover:underline dark:text-ms-focus">
              {siteConfig.contactEmail}
            </a>
            でも受け付けています。
          </p>
        </section>

        <section data-testid="privacy-requests">
          <h2 className="mb-2 text-base font-semibold text-ms-text">
            8. 保有する個人情報の開示・訂正・利用停止・削除のご請求
          </h2>
          <p>
            本サービスが保有するユーザーの個人情報について、開示、訂正、利用停止、削除をご希望の場合は、
            <a
              href={siteConfig.contactFormUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-1 text-ms-accent hover:underline dark:text-ms-focus"
            >
              お問い合わせフォーム
            </a>
            またはメール（
            <a href={`mailto:${siteConfig.contactEmail}`} className="text-ms-accent hover:underline dark:text-ms-focus">
              {siteConfig.contactEmail}
            </a>
            ）で、ご請求の内容（開示・訂正・利用停止・削除のいずれか）をお知らせください。
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              本人確認：ご請求が、ご本人からのものであることを確認するため、登録しているメールアドレスからのご連絡をお願いしたり、登録メールアドレスの確認をお願いしたりする場合があります。確認できない場合は、対応できません。
            </li>
            {billing && (
              <li>
                アカウント画面でご自身で確認できる情報：メールアドレス、現在のプラン、契約の状態、更新日（または利用可能期限）は、ログインして、アカウント画面から確認できます。それ以外の情報の開示は、上記の方法でご請求ください。
              </li>
            )}
            {billing && (
              <li>
                削除：アカウントと関連するデータの削除は、ログインして、アカウント画面の「アカウントの削除」から、ご自身で行えます（次条）。
              </li>
            )}
            <li>
              法令に基づき保存が必要な情報や、不正利用の防止・紛争への対応のために保存が必要な情報など、ご請求に応じられない場合があります。応じられない場合は、その旨とできる限りの理由をお知らせします。
            </li>
          </ul>
          <p className="mt-2">
            ご請求の内容を確認のうえ、対応します。対応までの期間は、ご請求の内容や確認の状況によって異なります。
          </p>
        </section>

        {billing && (
          <section data-testid="privacy-deletion">
            <h2 className="mb-2 text-base font-semibold text-ms-text">
              9. アカウントの削除と、データの扱い
            </h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                削除の方法：ログインして、アカウント画面の「アカウントの削除」から、パスワードの再入力と確認の入力を行うと、アカウントを削除できます。削除は元に戻せません。
              </li>
              <li>
                削除されるデータ：アカウント（メールアドレス・パスワード）、プロフィール、契約情報の記録（Stripeの顧客ID・契約IDなど）、ツールの利用回数の記録、AIの利用枠の記録、利用規約・プライバシーポリシーへの同意の記録です。
              </li>
              <li>
                有料プランの契約中：契約が続いている間は、アカウントを削除できません。先に解約し、契約期間が終了してから、削除してください。アカウントの削除によって、お支払い済みの料金が返金されることはありません。
              </li>
              <li>
                決済サービス（Stripe）の記録：お支払いの履歴など、Stripeに記録された情報は、本サービスのアカウント削除では削除されません。会計・税務上の保存や、不正防止・紛争への対応などのために、Stripeが保存する場合があります。Stripeでの取り扱いは、Stripeのプライバシーポリシーに従います。Stripe上の記録の削除をご希望の場合は、前条の方法でご請求ください。法令上の保存が必要なものを除き、対応を検討します。
              </li>
              <li>
                バックアップ・運用上のログ：障害対策のために作成される複製（バックアップ）や、障害の調査のための運用上のログ（Vercel、Supabaseなど）に、削除したあとも、一定の期間、データが残る場合があります。残る期間は、各サービスの仕様によります。これらは、通常のサービスの提供には使用しません。
              </li>
              <li>
                削除を行えないときや、削除に失敗したとき：画面にその旨と理由が表示されます。解決しない場合は、前条の方法でご連絡ください。
              </li>
            </ul>
          </section>
        )}

        <p className="text-xs text-ms-muted">最終更新日: {formatLegalVersion(LEGAL_VERSIONS.privacy)}</p>
      </div>
    </div>
  );
}
