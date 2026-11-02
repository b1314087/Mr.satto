import { CanvasSink, type InputVideoTrack } from "mediabunny";
import { VideoCanceledByUserError } from "./shared";
import { LOW_SCORE, type Box, type Keyframe, type TrackPoint } from "./mosaic-regions";

/**
 * 動画モザイク（Stage 5）：指定した範囲の追跡。ブラウザ内だけで行う（外部送信・AIなし・新しい依存なし）。
 *
 * 方式：正規化相互相関（NCC）によるテンプレートマッチング。
 * - 指定した範囲の絵（テンプレート）を覚え、次のフレームで、前の位置のまわりから、いちばん似ている場所を探す。
 * - 動きの向き（直前の移動量）から次の位置を予測して、探す範囲の中心にする。少し大きく・小さく（±6%）も試し、大きさの変化にも合わせる。
 * - よく一致したフレームでは、テンプレートを少しずつ新しい見た目に寄せる（向きや明るさがゆっくり変わっても追える）。
 * - 一致の度合い（score）が低いフレームは「ずれているかも」として印を付け、位置は予測のまま保つ（利用者が直せるように）。
 * - 速さのため、範囲が約48画素の大きさになるまで縮小したフレームで計算する（1フレームあたり数ミリ秒）。
 * - 手で直した位置（keyframes）の時刻に来たら、その位置から追跡し直す。
 *
 * 苦手な場面：対象が隠れる・画面の外へ出る・大きく回転する・急に大きさが変わる・似た模様が近くにある。
 * その場合は score が下がるので、画面で位置を直して「ここから追跡し直す」を使う。
 *
 * メモリ：フレームは1枚ずつ読み、縮小した明るさの配列だけを使う（前へさかのぼる追跡は、約1.5秒ずつまとめて読む）。
 */

const TEMPLATE_SIDE = 48;
const BACK_CHUNK_SEC = 1.5;

interface Lum {
  data: Float32Array;
  w: number;
  h: number;
}

/** 縮小したフレームの、明るさの配列 */
class LumReader {
  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  constructor(
    private w: number,
    private h: number
  ) {
    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(w, h);
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error("この環境では、追跡に必要な画像の処理ができません。");
    this.ctx = ctx;
  }
  read(src: CanvasImageSource): Lum {
    this.ctx.drawImage(src, 0, 0, this.w, this.h);
    const px = this.ctx.getImageData(0, 0, this.w, this.h).data;
    const data = new Float32Array(this.w * this.h);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
    return { data, w: this.w, h: this.h };
  }
}

/** frame の (x, y, bw, bh) の範囲を、tw×th に縮めて取り出す（最近傍） */
function samplePatch(f: Lum, x: number, y: number, bw: number, bh: number, tw: number, th: number, out: Float32Array): boolean {
  if (x < 0 || y < 0 || x + bw > f.w || y + bh > f.h) return false;
  const sx = bw / tw;
  const sy = bh / th;
  for (let j = 0; j < th; j++) {
    const row = (Math.floor(y + (j + 0.5) * sy)) * f.w;
    for (let i = 0; i < tw; i++) out[j * tw + i] = f.data[row + Math.floor(x + (i + 0.5) * sx)];
  }
  return true;
}

function normalize(a: Float32Array): number {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length;
  let ss = 0;
  for (let i = 0; i < a.length; i++) {
    a[i] -= mean;
    ss += a[i] * a[i];
  }
  return Math.sqrt(ss);
}

/** 正規化相互相関（-1〜1）。テンプレートは平均を引いたもの（tNorm はその大きさ） */
function ncc(t: Float32Array, tNorm: number, p: Float32Array): number {
  let mean = 0;
  for (let i = 0; i < p.length; i++) mean += p[i];
  mean /= p.length;
  let dot = 0;
  let ss = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i] - mean;
    dot += v * t[i];
    ss += v * v;
  }
  if (ss < 1e-6 || tNorm < 1e-6) return 0;
  return dot / (Math.sqrt(ss) * tNorm);
}

export class TemplateTracker {
  private tw: number;
  private th: number;
  private template: Float32Array;
  private tNorm = 0;
  private patch: Float32Array;
  /** 範囲（縮小したフレームの座標） */
  box: Box;
  private vx = 0;
  private vy = 0;

  constructor(frame: Lum, box: Box) {
    const ratio = box.w / box.h;
    this.tw = Math.max(8, Math.round(ratio >= 1 ? TEMPLATE_SIDE : TEMPLATE_SIDE * ratio));
    this.th = Math.max(8, Math.round(ratio >= 1 ? TEMPLATE_SIDE / ratio : TEMPLATE_SIDE));
    this.template = new Float32Array(this.tw * this.th);
    this.patch = new Float32Array(this.tw * this.th);
    this.box = { ...box };
    this.reset(frame, box);
  }

