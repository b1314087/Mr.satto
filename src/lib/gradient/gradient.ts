/**
 * グラデーションの定義とCSS文字列・Canvas描画。
 * CSSコードとPNG書き出しの見た目が一致するよう、同じ定義(GradientSpec)から両方を作る。
 */

export type GradientType = "linear" | "radial" | "conic";

export interface GradientStop {
  /** #rrggbb */
  color: string;
  /** 0〜100(%) */
  position: number;
}

export interface GradientSpec {
  type: GradientType;
  /** linear/conic: 角度(度)。linearは0=上向き、90=右向き(CSSと同じ) */
  angle: number;
  /** radial: 形 */
  radialShape: "circle" | "ellipse";
  /** radial/conic: 中心(%)。 */
  centerX: number;
  centerY: number;
  stops: GradientStop[];
}

export const MIN_STOPS = 2;
export const MAX_STOPS = 8;

export const DEFAULT_GRADIENT: GradientSpec = {
  type: "linear",
  angle: 90,
  radialShape: "circle",
  centerX: 50,
  centerY: 50,
  stops: [
    { color: "#6366f1", position: 0 },
    { color: "#ec4899", position: 100 },
  ],
};

export const GRADIENT_PRESETS: { name: string; spec: Partial<GradientSpec> & Pick<GradientSpec, "stops"> }[] = [
  { name: "夕焼け", spec: { type: "linear", angle: 135, stops: [{ color: "#ff7e5f", position: 0 }, { color: "#feb47b", position: 100 }] } },
  { name: "海", spec: { type: "linear", angle: 180, stops: [{ color: "#2193b0", position: 0 }, { color: "#6dd5ed", position: 100 }] } },
  { name: "森", spec: { type: "linear", angle: 135, stops: [{ color: "#134e5e", position: 0 }, { color: "#71b280", position: 100 }] } },
  { name: "ラベンダー", spec: { type: "linear", angle: 90, stops: [{ color: "#a18cd1", position: 0 }, { color: "#fbc2eb", position: 100 }] } },
  { name: "レインボー", spec: { type: "linear", angle: 90, stops: [{ color: "#ef4444", position: 0 }, { color: "#eab308", position: 25 }, { color: "#22c55e", position: 50 }, { color: "#3b82f6", position: 75 }, { color: "#a855f7", position: 100 }] } },
  { name: "ミッドナイト", spec: { type: "radial", radialShape: "circle", centerX: 50, centerY: 30, stops: [{ color: "#334155", position: 0 }, { color: "#0f172a", position: 100 }] } },
  { name: "カラーホイール", spec: { type: "conic", angle: 0, centerX: 50, centerY: 50, stops: [{ color: "#ef4444", position: 0 }, { color: "#eab308", position: 33 }, { color: "#3b82f6", position: 66 }, { color: "#ef4444", position: 100 }] } },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 位置順に並べ替えた色の止まり位置を返す(元の配列は変更しない) */
export function sortedStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.position - b.position);
}

function stopsToCss(stops: GradientStop[]): string {
  return sortedStops(stops)
    .map((s) => `${s.color.toLowerCase()} ${Math.round(clamp(s.position, 0, 100) * 10) / 10}%`)
    .join(", ");
}

/** `linear-gradient(...)` などの値部分(`background:` の右辺)を作る */
export function gradientToCssValue(spec: GradientSpec): string {
  const stops = stopsToCss(spec.stops);
  const a = Math.round(spec.angle);
  if (spec.type === "linear") return `linear-gradient(${a}deg, ${stops})`;
  if (spec.type === "radial") {
    return `radial-gradient(${spec.radialShape} at ${spec.centerX}% ${spec.centerY}%, ${stops})`;
  }
  return `conic-gradient(from ${a}deg at ${spec.centerX}% ${spec.centerY}%, ${stops})`;
}

/** コピーして使える完全なCSS宣言。古いブラウザ向けに単色のフォールバックも先頭に付ける */
export function gradientToCss(spec: GradientSpec): string {
  const fallback = sortedStops(spec.stops)[0]?.color.toLowerCase() ?? "#000000";
  return `background: ${fallback};\nbackground: ${gradientToCssValue(spec)};`;
}

