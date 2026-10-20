/**
 * PowerPoint白黒反転の「反転後の配色」（背景色・文字色）の選択肢と、入力の検査（Mr.Satto）。
 * 色は6桁の16進（RRGGBB、先頭の # なし・大文字）で持つ。画面と処理で同じ決まりを使う。
 */
import { isDefaultPalette, parseHex, toHex, type Palette, type Rgb } from "./color";

export interface ColorChoice {
  /** 背景色（元の白に当たる色）。RRGGBB */
  background: string;
  /** 文字色（元の黒に当たる色）。RRGGBB */
  text: string;
}

export interface PalettePreset extends ColorChoice {
  id: "pure" | "dark-gray" | "charcoal";
  name: string;
}

/** 配色のプリセット。先頭が既定（従来の白黒反転と同じ） */
export const PALETTE_PRESETS: readonly PalettePreset[] = [
  { id: "pure", name: "純黒 × 純白", background: "000000", text: "FFFFFF" },
  { id: "dark-gray", name: "ダークグレー × 薄い白", background: "171717", text: "F2F2F2" },
  { id: "charcoal", name: "チャコール × 暖色系の白", background: "262626", text: "FFF4E5" },
];

export const DEFAULT_COLOR_CHOICE: ColorChoice = { background: PALETTE_PRESETS[0].background, text: PALETTE_PRESETS[0].text };

/** 「#RRGGBB」「RRGGBB」（大文字・小文字どちらも）を「RRGGBB」（大文字）にする。6桁の16進でなければ null */
export function normalizeHex(value: string | undefined | null): string | null {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

/** 配色が、プリセットのどれと同じか（なければ null） */
export function presetOf(choice: ColorChoice): PalettePreset | null {
  const b = normalizeHex(choice.background);
  const t = normalizeHex(choice.text);
  return PALETTE_PRESETS.find((p) => p.background === b && p.text === t) ?? null;
}

/**
 * 処理に渡す配色にする。既定（純黒×純白）のとき、または色の指定が正しくないときは null（従来の白黒反転）。
 * invalid は、色の指定が正しくなかったかどうか。
 */
export function resolvePalette(choice: ColorChoice | undefined): { palette: Palette | null; invalid: boolean; choice: ColorChoice } {
  if (!choice) return { palette: null, invalid: false, choice: DEFAULT_COLOR_CHOICE };
  const background = parseHex(choice.background);
  const text = parseHex(choice.text);
  if (!background || !text) return { palette: null, invalid: true, choice: DEFAULT_COLOR_CHOICE };
  const palette: Palette = { background, text };
  return { palette: isDefaultPalette(palette) ? null : palette, invalid: false, choice: { background: toHex(background), text: toHex(text) } };
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

/** 2色のコントラスト比（1〜21。WCAG の定義）。色の指定が正しくなければ null */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

