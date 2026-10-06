"use client";

import { approxWrap } from "./approx-text";
import { mmToPt } from "@/lib/print/paper-sizes";
import { resolveEnvelopePageSizePt, type EnvelopeSizeId } from "@/lib/print/envelope-sizes";
import type { EnvelopePerson, EnvelopeWritingMode } from "@/lib/processors/browser/envelope-address";

/**
 * 封筒宛名のプレビュー。
 * envelope-address.ts（PDF生成）の描画位置・文字サイズ・折り返しと同じ数値（pt単位）を
 * そのままSVGのviewBoxに使い、PDFと同じレイアウトで表示する。
 * （フォントだけはブラウザの標準ゴシックのため、文字幅は近似値。）
 */

const COLOR_TEXT = "#1a1a1f";
const COLOR_MUTED = "#666669";

function toFullWidthDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

interface Ctx {
  w: number;
  h: number;
  /** PDF座標(原点=左下・上向き)のyをSVG座標へ */
  fy: (y: number) => number;
}

function PostalBoxes({ ctx, postalCode, rightX, topY, box }: { ctx: Ctx; postalCode: string; rightX: number; topY: number; box: number }) {
  const digits = postalCode.replace(/[^0-9]/g, "");
  const gap = box * 0.25;
  let x = rightX - box;
  const out = [];
  for (let i = digits.length - 1; i >= 0; i--) {
    out.push(
      <g key={i}>
        <rect x={x} y={ctx.fy(topY)} width={box} height={box} fill="none" stroke={COLOR_MUTED} strokeWidth={0.75} />
        <text x={x + box / 2} y={ctx.fy(topY - box + box * 0.22)} fontSize={box * 0.6} textAnchor="middle" fill={COLOR_TEXT}>
          {digits[i]}
        </text>
      </g>
    );
    x -= box + gap;
    if (digits.length - i === 4) x -= gap;
  }
  return <>{out}</>;
}

function VerticalText({
  ctx, text, startX, startY, size, lineHeight, columnGap, maxColumnHeight, color,
}: {
  ctx: Ctx; text: string; startX: number; startY: number; size: number; lineHeight: number;
  columnGap: number; maxColumnHeight: number; color: string;
}) {
  const chars = Array.from(toFullWidthDigits(text)).filter((c) => c !== "\n" && c !== "\r");
  const perColumn = Math.max(1, Math.floor(maxColumnHeight / lineHeight));
  return (
    <>
      {chars.map((ch, i) => {
        const col = Math.floor(i / perColumn);
        const row = i % perColumn;
        return (
          <text
            key={i}
            x={startX - col * columnGap}
            y={ctx.fy(startY - row * lineHeight)}
            fontSize={size}
            textAnchor="middle"
            fill={color}
          >
            {ch}
          </text>
        );
      })}
    </>
  );
}

function Lines({ ctx, lines, x, y, size, step, color }: { ctx: Ctx; lines: string[]; x: number; y: number; size: number; step: number; color: string }) {
  return (
    <>
      {lines.map((line, i) => (
        <text key={i} x={x} y={ctx.fy(y - i * step)} fontSize={size} fill={color}>
          {line}
        </text>
      ))}
    </>
  );
}

export function EnvelopePreview({
  envelopeSize,
  writingMode,
  recipient,
  sender,
}: {
  envelopeSize: EnvelopeSizeId;
  writingMode: EnvelopeWritingMode;
  recipient: EnvelopePerson | undefined;
  sender: EnvelopePerson | null;
}) {
  const { width: w, height: h } = resolveEnvelopePageSizePt(envelopeSize);
  const ctx: Ctx = { w, h, fy: (y) => h - y };
  const r = recipient;
  const hasSender = sender && (sender.postalCode.trim() || sender.address.trim() || sender.name.trim());

  const body: React.ReactNode[] = [];

  if (r) {
    if (writingMode === "vertical") {
      const topMargin = mmToPt(18);
      if (r.postalCode.trim()) {
        body.push(<PostalBoxes key="pc" ctx={ctx} postalCode={r.postalCode} rightX={w - mmToPt(20)} topY={h - mmToPt(6)} box={mmToPt(6)} />);
      }
      const bodyTopY = h - topMargin;
      const maxCol = h - topMargin - mmToPt(15);
      if (r.address.trim()) {
        body.push(<VerticalText key="ad" ctx={ctx} text={r.address} startX={w * 0.62} startY={bodyTopY} size={11} lineHeight={mmToPt(5.5)} columnGap={mmToPt(8)} maxColumnHeight={maxCol} color={COLOR_MUTED} />);
      }
      if (r.name.trim()) {
        body.push(<VerticalText key="nm" ctx={ctx} text={`${r.name}様`} startX={w * 0.46} startY={bodyTopY} size={18} lineHeight={mmToPt(9)} columnGap={mmToPt(13)} maxColumnHeight={maxCol} color={COLOR_TEXT} />);
      }
    } else {
      let y = h * 0.6;
      if (r.postalCode.trim()) {
        body.push(<PostalBoxes key="pc" ctx={ctx} postalCode={r.postalCode} rightX={w - mmToPt(15)} topY={y} box={mmToPt(6)} />);
        y -= mmToPt(12);
      }
      const addrLines = approxWrap(r.address, 13, w * 0.42);
      body.push(<Lines key="ad" ctx={ctx} lines={addrLines} x={w * 0.4} y={y} size={13} step={20} color={COLOR_TEXT} />);
      y -= 20 * addrLines.length + 10;
      if (r.name.trim()) {
        body.push(<Lines key="nm" ctx={ctx} lines={[`${r.name} 様`]} x={w * 0.4} y={y} size={22} step={0} color={COLOR_TEXT} />);
      }
    }
  }

  if (sender && hasSender) {
    if (writingMode === "vertical") {
      if (sender.postalCode.trim()) {
        body.push(
          <text key="sp" x={mmToPt(12)} y={ctx.fy(h * 0.66)} fontSize={7} fill={COLOR_MUTED}>
            {`〒${sender.postalCode}`}
          </text>
        );
      }
      const combined = [sender.address, sender.name].filter((v) => v.trim() !== "").join("　");
      if (combined.trim()) {
        body.push(<VerticalText key="sv" ctx={ctx} text={combined} startX={mmToPt(15)} startY={h * 0.62} size={8} lineHeight={mmToPt(4.5)} columnGap={mmToPt(6)} maxColumnHeight={h * 0.5} color={COLOR_MUTED} />);
      }
    } else {
      const x = mmToPt(15);
      let y = mmToPt(20);
      if (sender.postalCode.trim()) {
        body.push(<Lines key="sp" ctx={ctx} lines={[`〒${sender.postalCode}`]} x={x} y={y} size={9} step={0} color={COLOR_MUTED} />);
        y -= 12;
      }
      const lines = approxWrap(sender.address, 9, mmToPt(70));
      body.push(<Lines key="sa" ctx={ctx} lines={lines} x={x} y={y} size={9} step={12} color={COLOR_MUTED} />);
      y -= 12 * lines.length;
      if (sender.name.trim()) {
        body.push(<Lines key="sn" ctx={ctx} lines={[sender.name]} x={x} y={y} size={10} step={0} color={COLOR_TEXT} />);
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="封筒の印刷イメージ"
      className="mx-auto block w-full max-w-xl border border-neutral-400 bg-white shadow-sm"
      style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif" }}
    >
      <rect x={0} y={0} width={w} height={h} fill="#ffffff" />
      {body}
    </svg>
  );
}
