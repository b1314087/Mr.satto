"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * サイトの訪問数の記録を、ページを開くたびに送る（個人を特定しない・Cookieなし）。
 * 送るのは、ページのパスだけ（検索条件・ファイル名・ファイルの内容は送らない）。画面には何も表示しない。
 * 「トラッキングしない」設定（Do Not Track・Global Privacy Control）のブラウザでは、送らない。
 * 詳しくは、プライバシーポリシーの「Cookie・アクセス解析について」。
 */
export function VisitBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
      if (nav.doNotTrack === "1" || nav.globalPrivacyControl) return;
      if (!pathname || pathname.startsWith("/admin") || pathname.startsWith("/api")) return;
      const body = JSON.stringify({ path: pathname });
      if (typeof nav.sendBeacon === "function") {
        nav.sendBeacon("/api/analytics/visit", new Blob([body], { type: "application/json" }));
      } else {
        void fetch("/api/analytics/visit", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
      }
    } catch {
      // 記録できなくても、画面の動作には影響させない
    }
  }, [pathname]);
  return null;
}
