import type { ReactNode } from "react";
import type { GuidePart, GuidePreviewKind, GuideStep } from "@/lib/guides/types";

/**
 * 「使い方」の図（SVG）。実際のツール画面の部品を小さく描き、いま操作する部品を青い枠と番号付きの矢印で示す。
 *
 * - variant="pc"：横長（400×260）。split の画面では、設定を左・プレビューを右に並べる（実際のPC表示と同じ）。
 * - variant="sp"：縦長（280×400）。上から順に並べる（実際のスマホ表示と同じ）。
 * - 色は src/app/globals.css の .gd-* が決める（サイトの色の変数を使うので、ダーク表示にも合う）。
 * - 部品が入りきらないときは、いま操作する部品から遠いものを省く（いま操作する部品は必ず描く）。
 * 画像ファイルや動画は使わない（軽い・拡大してもにじまない）。
 */

const SIZE = { pc: { w: 400, h: 260 }, sp: { w: 280, h: 400 } } as const;
const PAD = 14;
const TOP = 18; // 一番上の部品の位置
/**
 * 番号の丸と矢印を描く、部品の右側の通り道の幅。
 * 部品は、この幅をあけて並べる（番号の丸を、ほかの部品やボタンの文字に重ねないため。すべての図で同じ決まり）。
 */
const GUTTER = 32;
const GAP = 8;
const FS = 11; // 文字の大きさ

/** 文字の幅のおおよそ（全角は1文字分、半角は0.58文字分） */
function textWidth(s: string, fs = FS): number {
  let w = 0;
  for (const ch of s) w += /[\u0000-ÿ]/.test(ch) ? fs * 0.58 : fs;
  return w;
}

/** 幅に収まるように、文字を「…」で切る */
function fit(s: string, max: number, fs = FS): string {
  if (textWidth(s, fs) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (textWidth(out + ch + "…", fs) > max) break;
    out += ch;
  }
  return out + "…";
}

function partHeight(p: GuidePart, w: number): number {
  switch (p.k) {
    case "drop":
      return 66;
    case "file":
      return 26;
    case "seg":
    case "chips":
      return (p.label ? 15 : 0) + segRows(p, w) * 24;
    case "btns":
      return segRows({ options: p.options }, w) * 24;
    case "input":
    case "select":
      return 15 + 22;
    case "input2":
      return 15 + 22;
    case "slider":
      return 15 + 14;
    case "check":
      return 16;
    case "text":
      return (p.label ? 15 : 0) + 12 + Math.min(p.lines.length, 4) * 13;
    case "table":
      return 14 * ((p.rows ?? 3) + 1) + 2;
    case "head":
      return 18;
    case "adv":
      return 24;
    case "run":
    case "btn":
      return 26;
    case "preview":
      return 0; // 高さは並べ方で決める
  }
}

function optionWidth(o: string): number {
  return textWidth(o) + 18;
}

/** セグメントの段数（入りきらないと折り返す。実際の画面と同じ） */
function segRows(p: { options: string[] } & Partial<{ label: string }>, w: number): number {
  let rows = 1;
  let x = 0;
  for (const o of p.options) {
    const ow = Math.min(optionWidth(o), w - 8);
    if (x > 0 && x + ow > w - 6) {
      rows++;
      x = 0;
    }
    x += ow + 2;
  }
  return Math.min(rows, 3);
}

