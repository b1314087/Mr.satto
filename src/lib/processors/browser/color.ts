import { BrowserProcessor } from "../types";

export interface ColorPaletteInput {
  baseColorHex: string;
  mode: "complementary" | "analogous" | "triadic" | "monochromatic";
}

export interface ColorPaletteOutput {
  colors: string[];
}

function hexToHsl(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.substring(0, 2), 16) / 255;
  const g = parseInt(normalized.substring(2, 4), 16) / 255;
  const b = parseInt(normalized.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }

  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/;

export class ColorPaletteProcessor extends BrowserProcessor<
  ColorPaletteInput,
  ColorPaletteOutput
> {
  async process({ baseColorHex, mode }: ColorPaletteInput) {
    if (!HEX_PATTERN.test(baseColorHex)) {
      throw new Error("カラーコードは #RRGGBB の形式で入力してください");
    }
    const hex = baseColorHex.startsWith("#") ? baseColorHex : `#${baseColorHex}`;
    const [h, s, l] = hexToHsl(hex);

    switch (mode) {
      case "complementary":
        return { colors: [hex, hslToHex(h + 180, s, l)] };
      case "triadic":
        return { colors: [hex, hslToHex(h + 120, s, l), hslToHex(h + 240, s, l)] };
      case "analogous":
        return {
          colors: [
            hslToHex(h - 30, s, l),
            hex,
            hslToHex(h + 30, s, l),
          ],
        };
      case "monochromatic":
      default:
        return {
          colors: [
            hslToHex(h, s, Math.min(l + 30, 95)),
            hslToHex(h, s, Math.min(l + 15, 90)),
            hex,
            hslToHex(h, s, Math.max(l - 15, 10)),
            hslToHex(h, s, Math.max(l - 30, 5)),
          ],
        };
    }
  }
}
