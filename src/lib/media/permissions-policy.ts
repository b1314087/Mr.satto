/**
 * マイク・カメラ・画面の共有が、このページで許可されているかを確かめる（2026-11-18 録音・画面録画）。
 *
 * サイト全体ではマイク・カメラを使えないようにしていて（next.config.ts の Permissions-Policy）、
 * 録音・画面録画のページだけ許可している。この決まりは「ページを最初に読み込んだとき」に決まるため、
 * ほかのページからサイト内のリンクで移ってきた場合は、前のページの決まり（使えない）のままになる。
 * そのときは、ページを読み込み直して、このページの決まり（使える）にする。
 */

export type MediaFeature = "microphone" | "camera" | "display-capture";

interface PolicyLike {
  allowsFeature(feature: string): boolean;
}

function currentPolicy(): PolicyLike | null {
  if (typeof document === "undefined") return null;
  const d = document as Document & { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike };
  return d.permissionsPolicy ?? d.featurePolicy ?? null;
}

/** 決まりで止められている機能を返す（ブラウザが決まりを確かめる仕組みを持たない場合は、止められていないとみなす） */
export function blockedMediaFeatures(features: MediaFeature[]): MediaFeature[] {
  const policy = currentPolicy();
  if (!policy) return [];
  return features.filter((f) => {
    try {
      return !policy.allowsFeature(f);
    } catch {
      return false;
    }
  });
}

const RELOAD_FLAG = "mediaReload";

/**
 * 止められていれば、1回だけページを読み込み直す。読み込み直しても止められているときは false を返す
 * （画面で「このブラウザでは使えません」と案内する）。
 */
export function ensureMediaFeaturesAllowed(features: MediaFeature[]): boolean {
  if (blockedMediaFeatures(features).length === 0) return true;
  const url = new URL(window.location.href);
  if (url.searchParams.has(RELOAD_FLAG)) return false;
  url.searchParams.set(RELOAD_FLAG, "1");
  window.location.replace(url.toString());
  return false;
}

/** 読み込み直しの目印を、アドレスから消す（再読み込みのたびに目印が残らないように） */
export function clearMediaReloadFlag(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RELOAD_FLAG)) return;
  url.searchParams.delete(RELOAD_FLAG);
  window.history.replaceState(window.history.state, "", url.toString());
}
