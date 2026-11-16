"use client";

import Script from "next/script";
import { useAdHostAllowed } from "@/lib/ads/host";

/**
 * AdSenseのスクリプトを読み込む（広告全体がオンで、広告IDが設定されているときに、レイアウトから使う）。
 * 正式なドメイン（mrsatto.com）で開いているときだけ読み込む。ほかのアドレスでは、外部への通信もしない。
 * ホスト名はブラウザでしか分からないので、表示したあとで確かめてから読み込む。
 */
export function AdsenseLoader({ clientId }: { clientId: string }) {
  const allowed = useAdHostAllowed();
  if (!allowed) return null;
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
