import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/config/site";
import { loadJapaneseOgFontData } from "@/lib/seo/og-font";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Phase 21: 日本語のタグライン（siteConfig.tagline）が、フォント未指定のため
// 空の四角（tofu）として描画されていた既存バグを修正。Noto Sans JPを明示的に
// 読み込む（新規フォントファイル・新規npmパッケージの追加なし。既存資産の再利用）。
export default async function Image() {
  const fontData = await loadJapaneseOgFontData();

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
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 700, display: "flex", alignItems: "center", gap: 20 }}>
          <span>🧰</span>
          <span>{siteConfig.shortName}</span>
        </div>
        <div style={{ fontSize: 28, marginTop: 24, opacity: 0.85, maxWidth: 900, textAlign: "center" }}>
          {siteConfig.tagline}
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Noto Sans JP", data: fontData, style: "normal" }] }
  );
}
