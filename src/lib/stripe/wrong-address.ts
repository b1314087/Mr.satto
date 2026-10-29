/**
 * 決済・契約管理の操作は、正式なアドレス（siteConfig.url）で開いた画面からだけ受け付ける。
 * 古いアドレス（mrmatto.vercel.app など）で開いていると、サーバーが「このリクエストは受け付けられません」と
 * 断る（他のサイトからの不正な送信を防ぐための確認）。理由が分からないと困るので、その場合だけ、
 * 正式なアドレスで開き直すよう案内する文を作る。
 *
 * @param status サーバーの応答の番号（403 のときだけ案内を作る）
 * @param pagePath 開き直してほしいページ（例: "/account"）
 * @param currentOrigin いま開いている画面のアドレス（例: "https://mrmatto.vercel.app"）
 * @param officialUrl 正式なアドレス（例: "https://mrsatto.com"）
 */
export function wrongAddressMessage(status: number, pagePath: string, currentOrigin: string, officialUrl: string): string | null {
  if (status !== 403) return null;
  const official = officialUrl.replace(/\/+$/, "");
  if (currentOrigin.replace(/\/+$/, "") === official) return null; // 正式なアドレスなのに断られた場合は、別の理由
  return `この画面のアドレスでは操作できません。正式なアドレス（${official}${pagePath}）を開き、ログインしてから、もう一度お試しください。`;
}
