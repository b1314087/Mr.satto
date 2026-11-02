/**
 * 動画モザイク（Stage 5）：モザイクをかける範囲と、その時刻ごとの位置。
 *
 * 決まり（画面のプレビュー・書き出し・テストで共通）:
 * - 座標は元の動画の画素（表示の向き。縦向きに撮った動画は縦向きの画素）。画面の表示サイズには依存しない。
 * - 「固定」の範囲は、動画のどの時刻でも同じ位置。
 * - 「追跡」の範囲は、追跡した結果（track：時刻ごとの位置）を使う。利用者が手で直した位置（keyframes）は、追跡の結果より優先する。
 *   追跡の結果が無い時刻は、いちばん近い時刻の位置を使う（動画の最初・最後まで、端の位置のままかかり続ける）。
 * - 範囲ごとに、かける時間（from〜to）を決められる。決めなければ、動画の最初から最後まで。
 */

export type EffectKind = "mosaic" | "blur" | "fill";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackPoint extends Box {
  t: number;
  /** 追跡の確からしさ（0〜1）。低いと「ずれているかも」 */
  score: number;
}

export interface Keyframe extends Box {
  t: number;
}

export interface MosaicRegion {
  id: string;
  mode: "fixed" | "track";
  kind: EffectKind;
  /** 強さ 1〜10 */
  level: number;
  /** 固定の範囲・追跡を始める前の範囲 */
  box: Box;
  /** 手で決めた位置（時刻の順） */
  keyframes: Keyframe[];
  /** 追跡した結果（時刻の順） */
  track: TrackPoint[];
  /** かける時間（秒）。null は動画の最初・最後まで */
  from: number | null;
  to: number | null;
}

export const LOW_SCORE = 0.55;
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

export function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
}

/** 範囲を動画の内側に収める（幅・高さは最低4画素） */
export function clampBox(b: Box, width: number, height: number): Box {
  const w = Math.max(4, Math.min(b.w, width));
  const h = Math.max(4, Math.min(b.h, height));
  const x = Math.min(Math.max(0, b.x), width - w);
  const y = Math.min(Math.max(0, b.y), height - h);
  return { x, y, w, h };
}

function nearestIndex<T extends { t: number }>(list: T[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(list[lo - 1].t - t) <= Math.abs(list[lo].t - t)) return lo - 1;
  return lo;
}

function lerpBox(a: Box & { t: number }, b: Box & { t: number }, t: number): Box {
  const span = b.t - a.t;
  const k = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - a.t) / span));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
}

/** その時刻に、範囲がかかっているか */
export function isActiveAt(region: MosaicRegion, t: number): boolean {
  if (region.from !== null && t < region.from - 1e-6) return false;
  if (region.to !== null && t > region.to + 1e-6) return false;
  return true;
}

/**
 * その時刻の範囲の位置。frameSec は1フレームの長さ（手で直した位置を、その前後半フレームでは必ず使うため）。
 */
export function boxAt(region: MosaicRegion, t: number, frameSec = 1 / 30): Box {
  if (region.mode === "fixed") return region.box;
  const kf = region.keyframes;
  if (kf.length > 0) {
    const k = kf[nearestIndex(kf, t)];
    if (Math.abs(k.t - t) <= frameSec / 2 + 1e-6) return k;
  }
  const tr = region.track;
  if (tr.length > 0) {
    // 追跡した点の間は、前後の点からなめらかにつなぐ（書き出しのフレームと追跡のフレームが少しずれても、範囲が飛ばない）
    const i = nearestIndex(tr, t);
    const p = tr[i];
    if (t >= p.t && i + 1 < tr.length && tr[i + 1].t - p.t <= frameSec * 3) return lerpBox(p, tr[i + 1], t);
    if (t < p.t && i > 0 && p.t - tr[i - 1].t <= frameSec * 3) return lerpBox(tr[i - 1], p, t);
    return p;
  }
  if (kf.length > 0) {
    // まだ追跡していないときは、手で決めた位置の間を直線でつなぐ
    const i = nearestIndex(kf, t);
    const k = kf[i];
    if (t >= k.t && i + 1 < kf.length) return lerpBox(k, kf[i + 1], t);
    if (t < k.t && i > 0) return lerpBox(kf[i - 1], k, t);
    return k;
  }
  return region.box;
}

/** その時刻の追跡の確からしさ（追跡していない・手で直した時刻は null） */
export function scoreAt(region: MosaicRegion, t: number, frameSec = 1 / 30): number | null {
  if (region.mode !== "track" || region.track.length === 0) return null;
  const kf = region.keyframes;
  if (kf.length > 0 && Math.abs(kf[nearestIndex(kf, t)].t - t) <= frameSec / 2 + 1e-6) return null;
  return region.track[nearestIndex(region.track, t)].score;
}

/** 手で位置を直す（同じ時刻の手直しは置き換える） */
export function setKeyframe(region: MosaicRegion, t: number, box: Box, frameSec = 1 / 30): MosaicRegion {
  const keyframes = region.keyframes.filter((k) => Math.abs(k.t - t) > frameSec / 2 + 1e-6);
  keyframes.push({ t, ...box });
  keyframes.sort((a, b) => a.t - b.t);
  return { ...region, keyframes };
}

/** 強さに応じた、モザイクの1マスの大きさ（画素）。動画の短い辺が720画素のときを基準に、解像度に合わせて変える */
export function blockSize(level: number, shortSide: number): number {
  return Math.max(2, Math.round((4 + clampLevel(level) * 4) * (shortSide / 720)));
}

/** ぼかしの半径（画素） */
export function blurRadius(level: number, shortSide: number): number {
  return Math.max(1, Math.round(clampLevel(level) * 2.2 * (shortSide / 720)));
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** モザイクを描くための、使い回す小さなキャンバス */
export class EffectPainter {
  private small: AnyCanvas | null = null;

  /**
   * ctx の上の box（ctx の座標）に、効果をかける。
   * source は、効果をかける前の絵（ctx のキャンバス自身でもよい）。shortSide は、元の動画の短い辺（強さの基準）。
   */
  apply(ctx: Ctx2D, source: CanvasImageSource, box: Box, kind: EffectKind, level: number, shortSide: number, scale = 1) {
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    const w = Math.max(1, Math.round(box.w));
    const h = Math.max(1, Math.round(box.h));
    if (kind === "fill") {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      return;
    }
    if (kind === "blur" && "filter" in ctx) {
      const r = blurRadius(level, shortSide) * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${r}px)`;
      // ぼかしの端が薄くならないよう、少し広い範囲を描く
      const pad = Math.ceil(r * 2);
      ctx.drawImage(source, x - pad, y - pad, w + pad * 2, h + pad * 2, x - pad, y - pad, w + pad * 2, h + pad * 2);
      ctx.restore();
      ctx.filter = "none";
      return;
    }
    const block = Math.max(1, blockSize(level, shortSide) * scale);
    const sw = Math.max(1, Math.round(w / block));
    const sh = Math.max(1, Math.round(h / block));
    if (!this.small || this.small.width < sw || this.small.height < sh) this.small = makeCanvas(Math.max(sw, 16), Math.max(sh, 16));
    const sctx = this.small.getContext("2d") as Ctx2D | null;
    if (!sctx) return;
    sctx.imageSmoothingEnabled = true;
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(source, x, y, w, h, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.small, 0, 0, sw, sh, x, y, w, h);
    ctx.restore();
  }
}

export function newRegionId(): string {
  return `r${Math.random().toString(36).slice(2, 9)}`;
}
