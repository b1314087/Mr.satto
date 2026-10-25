import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { siteConfig } from "@/lib/config/site";

export const metadata: Metadata = {
  title: "オープンソースライセンス表記",
  description: `${siteConfig.name}の音声ツールで利用しているオープンソースソフトウェア（Mediabunny・LAME MP3 Encoder）のライセンス表記です。`,
  alternates: {
    canonical: "/licenses",
  },
};

const LINK_CLASS = "break-all text-ms-accent hover:underline dark:text-ms-focus";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-ms-text">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export default function LicensesPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-ms-text">オープンソースライセンス表記</h1>

      <div className="ms-glass ms-prose-surface flex flex-col gap-8 text-sm leading-relaxed text-ms-text">
        <p>
          {siteConfig.name}の音声ツール（音声形式変換・動画から音声を抽出・音声カット・音声結合・音量調整・音声圧縮）は、
          以下のオープンソースソフトウェアを利用しています。いずれも改変せずに、配布されているままの状態で利用しています。
          音声ファイルの処理はすべてお使いのブラウザの中で行われ、ファイルがサーバーへ送信されることはありません。
        </p>

        <Section title="Mediabunny">
          <p>
            音声・動画ファイルの読み込み、書き出し、変換に利用しているTypeScriptライブラリです。
            Mozilla Public License 2.0（MPL-2.0）で提供されています。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              ソースコード：<ExternalLink href="https://github.com/Vanilagy/mediabunny">https://github.com/Vanilagy/mediabunny</ExternalLink>
            </li>
            <li>
              ライセンス全文：<ExternalLink href="https://www.mozilla.org/en-US/MPL/2.0/">https://www.mozilla.org/en-US/MPL/2.0/</ExternalLink>
            </li>
          </ul>
        </Section>

        <Section title="@mediabunny/mp3-encoder">
          <p>
            MP3形式で書き出すときにだけ、ブラウザが対応していない場合に限って読み込まれるMP3エンコーダです
            （MP3を書き出さないツールの操作では読み込まれません）。
            Mediabunnyの拡張パッケージで、Mozilla Public License 2.0（MPL-2.0）で提供されています。
            内部でLAME MP3 Encoder（下記）をWebAssemblyにビルドしたものを利用しています。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              ソースコード：<ExternalLink href="https://github.com/Vanilagy/mediabunny/tree/main/packages/mp3-encoder">https://github.com/Vanilagy/mediabunny/tree/main/packages/mp3-encoder</ExternalLink>
            </li>
            <li>
              ライセンス全文：<ExternalLink href="https://www.mozilla.org/en-US/MPL/2.0/">https://www.mozilla.org/en-US/MPL/2.0/</ExternalLink>
            </li>
          </ul>
        </Section>

        <Section title="LAME MP3 Encoder">
          <p>
            MP3のエンコード（音声をMP3にする処理）には、LAME MP3 Encoder（バージョン3.100）を利用しています。
            LAMEは GNU Lesser General Public License（LGPL）で提供されています。
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              LAME公式サイト：<ExternalLink href="https://lame.sourceforge.io/">https://lame.sourceforge.io/</ExternalLink>
            </li>
            <li>
              LAMEのライセンス：<ExternalLink href="https://lame.sourceforge.io/license.txt">https://lame.sourceforge.io/license.txt</ExternalLink>
            </li>
            <li>
              LAMEのソースコード：<ExternalLink href="https://sourceforge.net/projects/lame/files/lame/">https://sourceforge.net/projects/lame/files/lame/</ExternalLink>
            </li>
            <li>
              LGPLライセンス全文：<ExternalLink href="https://www.gnu.org/licenses/lgpl-2.1.html">https://www.gnu.org/licenses/lgpl-2.1.html</ExternalLink>
            </li>
          </ul>
          <p>
            LAMEは、上記のMP3エンコーダ（@mediabunny/mp3-encoder）の中の、独立したモジュールとして組み込まれています。
            LAMEのソースコードは上記から入手でき、@mediabunny/mp3-encoderのREADMEに記載のビルド手順に従って
            再ビルドすることで、LAME部分を差し替えたエンコーダを作成できます。
          </p>
        </Section>

        <Section title="その他">
          <p>
            上記以外にも、本サービスは多くのオープンソースソフトウェアを利用しており、それぞれのライセンスに従って利用しています。
            ライセンスに関するお問い合わせは、
            <ExternalLink href={siteConfig.contactFormUrl}>お問い合わせフォーム</ExternalLink>
            からご連絡ください。
          </p>
          <p>
            サービス全般の取り扱いについては、
            <Link href="/terms" className={LINK_CLASS}>
              利用規約
            </Link>
            および
            <Link href="/privacy" className={LINK_CLASS}>
              プライバシーポリシー
            </Link>
            をご覧ください。
          </p>
        </Section>
      </div>
    </div>
  );
}
