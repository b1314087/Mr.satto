"use client";

import { approxWidth } from "./approx-text";
import { resolveEnvelopePageSizePt, type EnvelopeSizeId } from "@/lib/print/envelope-sizes";
import {
  DEFAULT_TEXT_STYLE,
  layoutEnvelope,
  type EnvelopeHonorific,
  type EnvelopeOrientation,
  type EnvelopePerson,
  type EnvelopeTextStyle,
  type EnvelopeWritingMode,
} from "@/lib/print/envelope-layout";

/**
 * 封筒宛名のプレビュー。
 * PDF生成(envelope-address.ts)と同じ配置計算(envelope-layout.ts)の結果を、そのままSVGで描く。
 * （フォントだけはブラウザの標準ゴシックのため、文字幅は近似値。）
 */
export function EnvelopePreview({
  envelopeSize,
  writingMode,
  orientation = "landscape",
  honorific = "sama",
  style = DEFAULT_TEXT_STYLE,
  recipient,
  sender,
}: {
  envelopeSize: EnvelopeSizeId;
  writingMode: EnvelopeWritingMode;
  orientation?: EnvelopeOrientation;
  honorific?: EnvelopeHonorific;
  style?: EnvelopeTextStyle;
  recipient: EnvelopePerson | undefined;
  sender: EnvelopePerson | null;
}) {
  const { width: w, height: h } = resolveEnvelopePageSizePt(envelopeSize, orientation);
  const ops = layoutEnvelope({ width: w, height: h, writingMode, honorific, style, recipient, sender }, approxWidth);
  const c = (rgb: [number, number, number]) => `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="封筒の印刷イメージ"
      className={`mx-auto block w-full border border-neutral-400 bg-white shadow-sm ${orientation === "portrait" ? "max-w-xs" : "max-w-xl"}`}
      style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif" }}
    >
      <rect x={0} y={0} width={w} height={h} fill="#ffffff" />
      {ops.map((op, i) =>
        op.kind === "rect" ? (
          <rect key={i} x={op.x} y={op.y} width={op.w} height={op.h} fill="none" stroke={c(op.stroke)} strokeWidth={0.75} />
        ) : (
          <text
            key={i}
            x={op.x}
            y={op.y}
            fontSize={op.size}
            fontWeight={op.bold ? 700 : 400}
            fill={c(op.color)}
            textAnchor={op.align === "center" ? "middle" : "start"}
          >
            {op.text}
          </text>
        )
      )}
    </svg>
  );
}
