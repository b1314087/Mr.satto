import { ImageResponse } from "next/og";

/**
 * iOSホーム画面追加用アイコン（Phase 12）。icon.tsxと同じ理由・同じ配色で生成する。
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1d4ed8 0%, #1e293b 100%)",
        }}
      >
        <span style={{ fontSize: 108 }}>🧰</span>
      </div>
    ),
    { ...size }
  );
}
