"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useAdHostAllowed } from "@/lib/ads/host";
import { isAdFreeToolPath } from "@/lib/tools/ad-free-tools";

/** 広告のスクリプト（AdSense・GPT）が、すでにこのページに読み込まれているか */
function adScriptLoaded(): boolean {
  return !!document.querySelector('script#adsbygoogle-loader, script[src*="adsbygoogle.js"], script[data-mrsatto-gpt]');
}

/**
 * AdSenseのスクリプトを読み込む（広告全体がオンで、広告IDが設定されているときに、レイアウトから使う）。
 * 正式なドメイン（mrsatto.com）で開いているときだけ読み込む。ほかのアドレスでは、外部への通信もしない。
 * ホスト名はブラウザでしか分からないので、表示したあとで確かめてから読み込む。
 *
 * 2026-11-26 セキュリティ：パスワードを扱うツールなど、広告なしのツール（src/lib/tools/ad-free-tools.ts）のページでは、
 * スクリプトを読み込まない。ほかのページから画面の切り替えでたどり着き、すでに広告のスクリプトが動いている場合は、
 * ページを読み込み直して、広告のプログラムがない状態で開き直す（読み込み直したあとは、ここで読み込まないので繰り返さない）。
 */
export function AdsenseLoader({ clientId }: { clientId: string }) {
  const allowed = useAdHostAllowed();
  const pathname = usePathname();
  const adFree = isAdFreeToolPath(pathname);

  useEffect(() => {
    if (adFree && adScriptLoaded()) window.location.reload();
  }, [adFree]);

  if (!allowed || adFree) return null;
  return (
    <Script
      id="adsbygoogle-loader"
      async
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`}
      crossOrigin="anonymous"
      strategy="afterInteractive"
    />
  );
}
