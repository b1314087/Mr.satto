/**
 * サービスの名称・ブランド情報を一元管理する設定。
 *
 * サービス名(Mr.Satto)・キャッチコピーはコード内に直接ハードコードせず、
 * 必ずここを参照する。将来ブランド名やコピーを変更する場合も、
 * この1ファイルを更新するだけで全ページに反映される。
 */
/**
 * 正式なドメイン（固定）。アクセス先の統一（Vercelの初期ドメイン・www からの転送）・広告を出すドメイン・
 * パスキーの利用元（RP ID）は、環境変数ではなく、この固定の値を使う（設定の書き間違いで別のドメインにならないように）。
 */
export const CANONICAL_HOST = "mrsatto.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

export const siteConfig = {
  name: "Mr.Satto",
  shortName: "Mr.Satto",
  /** キャッチコピー。変更可能性があるため各所にハードコードしない */
  tagline: "面倒な作業を、サッと。",
  description:
    "画像圧縮・PDF編集・CSV整形・二次元コード生成など、面倒なWeb作業をブラウザ上でサッと片付ける無料のオンラインツール集です。ファイルはサーバーに保存されません。",
  // 正式な本番ドメインは https://mrsatto.com。環境変数 NEXT_PUBLIC_SITE_URL があればそれを優先する。
  // 本番（NODE_ENV=production）で未設定でも、決済の戻り先などが仮のURLにならないよう、本番の既定値を持たせる。
  url: process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.NODE_ENV === "production" ? "https://mrsatto.com" : "https://example.vercel.app"),
  contactEmail: "contact@mrsatto.com",
  /** お問い合わせ・不具合報告・改善提案の受付先（Googleフォーム。回答はGoogle側で管理） */
  contactFormUrl: "https://forms.gle/b9fmLMZw4beCdJf16",
  locale: "ja_JP",
};
