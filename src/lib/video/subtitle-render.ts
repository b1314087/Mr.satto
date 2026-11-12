/**
 * 字幕の描画（総合改修 11）。
 *
 * プレビュー（動画の上に重ねたキャンバス）と「映像に焼き付ける」書き出しの両方で、この関数を使う。
 * 同じ計算・同じ解像度（動画の表示サイズ）で描くので、文字の位置・大きさ・色・縁取り・フェードが一致する。
 */
import { SUBTITLE_FONT_OPTIONS, hexToRgba, normalizeLook, type ResolvedCue } from "./subtitles";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SubtitleBackground {
  /** 背景（帯）の色 #rrggbb */
  color: string;
  /** 背景の濃さ 0〜100（0で背景なし） */
  opacity: number;
}

/** フェードの長さを、字幕の表示時間に収める（フェードイン＋フェードアウトが表示時間を超えるときは、割合を保って縮める） */
export function effectiveFades(cue: Pick<ResolvedCue, "startSec" | "endSec" | "look">): { fadeIn: number; fadeOut: number } {
  const dur = Math.max(0, cue.endSec - cue.startSec);
  const fi = Math.max(0, cue.look.fadeIn);
  const fo = Math.max(0, cue.look.fadeOut);
  if (fi + fo <= dur || fi + fo === 0) return { fadeIn: fi, fadeOut: fo };
  const k = dur / (fi + fo);
  return { fadeIn: fi * k, fadeOut: fo * k };
}

/** ある時間の、字幕の不透明度（0〜1）。表示時間の外は 0 */
export function cueAlphaAt(cue: Pick<ResolvedCue, "startSec" | "endSec" | "look">, t: number): number {
  if (t < cue.startSec || t >= cue.endSec) return 0;
  const { fadeIn, fadeOut } = effectiveFades(cue);
  let a = 1;
  if (fadeIn > 0) a = Math.min(a, (t - cue.startSec) / fadeIn);
  if (fadeOut > 0) a = Math.min(a, (cue.endSec - t) / fadeOut);
  return Math.max(0, Math.min(1, a));
}

export function fontCss(cue: Pick<ResolvedCue, "look">, px: number): string {
  const f = SUBTITLE_FONT_OPTIONS.find((o) => o.value === cue.look.font) ?? SUBTITLE_FONT_OPTIONS[0];
  return `${f.weight} ${px}px ${f.family}`;
}

/** 文字の大きさ（px）。動画の高さに対する割合から */
export function cueFontPx(cue: Pick<ResolvedCue, "look">, height: number): number {
  return Math.max(4, (cue.look.size / 100) * height);
}

/**
 * 動画の1コマ（幅 W・高さ H）に、時間 t に表示する字幕を描く。
 * - 位置（x・y）は、文字のまとまりの中心。画面の外にはみ出すときは、内側へ寄せる。
 * - 縁取りは文字の大きさに合わせた太さ。背景（帯）は全体の設定。
 */
export function drawSubtitles(ctx: Ctx2D, W: number, H: number, cues: ResolvedCue[], t: number, background: SubtitleBackground): void {
  for (const raw of cues) {
    const cue = { ...raw, look: normalizeLook(raw.look) };
    const alpha = cueAlphaAt(cue, t);
    if (alpha <= 0) continue;
    const px = cueFontPx(cue, H);
    const lineH = px * 1.25;
    const lines = cue.text.split("\n");
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = fontCss(cue, px);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const widths = lines.map((l) => ctx.measureText(l).width);
    const blockW = Math.max(...widths, 0);
    const blockH = lineH * lines.length;
    const padX = px * 0.35;
    const outlineW = cue.look.outline ? Math.max(1, px * 0.16) : 0;
    // 中心の位置。文字のまとまりが画面からはみ出すときは、内側へ寄せる
    const halfW = blockW / 2 + padX + outlineW;
    const halfH = blockH / 2 + outlineW;
    let cx = (cue.look.x / 100) * W;
    let cy = (cue.look.y / 100) * H;
    cx = halfW * 2 >= W ? W / 2 : Math.min(W - halfW, Math.max(halfW, cx));
    cy = halfH * 2 >= H ? H / 2 : Math.min(H - halfH, Math.max(halfH, cy));
    const top = cy - blockH / 2;
    lines.forEach((line, i) => {
      const y = top + lineH * (i + 0.5);
      if (background.opacity > 0 && line.trim() !== "") {
        ctx.fillStyle = hexToRgba(background.color, background.opacity);
        const w = widths[i] + padX * 2;
        ctx.fillRect(cx - w / 2, y - lineH / 2, w, lineH);
      }
      if (cue.look.outline) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.lineWidth = outlineW * 2;
        ctx.strokeStyle = cue.look.outlineColor;
        ctx.strokeText(line, cx, y);
      }
      ctx.fillStyle = cue.look.color;
      ctx.fillText(line, cx, y);
    });
    ctx.restore();
  }
}
