/**
 * サービスの名称・ブランド情報を一元管理する設定。
 *
 * サービス名(Mr.Satto)・キャッチコピーはコード内に直接ハードコードせず、
 * 必ずここを参照する。将来ブランド名やコピーを変更する場合も、
 * この1ファイルを更新するだけで全ページに反映される。
 */
export const siteConfig = {
  name: "Mr.Satto",
  shortName: "Mr.Satto",
  /** キャッチコピー。変更可能性があるため各所にハードコードしない */
  tagline: "面倒な作業を、サッと。",
  description:
    "画像圧縮・PDF編集・CSV整形・QRコード生成など、面倒なWeb作業をブラウザ上でサッと片付ける無料のオンラインツール集です。ファイルはサーバーに保存されません。",
  // Vercel等にデプロイ後、実際のURLに差し替えてください
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.vercel.app",
  contactEmail: "contact@example.com",
  locale: "ja_JP",
};
