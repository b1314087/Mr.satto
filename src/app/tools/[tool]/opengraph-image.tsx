import { ImageResponse } from "next/og";
import { tools, getToolById } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";
import { getCategorySeoContent } from "@/lib/seo/category-content";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { siteConfig } from "@/lib/config/site";
import { loadJapaneseOgFontData } from "@/lib/seo/og-font";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface ImageProps {
  params: Promise<{ tool: string }>;
}

// page.tsx(同階層)のgenerateStaticParamsと同じ一覧をここでも返す必要がある
// (このファイルにgenerateStaticParamsが無いと、この画像だけリクエストの
// 都度生成されるようになり、Section 27の「サーバー/静的側でできる処理は
// できるだけそちらで行う」方針に反するため)。
export function generateStaticParams() {
  return [...categories.map((c) => ({ tool: c.id })), ...tools.map((t) => ({ tool: t.id }))];
}

/**
 * Phase 21: それまで全ページ共通だった1枚のOGP画像（src/app/opengraph-image.tsx）を、
 * カテゴリページ・ツール詳細ページではそのページ固有の見出し・説明に差し替える。
 *
 * 見出し・説明は generateMetadata（同階層の page.tsx）と同じ情報源
 * （Tool Registry・src/lib/seo/tool-content.ts・src/lib/seo/category-content.ts）
 * からそのまま取得し、このファイル独自の文言・架空の説明は追加しない。
 * 準備中(coming-soon)ツールも実際のツール名・説明のみを表示する
 * （検索結果自体はgenerateMetadataでnoindexのまま。SNS等でURLが共有された際の
 * 見た目を補うだけで、インデックス方針には影響しない）。
 */
export default async function Image({ params }: ImageProps) {
  const { tool: param } = await params;
  const fontData = await loadJapaneseOgFontData();

  const category = categories.find((c) => c.id === param);
  const tool = category ? undefined : getToolById(param);

  let icon = "🧰";
  let heading: string = siteConfig.shortName;
  let description: string = siteConfig.tagline;

  if (category) {
    const content = getCategorySeoContent(category.id);
    icon = category.icon;
    heading = content.metaTitle;
    description = content.metaDescription;
  } else if (tool) {
    const seo = getToolSeoContent(tool.id);
    const toolCategory = categories.find((c) => c.id === tool.category);
    icon = toolCategory?.icon ?? "🧰";
    heading = seo?.metaTitle ?? tool.name;
    description = seo?.metaDescription ?? tool.description;
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1d4ed8 0%, #1e293b 100%)",
          color: "white",
          fontFamily: "Noto Sans JP",
          padding: "0 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            maxWidth: 1040,
          }}
        >
          <div style={{ fontSize: 44 }}>{icon}</div>
          <div style={{ fontSize: 52, fontWeight: 700, textAlign: "center", lineHeight: 1.3 }}>{heading}</div>
        </div>
        <div style={{ fontSize: 26, marginTop: 28, opacity: 0.85, maxWidth: 960, textAlign: "center", lineHeight: 1.5 }}>
          {description}
        </div>
        <div
          style={{
            fontSize: 22,
            marginTop: 40,
            opacity: 0.7,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>🧰</span>
          <span>{siteConfig.shortName}</span>
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Noto Sans JP", data: fontData, style: "normal" }] }
  );
}