/** 色の止まり位置を1つ追加する(隣り合う色の中間色・中間位置)。上限(MAX_STOPS)に達していれば変更しない */
export function addStop(stops: GradientStop[]): GradientStop[] {
  if (stops.length >= MAX_STOPS) return stops;
  const sorted = sortedStops(stops);
  // 一番間隔の広い隣り合う2色の間に入れる
  let bestIdx = 0;
  let bestGap = -1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].position - sorted[i].position;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  const a = sorted[bestIdx];
  const b = sorted[bestIdx + 1] ?? a;
  return [...stops, { color: mixHex(a.color, b.color, 0.5), position: Math.round((a.position + b.position) / 2) }];
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** 位置を左右反転する(並びを逆にする) */
export function reverseStops(stops: GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ ...s, position: 100 - s.position }));
}

export function randomHex(rand: () => number = Math.random): string {
  const h = Math.floor(rand() * 360);
  const s = 0.55 + rand() * 0.35;
  const l = 0.45 + rand() * 0.2;
  // HSL→RGB
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function randomGradient(rand: () => number = Math.random): GradientSpec {
  const types: GradientType[] = ["linear", "linear", "radial", "conic"];
  const type = types[Math.floor(rand() * types.length)];
  const count = 2 + Math.floor(rand() * 2);
  const stops: GradientStop[] = Array.from({ length: count }, (_, i) => ({
    color: randomHex(rand),
    position: Math.round((i / (count - 1)) * 100),
  }));
  if (type === "conic") stops.push({ color: stops[0].color, position: 100 }); // 一周して元の色へ戻す
  return {
    type,
    angle: Math.floor(rand() * 36) * 10,
    radialShape: rand() < 0.5 ? "circle" : "ellipse",
    centerX: 50,
    centerY: 50,
    stops: type === "conic" ? stops.map((s, i, arr) => ({ ...s, position: Math.round((i / (arr.length - 1)) * 100) })) : stops,
  };
}

/** PNG書き出し用: キャンバスへグラデーションを塗る(CSSと同じ見た目になるよう同じ定義から作る) */
export function paintGradient(ctx: CanvasRenderingContext2D, width: number, height: number, spec: GradientSpec): void {
  const stops = sortedStops(spec.stops);
  let gradient: CanvasGradient;
  if (spec.type === "linear") {
    // CSSのlinear-gradient(角度): 角度0=上向き。グラデーション線の長さは |W sinθ| + |H cosθ|
    const rad = (spec.angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const len = Math.abs(width * dx) + Math.abs(height * dy);
    const cx = width / 2;
    const cy = height / 2;
    gradient = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  } else if (spec.type === "radial") {
    const cx = (spec.centerX / 100) * width;
    const cy = (spec.centerY / 100) * height;
    // farthest-corner(CSSの既定)まで届く半径
    const far = Math.max(Math.hypot(cx, cy), Math.hypot(width - cx, cy), Math.hypot(cx, height - cy), Math.hypot(width - cx, height - cy));
    if (spec.radialShape === "circle") {
      gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, far);
    } else {
      // ellipse: 円を縦横比に合わせて伸縮して描く
      ctx.save();
      const rx = Math.max(cx, width - cx) * Math.SQRT2;
      const ry = Math.max(cy, height - cy) * Math.SQRT2;
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const s of stops) gradient.addColorStop(clamp(s.position / 100, 0, 1), s.color);
      ctx.fillStyle = gradient;
      ctx.fillRect(-cx / rx, -cy / ry, width / rx, height / ry);
      ctx.restore();
      return;
    }
  } else {
    const cx = (spec.centerX / 100) * width;
    const cy = (spec.centerY / 100) * height;
    // CSSのconic-gradient(from θ): 0度が上向き、時計回り。CanvasのcreateConicGradientは0度が右向きのため-90度ずらす
    gradient = ctx.createConicGradient(((spec.angle - 90) * Math.PI) / 180, cx, cy);
  }
  for (const s of stops) gradient.addColorStop(clamp(s.position / 100, 0, 1), s.color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}
