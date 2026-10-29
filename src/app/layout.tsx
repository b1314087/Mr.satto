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

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name}｜${siteConfig.tagline}`,
    template: `%s｜${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  alternates: {
    canonical: "/",
  },
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
      <body className="flex min-h-full flex-col antialiased">
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
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