  /** その位置の絵を、新しいテンプレートにする（手で直した位置から追跡し直すとき） */
  reset(frame: Lum, box: Box) {
    const b = this.fit(frame, box);
    this.box = b;
    samplePatch(frame, Math.round(b.x), Math.round(b.y), Math.max(1, Math.round(b.w)), Math.max(1, Math.round(b.h)), this.tw, this.th, this.template);
    this.tNorm = normalize(this.template);
    this.vx = 0;
    this.vy = 0;
  }

  private fit(f: Lum, b: Box): Box {
    const w = Math.max(4, Math.min(b.w, f.w));
    const h = Math.max(4, Math.min(b.h, f.h));
    return { x: Math.min(Math.max(0, b.x), f.w - w), y: Math.min(Math.max(0, b.y), f.h - h), w, h };
  }

  private scoreAt(f: Lum, x: number, y: number, w: number, h: number): number {
    if (!samplePatch(f, Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), this.tw, this.th, this.patch)) return -1;
    return ncc(this.template, this.tNorm, this.patch);
  }

  /** 次のフレームで、範囲を探す。戻り値は一致の度合い */
  step(f: Lum): number {
    const { w, h } = this.box;
    const px = this.box.x + this.vx;
    const py = this.box.y + this.vy;
    const radius = Math.max(6, Math.round(Math.max(w, h) * 0.75));
    const step = Math.max(1, Math.round(Math.max(w, h) / TEMPLATE_SIDE)) * 2;
    let best = -2;
    let bx = px;
    let by = py;
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const s = this.scoreAt(f, px + dx, py + dy, w, h);
        if (s > best) {
          best = s;
          bx = px + dx;
          by = py + dy;
        }
      }
    }
    // 細かく合わせる
    const fine = Math.max(1, step / 2);
    for (let pass = 0; pass < 2; pass++) {
      const cx = bx;
      const cy = by;
      for (let dy = -step; dy <= step; dy += fine) {
        for (let dx = -step; dx <= step; dx += fine) {
          const s = this.scoreAt(f, cx + dx, cy + dy, w, h);
          if (s > best) {
            best = s;
            bx = cx + dx;
            by = cy + dy;
          }
        }
      }
    }
    // 大きさの変化（中心を保って ±6%）
    let bw = w;
    let bh = h;
    for (const sc of [0.94, 1.06]) {
      const nw = w * sc;
      const nh = h * sc;
      const nx = bx + (w - nw) / 2;
      const ny = by + (h - nh) / 2;
      const s = this.scoreAt(f, nx, ny, nw, nh);
      if (s > best + 0.01) {
        best = s;
        bw = nw;
        bh = nh;
        bx = nx;
        by = ny;
      }
    }

    if (best < LOW_SCORE) {
      // 見失ったかもしれない：位置は予測のまま（動きは弱める）にして、テンプレートは変えない
      this.box = this.fit(f, { x: px, y: py, w, h });
      this.vx *= 0.5;
      this.vy *= 0.5;
      return Math.max(0, best);
    }
    const nb = this.fit(f, { x: bx, y: by, w: w * 0.7 + bw * 0.3, h: h * 0.7 + bh * 0.3 });
    this.vx = this.vx * 0.5 + (nb.x - this.box.x) * 0.5;
    this.vy = this.vy * 0.5 + (nb.y - this.box.y) * 0.5;
    this.box = nb;
    if (best > 0.75) {
      // よく一致したときは、テンプレートを今の見た目に少し寄せる
      if (samplePatch(f, Math.round(nb.x), Math.round(nb.y), Math.max(1, Math.round(nb.w)), Math.max(1, Math.round(nb.h)), this.tw, this.th, this.patch)) {
        normalize(this.patch);
        for (let i = 0; i < this.template.length; i++) this.template[i] = this.template[i] * 0.9 + this.patch[i] * 0.1;
        let ss = 0;
        for (let i = 0; i < this.template.length; i++) ss += this.template[i] * this.template[i];
        this.tNorm = Math.sqrt(ss);
      }
    }
    return best;
  }
}

