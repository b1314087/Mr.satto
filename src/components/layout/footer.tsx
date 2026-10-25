import Link from "next/link";
import { siteConfig } from "@/lib/config/site";
import { FooterAdSlot } from "@/components/layout/footer-ad-slot";
import { featureFlags } from "@/lib/config/features";
import { BrandMark } from "@/components/ui/brand-mark";

export function Footer() {
  return (
    <footer className="ms-bar mt-8 border-b-0 border-t border-ms-border">
      <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
        <FooterAdSlot />
      </div>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-ms-text">
            <BrandMark size={22} />
            {siteConfig.shortName}
            <span className="font-normal text-ms-muted">
              {siteConfig.tagline}
            </span>
          </p>
          <p className="mt-1 max-w-md text-xs text-ms-muted">
            {featureFlags.billing
              ? "通常のツールは、ファイルをブラウザ上で処理します。サーバーには保存されません。AIで読み取る機能のみ、同意のうえで選んだ内容を外部のAIサービスへ送信します。"
              : "ファイルはブラウザ上で処理され、サーバーに保存されません。"}
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ms-muted">
          <Link href="/tools" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
            ツール一覧
          </Link>
          {featureFlags.billing && (
            <Link href="/pricing" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
              料金プラン
            </Link>
          )}
          <Link href="/about" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
            {siteConfig.shortName}について
          </Link>
          <Link href="/privacy" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
            プライバシーポリシー
          </Link>
          <Link href="/terms" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
            利用規約
          </Link>
          {featureFlags.billing && (
            <Link href="/tokushoho" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
              特定商取引法に基づく表記
            </Link>
          )}
          <Link href="/licenses" className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus">
            ライセンス表記
          </Link>
          <a
            href={siteConfig.contactFormUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm hover:text-ms-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ms-focus dark:hover:text-ms-focus"
          >
            お問い合わせ
            <span aria-hidden="true"> ↗</span>
            <span className="sr-only">（Googleフォーム・新しいタブで開きます）</span>
          </a>
        </nav>
      </div>
      <div className="border-t border-ms-border px-4 py-4 text-center text-xs text-ms-muted sm:px-6">
        © {new Date().getFullYear()} {siteConfig.shortName}
      </div>
    </footer>
  );
}