/** 部品を1つ描く（x, y は左上、w は幅） */
function Part({ p, x, y, w, h, uid }: { p: GuidePart; x: number; y: number; w: number; h: number; uid: string }) {
  switch (p.k) {
    case "drop":
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={10} className="gd-drop" />
          <path d={`M${x + w / 2 - 9} ${y + 22} l9 -9 l9 9 M${x + w / 2} ${y + 13} v14`} className="gd-stroke-accent" fill="none" strokeWidth={2} strokeLinecap="round" />
          <text x={x + w / 2} y={y + 42} textAnchor="middle" className="gd-text gd-bold" fontSize={FS - 1}>
            {fit(p.label, w - 16, FS - 1)}
          </text>
          <rect x={x + w / 2 - 34} y={y + 48} width={68} height={13} rx={6.5} className="gd-accent" />
          <text x={x + w / 2} y={y + 57.5} textAnchor="middle" className="gd-on-accent" fontSize={8}>
            ファイルを選択
          </text>
        </g>
      );
    case "file": {
      const btn = p.add ? "＋ ファイルを追加" : "⇄ ファイルを変更";
      const bw = textWidth(btn, 9) + 12;
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={8} className="gd-box" />
          <rect x={x + 8} y={y + 7} width={10} height={12} rx={2} className="gd-muted-fill" />
          <text x={x + 24} y={y + 17} className="gd-text" fontSize={FS - 1}>
            {fit(p.name, w - bw - 40, FS - 1)}
          </text>
          <rect x={x + w - bw - 6} y={y + 5} width={bw} height={16} rx={8} className="gd-pill" />
          <text x={x + w - bw / 2 - 6} y={y + 16.5} textAnchor="middle" className="gd-accent-text" fontSize={9}>
            {btn}
          </text>
        </g>
      );
    }
    case "seg":
    case "chips":
    case "btns": {
      const label = p.k === "btns" ? undefined : p.label;
      const top = label ? y + 15 : y;
      const isOn = (i: number) => (p.k === "chips" ? p.on.includes(i) : p.on === i);
      const items: { o: string; i: number; cx: number; cy: number; ow: number }[] = [];
      let cx = x + 3;
      let cy = top;
      p.options.forEach((o, i) => {
        const ow = Math.min(optionWidth(o), w - 8);
        if (cx > x + 3 && cx + ow > x + w - 3) {
          cx = x + 3;
          cy += 24;
        }
        if (cy < top + 24 * 3) items.push({ o, i, cx, cy, ow });
        cx += ow + 2;
      });
      return (
        <g>
          {label && (
            <text x={x} y={y + 10} className="gd-text gd-bold" fontSize={FS - 1}>
              {fit(label, w, FS - 1)}
            </text>
          )}
          {p.k === "seg" && <rect x={x} y={top} width={w} height={h - (label ? 15 : 0)} rx={9} className="gd-track" />}
          {items.map(({ o, i, cx: bx, cy: by, ow }) => (
            <g key={i}>
              <rect
                x={bx}
                y={by + 3}
                width={ow}
                height={18}
                rx={p.k === "seg" ? 6 : 9}
                className={isOn(i) ? (p.k === "chips" ? "gd-chip-on" : "gd-accent") : p.k === "seg" ? "gd-none" : "gd-pill-off"}
              />
              <text x={bx + ow / 2} y={by + 15.5} textAnchor="middle" className={isOn(i) && p.k !== "chips" ? "gd-on-accent" : "gd-text"} fontSize={FS - 1.5}>
                {fit(o, ow - 8, FS - 1.5)}
              </text>
            </g>
          ))}
        </g>
      );
    }
    case "input":
    case "select":
      return (
        <g>
          <text x={x} y={y + 10} className="gd-text gd-bold" fontSize={FS - 1}>
            {fit(p.label, w, FS - 1)}
          </text>
          <rect x={x} y={y + 15} width={w} height={22} rx={7} className="gd-box" />
          <text x={x + 8} y={y + 30} className="gd-text" fontSize={FS - 1}>
            {fit(p.value, w - 24, FS - 1)}
          </text>
          {p.k === "select" && <path d={`M${x + w - 15} ${y + 24} l4 4 l4 -4`} className="gd-stroke-muted" fill="none" strokeWidth={1.5} />}
        </g>
      );
    case "input2": {
      const half = (w - 8) / 2;
      return (
        <g>
          {[0, 1].map((i) => (
            <g key={i}>
              <text x={x + i * (half + 8)} y={y + 10} className="gd-text gd-bold" fontSize={FS - 1}>
                {fit(p.labels[i], half, FS - 1)}
              </text>
              <rect x={x + i * (half + 8)} y={y + 15} width={half} height={22} rx={7} className="gd-box" />
              <text x={x + i * (half + 8) + 8} y={y + 30} className="gd-text" fontSize={FS - 1}>
                {fit(p.values[i], half - 12, FS - 1)}
              </text>
            </g>
          ))}
        </g>
      );
    }
    case "slider": {
      const kx = x + 6 + (w - 12) * p.value;
      return (
        <g>
          <text x={x} y={y + 10} className="gd-text gd-bold" fontSize={FS - 1}>
            {fit(p.label + (p.text ? `：${p.text}` : ""), w, FS - 1)}
          </text>
          <rect x={x} y={y + 19} width={w} height={5} rx={2.5} className="gd-track-line" />
          <rect x={x} y={y + 19} width={kx - x} height={5} rx={2.5} className="gd-accent" />
          <circle cx={kx} cy={y + 21.5} r={6.5} className="gd-knob" />
        </g>
      );
    }
    case "check":
      return (
        <g>
          <rect x={x} y={y + 2} width={12} height={12} rx={3} className={p.on ? "gd-accent" : "gd-box"} />
          {p.on && <path d={`M${x + 3} ${y + 8} l2.5 2.5 l4 -5`} className="gd-stroke-white" fill="none" strokeWidth={1.6} />}
          <text x={x + 18} y={y + 12} className="gd-text" fontSize={FS - 1}>
            {fit(p.label, w - 20, FS - 1)}
          </text>
        </g>
      );
    case "text": {
      const top = p.label ? y + 15 : y;
      return (
        <g>
          {p.label && (
            <text x={x} y={y + 10} className="gd-text gd-bold" fontSize={FS - 1}>
              {fit(p.label, w, FS - 1)}
            </text>
          )}
          <rect x={x} y={top} width={w} height={h - (p.label ? 15 : 0)} rx={8} className="gd-box" />
          {p.lines.slice(0, 4).map((l, i) => (
            <text key={i} x={x + 8} y={top + 15 + i * 13} className="gd-text" fontSize={FS - 1.5}>
              {fit(l, w - 16, FS - 1.5)}
            </text>
          ))}
        </g>
      );
    }
    case "table": {
      const cols = p.cols ?? 4;
      const rows = (p.rows ?? 3) + 1;
      const cw = w / cols;
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={6} className="gd-box" />
          <rect x={x} y={y} width={w} height={14} rx={6} className="gd-head-fill" />
          {Array.from({ length: rows - 1 }, (_, r) => (
            <line key={`r${r}`} x1={x} x2={x + w} y1={y + 14 * (r + 1)} y2={y + 14 * (r + 1)} className="gd-grid" />
          ))}
          {Array.from({ length: cols - 1 }, (_, c) => (
            <line key={`c${c}`} y1={y} y2={y + h} x1={x + cw * (c + 1)} x2={x + cw * (c + 1)} className="gd-grid" />
          ))}
          {Array.from({ length: rows - 1 }, (_, r) =>
            Array.from({ length: cols }, (_, c) => (
              <rect key={`${r}-${c}`} x={x + cw * c + 5} y={y + 14 * (r + 1) + 5} width={cw * (0.35 + ((r + c) % 3) * 0.15)} height={4} rx={2} className="gd-muted-fill" />
            ))
          )}
        </g>
      );
    }
    case "head":
      return (
        <g>
          {p.n !== undefined && (
            <>
              <circle cx={x + 8} cy={y + 9} r={8} className="gd-accent" />
              <text x={x + 8} y={y + 12.5} textAnchor="middle" className="gd-on-accent gd-bold" fontSize={9.5}>
                {p.n}
              </text>
            </>
          )}
          <text x={x + (p.n !== undefined ? 22 : 0)} y={y + 13} className="gd-text gd-bold" fontSize={FS}>
            {fit(p.text, w - 24, FS)}
          </text>
        </g>
      );
    case "adv":
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={8} className="gd-box" />
          <path d={`M${x + 10} ${y + 9} l4 3.5 l-4 3.5`} className="gd-stroke-muted" fill="none" strokeWidth={1.5} />
          <text x={x + 22} y={y + 16} className="gd-text gd-bold" fontSize={FS - 1}>
            {fit(p.title, w * 0.45, FS - 1)}
          </text>
          {p.summary && (
            <text x={x + w - 8} y={y + 16} textAnchor="end" className="gd-muted-text" fontSize={FS - 2.5}>
              {fit(p.summary, w * 0.48, FS - 2.5)}
            </text>
          )}
        </g>
      );
    case "run":
    case "btn": {
      const bw = Math.min(textWidth(p.label, FS - 0.5) + 26, w);
      return (
        <g>
          <rect x={x} y={y} width={bw} height={h} rx={8} className={p.k === "run" ? "gd-accent" : "gd-pill-off"} />
          <text x={x + bw / 2} y={y + 17} textAnchor="middle" className={p.k === "run" ? "gd-on-accent gd-bold" : "gd-text"} fontSize={FS - 0.5}>
            {fit(p.label, bw - 12, FS - 0.5)}
          </text>
        </g>
      );
    }
    case "preview":
      return <Preview kind={p.kind} caption={p.caption} x={x} y={y} w={w} h={h} uid={uid} />;
  }
}

