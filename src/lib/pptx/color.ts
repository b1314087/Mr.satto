/**
 * PowerPoint白黒反転ツールの色の決まり（Mr.Satto）。
 *
 * 白背景・黒文字を、黒背景・白文字にするため、色を次の3つに分ける。
 *   1. 無彩色（白・黒・灰色。RGBの差が小さい色）  → 明るさを反転する（白↔黒、明るい灰色↔暗い灰色）
 *   2. ごく明るい／ごく暗い色（淡い色の塗りつぶし・ほぼ黒の濃い色）→ 色合いは変えず、明るさだけを反転する
 *      （淡い黄色の塗りに黒文字、のような組み合わせで、文字だけが白くなって読めなくなるのを防ぐ）
 *   3. それ以外（赤・青などの、はっきりした色）  → 変えない（そのまま残す）
 * 「文字を明るくする」オプションがオンのときだけ、濃い色の文字（紺色など）を、色合いはそのままで明るくする。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** 0〜360 */
  h: number;
  /** 0〜1 */
  s: number;
  /** 0〜1 */
  l: number;
}

/** RGBの最大と最小の差がこの値以下なら、無彩色（白・黒・灰色）とみなす（0〜255） */
export const NEUTRAL_CHROMA_MAX = 20;
/** 明るさがこの値以上／以下の色は、色味があっても明るさを反転する（淡い色・ほぼ黒の色） */
export const VERY_LIGHT_L = 0.85;
export const VERY_DARK_L = 0.15;
/** 「文字を明るくする」オプションで、明るさがこの値より低い色（濃い色）の文字を明るくする／明るくしたあとの明るさ */
export const DARK_TEXT_L = 0.35;
export const BRIGHTENED_TEXT_L = 0.7;

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

export function parseHex(value: string | undefined | null): Rgb | null {
  if (!value) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex(c: Rgb): string {
  return [c.r, c.g, c.b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function chromaOf(c: Rgb): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

export function rgbToHsl(c: Rgb): Hsl {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb(c: Hsl): Rgb {
  const { h, s, l } = c;
  if (s === 0) {
    const v = clamp255(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: clamp255(f(hk + 1 / 3) * 255), g: clamp255(f(hk) * 255), b: clamp255(f(hk - 1 / 3) * 255) };
}

/**
 * 色を反転する。反転しない色（はっきりした色）は null を返す。
 *   無彩色: 各チャンネルを 255 から引く（白→黒、#D9D9D9→#262626、#808080→#7F7F7F）
 *   ごく明るい／ごく暗い色: 色相と彩度は変えず、明るさ（HSLのL）だけを 1 から引く
 */
export function invertDocumentColor(c: Rgb): Rgb | null {
  if (chromaOf(c) <= NEUTRAL_CHROMA_MAX) return { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b };
  const hsl = rgbToHsl(c);
  if (hsl.l >= VERY_LIGHT_L || hsl.l <= VERY_DARK_L) return hslToRgb({ h: hsl.h, s: hsl.s, l: 1 - hsl.l });
  return null;
}

/** 濃い色の文字を、色合いはそのままで明るくする（「文字を明るくする」オプション用）。明るくする必要がなければ null */
export function brightenDarkTextColor(c: Rgb): Rgb | null {
  const hsl = rgbToHsl(c);
  if (hsl.l >= DARK_TEXT_L) return null;
  return hslToRgb({ h: hsl.h, s: hsl.s, l: BRIGHTENED_TEXT_L });
}

/** DrawingMLの色の変形（lumMod など）を、順に適用する。値は 1/1000 パーセント（100000 = 100%） */
export interface ColorModifier {
  name: string;
  val: number;
}

export function applyColorModifiers(base: Rgb, mods: readonly ColorModifier[]): Rgb {
  let c = base;
  for (const m of mods) {
    const k = m.val / 100000;
    switch (m.name) {
      case "lumMod": {
        const hsl = rgbToHsl(c);
        c = hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, hsl.l * k)) });
        break;
      }
      case "lumOff": {
        const hsl = rgbToHsl(c);
        c = hslToRgb({ ...hsl, l: Math.min(1, Math.max(0, hsl.l + k)) });
        break;
      }
      case "satMod": {
        const hsl = rgbToHsl(c);
        c = hslToRgb({ ...hsl, s: Math.min(1, Math.max(0, hsl.s * k)) });
        break;
      }
      case "satOff": {
        const hsl = rgbToHsl(c);
        c = hslToRgb({ ...hsl, s: Math.min(1, Math.max(0, hsl.s + k)) });
        break;
      }
      case "tint":
        // 白に近づける（k=1 で元の色、k=0 で白）
        c = { r: clamp255(c.r * k + 255 * (1 - k)), g: clamp255(c.g * k + 255 * (1 - k)), b: clamp255(c.b * k + 255 * (1 - k)) };
        break;
      case "shade":
        // 黒に近づける（k=1 で元の色、k=0 で黒）
        c = { r: clamp255(c.r * k), g: clamp255(c.g * k), b: clamp255(c.b * k) };
        break;
      default:
        break;
    }
  }
  return c;
}

/** 色の変形のうち、上の applyColorModifiers が値に反映するもの（反映したものは、出力では書かない） */
export const APPLIED_MODIFIERS = new Set(["lumMod", "lumOff", "satMod", "satOff", "tint", "shade"]);

/** 色名（prstClr）のうち、無彩色のもの */
export const NEUTRAL_PRESET_COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  gray: "808080",
  grey: "808080",
  dkGray: "A9A9A9",
  dkGrey: "A9A9A9",
  darkGray: "A9A9A9",
  darkGrey: "A9A9A9",
  ltGray: "D3D3D3",
  ltGrey: "D3D3D3",
  lightGray: "D3D3D3",
  lightGrey: "D3D3D3",
  silver: "C0C0C0",
  dimGray: "696969",
  dimGrey: "696969",
  gainsboro: "DCDCDC",
  whiteSmoke: "F5F5F5",
};