export interface TrackParams {
  videoTrack: InputVideoTrack;
  /** 元の動画の大きさ（表示の向き） */
  width: number;
  height: number;
  durationSec: number;
  frameRate: number;
  /** 追跡を始める位置（時刻と範囲） */
  anchor: Keyframe;
  /** 手で直した位置（ここに来たら、その位置から追跡し直す） */
  keyframes: Keyframe[];
  direction: "both" | "forward";
  /** 追跡する時間の範囲（秒） */
  from?: number | null;
  to?: number | null;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/** 縮小の倍率：範囲の長い辺が約48画素になるように（フレームの幅は160〜960画素） */
export function analysisScale(width: number, box: Box): number {
  let s = Math.min(1, TEMPLATE_SIDE / Math.max(box.w, box.h));
  s = Math.max(s, 160 / width);
  s = Math.min(s, 960 / width, 1);
  return s;
}

function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export async function trackRegion(p: TrackParams): Promise<TrackPoint[]> {
  const s = analysisScale(p.width, p.anchor);
  const aw = Math.max(16, Math.round(p.width * s));
  const ah = Math.max(16, Math.round(p.height * s));
  const sx = aw / p.width;
  const sy = ah / p.height;
  const toA = (b: Box): Box => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy });
  const fromA = (b: Box): Box => ({ x: b.x / sx, y: b.y / sy, w: b.w / sx, h: b.h / sy });
  const frameSec = 1 / Math.max(1, p.frameRate);
  const from = Math.max(0, p.from ?? 0);
  const to = Math.min(p.durationSec, p.to ?? p.durationSec);
  const total = Math.max(1e-3, (p.direction === "both" ? to - from : to - p.anchor.t));
  let done = 0;
  const sink = new CanvasSink(p.videoTrack, { width: aw, height: ah, fit: "fill", poolSize: 2 });
  const reader = new LumReader(aw, ah);
  const keyAt = (t: number) => p.keyframes.find((k) => Math.abs(k.t - t) <= frameSec / 2 + 1e-6);
  const check = () => {
    if (p.signal?.aborted) throw new VideoCanceledByUserError("追跡を止めました。");
  };

  const forward: TrackPoint[] = [];
  let tracker: TemplateTracker | null = null;
  let count = 0;
  for await (const wc of sink.canvases(Math.max(from, p.anchor.t - frameSec / 2), to + 1e-6)) {
    check();
    const lum = reader.read(wc.canvas);
    const t = wc.timestamp;
    const kf = keyAt(t);
    if (!tracker) {
      tracker = new TemplateTracker(lum, toA(p.anchor));
      forward.push({ t, ...fromA(tracker.box), score: 1 });
    } else if (kf) {
      tracker.reset(lum, toA(kf));
      forward.push({ t, ...fromA(tracker.box), score: 1 });
    } else {
      const score = tracker.step(lum);
      forward.push({ t, ...fromA(tracker.box), score });
    }
    done = t - p.anchor.t;
    p.onProgress?.(Math.min(1, done / total));
    if (++count % 3 === 0) await yieldToUi();
  }

  if (p.direction === "forward" || p.anchor.t <= from + frameSec / 2) return forward;

  // さかのぼる：少しずつ前の区間を読み、後ろから順に追跡する
  const backward: TrackPoint[] = [];
  let end = forward.length > 0 ? forward[0].t : p.anchor.t;
  const firstFrame = await sink.getCanvas(end);
  check();
  if (!firstFrame) return forward;
  const back = new TemplateTracker(reader.read(firstFrame.canvas), toA(p.anchor));
  while (end > from + 1e-6) {
    const start = Math.max(from, end - BACK_CHUNK_SEC);
    const frames: { t: number; lum: Lum }[] = [];
    for await (const wc of sink.canvases(start, end - 1e-6)) {
      check();
      if (wc.timestamp >= end - 1e-6) break;
      frames.push({ t: wc.timestamp, lum: reader.read(wc.canvas) });
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      check();
      const { t, lum } = frames[i];
      const kf = keyAt(t);
      if (kf) {
        back.reset(lum, toA(kf));
        backward.push({ t, ...fromA(back.box), score: 1 });
      } else {
        const score = back.step(lum);
        backward.push({ t, ...fromA(back.box), score });
      }
      if (i % 3 === 0) await yieldToUi();
    }
    if (frames.length === 0) break;
    done += end - start;
    p.onProgress?.(Math.min(1, done / total));
    end = frames[0].t;
    if (start <= from + 1e-6) break;
  }
  backward.reverse();
  return [...backward, ...forward];
}

/** 追跡し直した結果を、もとの結果に入れる（start 以降を置き換える） */
export function mergeTrackFrom(prev: TrackPoint[], next: TrackPoint[], start: number, frameSec: number): TrackPoint[] {
  return [...prev.filter((pt) => pt.t < start - frameSec / 2), ...next].sort((a, b) => a.t - b.t);
}