/** プレビュー欄（中身は種類ごとの簡単な絵） */
function Preview({ kind, caption, x, y, w, h, uid }: { kind: GuidePreviewKind; caption?: string; x: number; y: number; w: number; h: number; uid: string }) {
  const ix = x + 10;
  const iy = y + 10;
  const iw = w - 20;
  const ih = h - 20 - (caption ? 12 : 0);
  let inner: ReactNode;
  switch (kind) {
    case "image":
    case "stamp":
    case "gradient":
      inner =
        kind === "stamp" ? (
          <circle cx={ix + iw / 2} cy={iy + ih / 2} r={Math.min(iw, ih) * 0.32} className="gd-stamp" />
        ) : kind === "gradient" ? (
          <rect x={ix} y={iy} width={iw} height={ih} rx={6} fill={`url(#gd-grad-${uid})`} />
        ) : (
          <g>
            <rect x={ix} y={iy} width={iw} height={ih} rx={6} className="gd-sky" />
            <path d={`M${ix} ${iy + ih} L${ix + iw * 0.35} ${iy + ih * 0.45} L${ix + iw * 0.55} ${iy + ih * 0.7} L${ix + iw * 0.75} ${iy + ih * 0.5} L${ix + iw} ${iy + ih} Z`} className="gd-hill" />
            <circle cx={ix + iw * 0.78} cy={iy + ih * 0.25} r={Math.min(iw, ih) * 0.08} className="gd-sun" />
          </g>
        );
      break;
    case "video":
      inner = (
        <g>
          <rect x={ix} y={iy} width={iw} height={ih} rx={6} className="gd-dark" />
          <path d={`M${ix + iw / 2 - 8} ${iy + ih / 2 - 10} l18 10 l-18 10 z`} className="gd-white-fill" />
          <rect x={ix + 8} y={iy + ih - 10} width={iw - 16} height={3} rx={1.5} className="gd-white-dim" />
        </g>
      );
      break;
    case "audio":
      inner = (
        <g>
          {Array.from({ length: 24 }, (_, i) => {
            const bh = (Math.sin(i * 1.3) * 0.5 + 0.6) * ih * 0.6;
            return <rect key={i} x={ix + (iw / 24) * i + 1} y={iy + ih / 2 - bh / 2} width={iw / 24 - 2} height={bh} rx={1} className="gd-accent-soft" />;
          })}
        </g>
      );
      break;
    case "sheet":
    case "shift":
      inner = <Part p={{ k: "table", cols: kind === "shift" ? 7 : 4, rows: Math.max(2, Math.floor(ih / 14) - 1) }} x={ix} y={iy} w={iw} h={Math.min(ih, 14 * Math.max(3, Math.floor(ih / 14)))} uid={uid} />;
      break;
    case "text":
      inner = (
        <g>
          {Array.from({ length: Math.max(2, Math.floor(ih / 12)) }, (_, i) => (
            <rect key={i} x={ix} y={iy + i * 12 + 2} width={iw * (0.5 + ((i * 37) % 45) / 100)} height={5} rx={2.5} className="gd-muted-fill" />
          ))}
        </g>
      );
      break;
    case "qr": {
      const s = Math.min(iw, ih) * 0.8;
      const qx = ix + (iw - s) / 2;
      const qy = iy + (ih - s) / 2;
      const cell = s / 9;
      const on = [0, 1, 2, 6, 7, 8, 9, 11, 15, 17, 18, 19, 20, 22, 24, 26, 30, 31, 33, 40, 42, 44, 48, 50, 54, 55, 56, 58, 62, 63, 65, 67, 69, 72, 73, 74, 76, 78, 80];
      inner = (
        <g>
          <rect x={qx - 4} y={qy - 4} width={s + 8} height={s + 8} rx={4} className="gd-white-fill" />
          {on.map((n) => (
            <rect key={n} x={qx + (n % 9) * cell} y={qy + Math.floor(n / 9) * cell} width={cell} height={cell} className="gd-ink" />
          ))}
        </g>
      );
      break;
    }
    case "calendar":
      inner = (
        <g>
          <rect x={ix} y={iy} width={iw} height={12} rx={3} className="gd-accent" />
          {Array.from({ length: 35 }, (_, i) => (
            <rect key={i} x={ix + (iw / 7) * (i % 7) + 1} y={iy + 15 + ((ih - 15) / 5) * Math.floor(i / 7)} width={iw / 7 - 2} height={(ih - 15) / 5 - 2} rx={2} className={i % 7 === 6 ? "gd-accent-soft" : "gd-box"} />
          ))}
        </g>
      );
      break;
    case "seats":
      inner = (
        <g>
          {[0, 1].map((r) =>
            [0, 1, 2].map((c) => {
              const gx = ix + (iw / 3) * c + iw / 12;
              const gy = iy + (ih / 2) * r + ih / 12;
              return (
                <g key={`${r}${c}`}>
                  <rect x={gx} y={gy} width={iw / 6} height={ih / 4} rx={3} className="gd-box" />
                  <circle cx={gx - 4} cy={gy + ih / 16} r={3} className="gd-accent-soft" />
                  <circle cx={gx - 4} cy={gy + ih / 6} r={3} className="gd-accent-soft" />
                  <circle cx={gx + iw / 6 + 4} cy={gy + ih / 16} r={3} className="gd-accent-soft" />
                  <circle cx={gx + iw / 6 + 4} cy={gy + ih / 6} r={3} className="gd-accent-soft" />
                </g>
              );
            })
          )}
        </g>
      );
      break;
    case "label":
    case "ticket":
      inner = (
        <g>
          {Array.from({ length: kind === "label" ? 8 : 6 }, (_, i) => {
            const cols = 2;
            const rows = kind === "label" ? 4 : 3;
            const cw = iw / cols;
            const rh = ih / rows;
            return (
              <g key={i}>
                <rect x={ix + cw * (i % cols) + 2} y={iy + rh * Math.floor(i / cols) + 2} width={cw - 4} height={rh - 4} rx={3} className="gd-box" strokeDasharray={kind === "ticket" ? "3 2" : undefined} />
                <rect x={ix + cw * (i % cols) + 8} y={iy + rh * Math.floor(i / cols) + rh / 2 - 3} width={cw * 0.5} height={4} rx={2} className="gd-muted-fill" />
              </g>
            );
          })}
        </g>
      );
      break;
    case "postcard": {
      // はがき（縦長の白い紙）に、写真と2行の文字
      const pw = Math.min(iw * 0.5, ih * 0.68);
      const ph = pw * 1.48;
      const px = ix + (iw - pw) / 2;
      const py = iy + Math.max(0, (ih - ph) / 2);
      inner = (
        <g>
          <rect x={px} y={py} width={pw} height={Math.min(ph, ih)} rx={3} className="gd-white-fill gd-box" />
          <rect x={px + pw * 0.15} y={py + pw * 0.15} width={pw * 0.7} height={pw * 0.5} rx={3} className="gd-sky" />
          <rect x={px + pw * 0.2} y={py + pw * 0.8} width={pw * 0.6} height={4} rx={2} className="gd-muted-fill" />
          <rect x={px + pw * 0.28} y={py + pw * 0.8 + 9} width={pw * 0.44} height={4} rx={2} className="gd-muted-fill" />
        </g>
      );
      break;
    }
    case "envelope":
      inner = (
        <g>
          <rect x={ix + iw * 0.3} y={iy} width={iw * 0.4} height={ih} rx={3} className="gd-white-fill gd-box" />
          {[0, 1, 2].map((i) => (
            <rect key={i} x={ix + iw * 0.38 + i * 9} y={iy + ih * 0.2} width={4} height={ih * (0.6 - i * 0.12)} rx={2} className="gd-muted-fill" />
          ))}
        </g>
      );
      break;
    case "invoice":
    case "pdf":
    case "doc":
      inner = (
        <g>
          <rect x={ix + iw * 0.2} y={iy} width={iw * 0.6} height={ih} rx={3} className="gd-white-fill gd-box" />
          {kind === "invoice" && <rect x={ix + iw * 0.38} y={iy + 6} width={iw * 0.24} height={6} rx={2} className="gd-ink" />}
          {Array.from({ length: Math.max(2, Math.floor((ih - 20) / 10)) }, (_, i) => (
            <rect key={i} x={ix + iw * 0.27} y={iy + 18 + i * 10} width={iw * (0.32 + ((i * 29) % 15) / 100)} height={4} rx={2} className="gd-muted-fill" />
          ))}
        </g>
      );
      break;
    case "files":
      inner = (
        <g>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x={ix} y={iy + i * 22} width={iw} height={18} rx={5} className="gd-box" />
              <rect x={ix + 6} y={iy + i * 22 + 4} width={8} height={10} rx={1.5} className="gd-muted-fill" />
              <rect x={ix + 20} y={iy + i * 22 + 7} width={iw * 0.45} height={4} rx={2} className="gd-muted-fill" />
            </g>
          ))}
        </g>
      );
      break;
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} className="gd-box" />
      {inner}
      {caption && (
        <text x={x + w / 2} y={y + h - 8} textAnchor="middle" className="gd-muted-text" fontSize={FS - 2}>
          {fit(caption, w - 12, FS - 2)}
        </text>
      )}
    </g>
  );
}

