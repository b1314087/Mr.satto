import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { siteConfig } from "@/lib/config/site";
import { adConfig, isAdsEnabled } from "@/lib/ads/config";
import { VisitBeacon } from "@/components/analytics/visit-beacon";
import { NavigationFeedback } from "@/components/ui/navigation-feedback";
import { BusyHold } from "@/components/ui/busy-hold";
import { PaidSessionGuard } from "@/components/passkey/paid-session-guard";
import { featureFlags } from "@/lib/config/features";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name}｜${siteConfig.tagline}`,
    template: `%s｜${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  // canonical は、各ページで自分のURLを指定する（ここで "/" を指定すると、指定のないページ（404・アカウント画面など）まで
  // トップページを指してしまうため、トップページの canonical は src/app/page.tsx で指定する）
  openGraph: {
    type: "website",
    locale: siteConfig.locale,
    siteName: siteConfig.name,
    title: `${siteConfig.name}｜${siteConfig.tagline}`,
    description: siteConfig.description,
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name}｜${siteConfig.tagline}`,
    description: siteConfig.description,
  },
  // AdSenseのサイトの所有権の確認用（<head> に <meta name="google-adsense-account" content="ca-pub-…"> を出す）。
  // 広告のスクリプトは表示を速くするため後から読み込む（afterInteractive）ので、AdSenseの確認ロボットが元のHTMLで見つけられない。
  // そのため、元のHTMLに必ず含まれるメタタグで確認する。広告IDが未設定の間は出さない（広告のオン・オフとは関係なく、確認だけに使う）
  ...(adConfig.adsenseClientId ? { other: { "google-adsense-account": adConfig.adsenseClientId } } : {}),
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning className="h-full">
      <body className="flex min-h-full flex-col">
        {/* NEXT_PUBLIC_ADSENSE_CLIENT_ID が設定されている場合のみAdSenseスクリプトを読み込む。
            未設定の間(現在)は何も出力せず、外部への通信も発生しない。 */}
        {isAdsEnabled() && (
          <Script
            id="adsbygoogle-loader"
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adConfig.adsenseClientId}`}
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        )}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {/* 背景のやわらかい光（装飾。白と薄いグレーだけ。操作や文字には関わらない） */}
          <div className="ms-ambient" aria-hidden="true" />
          <VisitBeacon />
          <NavigationFeedback />
          <BusyHold />
          {/* 有料プランの同時利用の定期確認（パスキーで本人確認した端末だけで動く） */}
          {featureFlags.passkey && <PaidSessionGuard />}
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
