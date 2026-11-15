/**
 * 端末・パスキーの表示名（表示のためだけ。判定には使わない）。
 *
 * 注意：WebAuthnでは、パスキーの保存先（Apple・Google・Microsoftなど）を常に正確に判別できるわけではない。
 * AAGUID（認証器の種類を表すID）は、保存先によっては送られない（すべて0）ことがあり、偽装もできる。
 * そのため、ここで分かるのは「表示の手がかり」だけで、保存先によって扱いを変えることはしない。
 */

/** よく知られたAAGUID（公開されている一覧より。分からないものは null） */
const KNOWN_AAGUIDS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Appleのパスキー（iCloudキーチェーン）",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "Appleのパスキー（iCloudキーチェーン）",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Googleパスワードマネージャー",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
};

export function passkeyProviderHint(aaguid: string | null | undefined): string | null {
  if (!aaguid) return null;
  return KNOWN_AAGUIDS[aaguid.toLowerCase()] ?? null;
}

/** ブラウザの情報（User-Agent）から「Mac・Safari」のような短い名前を作る。分からなければ「この端末」 */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return "この端末";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const parts = [os, browser].filter(Boolean);
  return parts.length > 0 ? parts.join("・") : "この端末";
}

/** パスキーの表示名：保存先の手がかりがあればそれを、なければ登録した端末の名前を使う */
export function passkeyLabel(aaguid: string | null | undefined, ua: string | null | undefined): string {
  const hint = passkeyProviderHint(aaguid);
  const device = deviceLabelFromUserAgent(ua);
  return hint ? `${hint}（${device}で登録）` : `パスキー（${device}で登録）`;
}