interface Placed {
  p: GuidePart;
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 部品を並べる。入りきらないときは、いま操作する部品から遠いものを省く */
function layout(step: GuideStep, variant: "pc" | "sp", split: boolean): Placed[] {
  const { w: W, h: H } = SIZE[variant];
  const innerW = W - PAD * 2;
  const innerH = H - TOP - PAD;
  const previewIndex = step.parts.findIndex((p) => p.k === "preview");
  const twoCols = variant === "pc" && split && previewIndex >= 0;
  // 左の列（または1列）の右に、番号の丸の通り道（GUTTER）をあける
  const colW = twoCols ? Math.round(innerW * 0.5) - GUTTER / 2 : innerW - GUTTER;
  const list = step.parts.map((p, i) => ({ p, i })).filter(({ i }) => !(twoCols && i === previewIndex));
  const focus = typeof step.focus === "number" ? step.focus : -1;

  // 入りきるまで、いま操作する部品から遠いものを省く
  const fixedH = (items: { p: GuidePart }[]) =>
    items.reduce((s, { p }) => s + (p.k === "preview" ? 0 : partHeight(p, colW)), 0) + GAP * Math.max(0, items.length - 1);
  let items = list;
  const minPreview = variant === "sp" ? 110 : 90;
  const hasInlinePreview = () => items.some(({ p }) => p.k === "preview");
  while (items.length > 1 && fixedH(items) + (hasInlinePreview() ? minPreview : 0) > innerH) {
    let far = -1;
    let farDist = -1;
    items.forEach(({ i, p }, idx) => {
      if (i === focus || p.k === "preview") return;
      const d = Math.abs(i - (focus < 0 ? step.parts.length : focus));
      if (d > farDist) {
        farDist = d;
        far = idx;
      }
    });
    if (far < 0) break;
    items = items.filter((_, idx) => idx !== far);
  }

  const placed: Placed[] = [];
  const usedH = fixedH(items);
  // プレビューの高さは、残りの高さ（ただし大きくしすぎない）
  const previewFill = Math.max(minPreview, Math.min(innerH - usedH, variant === "sp" ? 170 : 130));
  // 上から詰めて並べる（一番上は、番号の丸を描く分だけあける）。図の高さは中身に合わせて縮める（GuideFigure）
  let y = TOP;
  for (const { p, i } of items) {
    const h = p.k === "preview" ? previewFill : partHeight(p, colW);
    placed.push({ p, i, x: PAD, y, w: colW, h });
    y += h + GAP;
  }
  if (twoCols) {
    const pv = step.parts[previewIndex];
    const leftBottom = y - GAP;
    const h = Math.max(leftBottom - PAD, 170);
    placed.push({ p: pv, i: previewIndex, x: PAD + colW + GUTTER, y: PAD, w: innerW - colW - GUTTER, h });
  }
  return placed;
}

export function GuideFigure({
  step,
  index,
  variant,
  split = false,
  title,
}: {
  step: GuideStep;
  index: number;
  variant: "pc" | "sp";
  split?: boolean;
  /** 読み上げ用の説明 */
  title: string;
}) {
  const { w: W, h: maxH } = SIZE[variant];
  const uid = `${variant}-${index}`;
  const placed = layout(step, variant, split);
  // 図の高さは中身に合わせる（余白ばかりの図にしない）。完成の画面を重ねるときは、その分の高さを確保する
  const bottom = placed.reduce((m, pl) => Math.max(m, pl.y + pl.h), 0) + PAD;
  const H = Math.min(maxH, Math.max(bottom, step.focus === "popup" ? 170 : 110));
  const focused = typeof step.focus === "number" ? placed.find((pl) => pl.i === step.focus) : undefined;
  const popupW = Math.min(W - 40, 240);
  const popupLabel = step.popup?.label ?? "ダウンロード";
  const popupBtnW = Math.min(popupW - 28, textWidth(popupLabel, FS - 0.5) + 28);
  const popupH = 92;
  const popupX = (W - popupW) / 2;
  const popupY = (H - popupH) / 2;
  const target = step.focus === "popup" ? { x: popupX + popupW / 2 - popupBtnW / 2, y: popupY + 56, w: popupBtnW, h: 24 } : focused;

  // 番号の丸：操作する部品の右の通り道（GUTTER）に、部品の枠（gd-focus）のすぐ横に置く（矢印は、枠と丸が隣り合うので描かない）。
  // 右に通り道がない部品（2列の図の右側のプレビュー）は、部品の右上の角の内側に丸だけを置く（ほかの部品には重ねない）。
  let badge: { cx: number; cy: number } | null = null;
  if (target) {
    const right = target.x + target.w;
    const midY = target.y + Math.min(target.h, 26) / 2;
    if (W - PAD - right >= GUTTER - 6) {
      badge = { cx: right + 19, cy: midY };
    } else {
      badge = { cx: right - 16, cy: target.y + 16 };
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className={`gd-svg gd-${variant}`}>
      <defs>
        <linearGradient id={`gd-grad-${uid}`} x1="0" x2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect x={3} y={3} width={W - 6} height={H - 6} rx={16} className="gd-frame" />
      <g>
        {placed.map((pl) => (
          <g key={pl.i} opacity={step.focus === "popup" ? 0.35 : pl.i === step.focus || pl.p.k === "preview" ? 1 : 0.5}>
            <Part p={pl.p} x={pl.x} y={pl.y} w={pl.w} h={pl.h} uid={uid} />
          </g>
        ))}
      </g>
      {step.focus === "popup" && (
        <g>
          <rect x={3} y={3} width={W - 6} height={H - 6} rx={16} className="gd-scrim" />
          <rect x={popupX} y={popupY} width={popupW} height={popupH} rx={12} className="gd-popup" />
          <circle cx={popupX + 18} cy={popupY + 22} r={7} className="gd-ok" />
          <path d={`M${popupX + 14.5} ${popupY + 22} l2.5 2.5 l4 -5`} className="gd-stroke-white" fill="none" strokeWidth={1.6} />
          <text x={popupX + 30} y={popupY + 26} className="gd-text gd-bold" fontSize={FS}>
            できあがりました
          </text>
          <rect x={popupX + 14} y={popupY + 36} width={popupW - 28} height={6} rx={3} className="gd-muted-fill" />
          <rect x={popupX + popupW / 2 - popupBtnW / 2} y={popupY + 56} width={popupBtnW} height={24} rx={8} className="gd-accent" />
          <text x={popupX + popupW / 2} y={popupY + 72} textAnchor="middle" className="gd-on-accent gd-bold" fontSize={FS - 0.5}>
            {fit(popupLabel, popupBtnW - 10, FS - 0.5)}
          </text>
        </g>
      )}
      {target && (
        <rect x={target.x - 4} y={target.y - 4} width={target.w + 8} height={target.h + 8} rx={10} className="gd-focus" />
      )}
      {badge && (
        <g>
          <circle cx={badge.cx} cy={badge.cy} r={11} className="gd-badge" />
          <text x={badge.cx} y={badge.cy + 4} textAnchor="middle" className="gd-on-accent gd-bold" fontSize={12}>
            {index + 1}
          </text>
        </g>
      )}
    </svg>
  );
}
