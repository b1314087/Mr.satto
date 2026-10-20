/**
 * PowerPointのXML（DrawingML）の色を、白黒反転する（Mr.Satto「PowerPoint白黒反転」）。
 *
 * すべてブラウザの中（文字列の置き換え）で行い、新しいライブラリは使わない。
 * 色の決まりは color.ts。ここでは次の2つを行う。
 *
 *   1. 明示された色（<a:srgbClr> <a:sysClr> <a:schemeClr> <a:prstClr>）を、色の変形（lumMod など）まで含めた
 *      最終の色にしたうえで、反転するものは <a:srgbClr val="…"> に書き換える。反転しない色（赤・青など）は、
 *      元の指定（テーマの色への参照・変形）をそのまま残す。
 *   2. スライドマスターの色の対応表（<p:clrMap>）の背景1/文字1/背景2/文字2を入れ替える。色を指定していない文字や
 *      背景・グラフの既定の文字色が、白黒反転する（黒背景・白文字になる）。
 *
 * 次のものは、色を書き換えない。
 *   - 影（outerShdw / innerShdw / prstShdw）: 黒い影を白くすると、光って見えてしまうため
 *   - 図形の標準スタイルの文字色（fontRef）が白（lt1/bg1）のとき: 色つきの図形の上の白い文字のため
 */
import {
  APPLIED_MODIFIERS,
  NEUTRAL_PRESET_COLORS,
  applyColorModifiers,
  brightenDarkTextColor,
  chromaOf,
  invertDocumentColor,
  parseHex,
  rgbToHsl,
  toHex,
  type ColorModifier,
  type Palette,
  type Rgb,
} from "./color";

export type ThemeColors = Record<string, string>;
export type ClrMapKey = "bg1" | "tx1" | "bg2" | "tx2";
export type ClrMap = Record<ClrMapKey, string>;

export const DEFAULT_CLR_MAP: ClrMap = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
const CLR_MAP_KEYS: ClrMapKey[] = ["bg1", "tx1", "bg2", "tx2"];
const THEME_COLOR_NAMES = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

export interface ColorContext {
  theme: ThemeColors;
  clrMap: ClrMap;
}

export interface InvertOptions {
  /** 濃い色（紺色など）の文字を、色合いはそのままで明るくする。既定はオフ（色は変えない） */
  brightenDarkText: boolean;
  /**
   * 反転後の配色（背景色・文字色）。省略、または純黒×純白のときは、従来の白黒反転。
   * 指定すると、反転した色（白→背景色、黒→文字色、灰色はその間）をこの配色に写す。
   */
  palette?: Palette | null;
}

export interface ColorStats {
  /** 反転して書き換えた色の数 */
  inverted: number;
  /** はっきりした色のため、そのまま残した色の数 */
  kept: number;
  /** 「文字を明るくする」で明るくした色の数 */
  brightened: number;
  /** 色の指定を読み取れず、そのまま残した色の数（テーマにない色名など） */
  unresolved: number;
}

export const emptyColorStats = (): ColorStats => ({ inverted: 0, kept: 0, brightened: 0, unresolved: 0 });

const attrOf = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** テーマ（theme1.xml）の色の一覧 */
export function parseThemeColors(xml: string): ThemeColors {
  const out: ThemeColors = {};
  for (const name of THEME_COLOR_NAMES) {
    const m = new RegExp(`<a:${name}>\\s*<a:(srgbClr|sysClr)\\b([^>]*?)\\/?>`).exec(xml);
    if (!m) continue;
    const hex = m[1] === "srgbClr" ? attrOf(m[2], "val") : (attrOf(m[2], "lastClr") ?? (attrOf(m[2], "val") === "window" ? "FFFFFF" : attrOf(m[2], "val") === "windowText" ? "000000" : undefined));
    const rgb = parseHex(hex);
    if (rgb) out[name] = toHex(rgb);
  }
  return out;
}

const CLR_MAP_TAG = /<(p:clrMap|a:overrideClrMapping)\b([^>]*?)\/?>/;

/** スライドマスターの色の対応表、またはスライド・レイアウトの上書きの対応表。なければ null */
export function parseClrMap(xml: string): ClrMap | null {
  const m = CLR_MAP_TAG.exec(xml);
  if (!m) return null;
  const map: ClrMap = { ...DEFAULT_CLR_MAP };
  for (const key of CLR_MAP_KEYS) {
    const v = attrOf(m[2], key);
    if (v) map[key] = v;
  }
  return map;
}

const FLIP: Record<string, string> = { lt1: "dk1", dk1: "lt1", lt2: "dk2", dk2: "lt2" };

/** 色の対応表の、背景1/文字1/背景2/文字2を入れ替える（明るい色↔暗い色）。入れ替えた数も返す */
export function swapClrMap(xml: string): { xml: string; swapped: number } {
  let swapped = 0;
  const out = xml.replace(/<(p:clrMap|a:overrideClrMapping)\b([^>]*?)(\/?)>/g, (whole, tag: string, attrs: string, close: string) => {
    const next = attrs.replace(/\b(bg1|tx1|bg2|tx2)="(lt1|dk1|lt2|dk2)"/g, (_m, key: string, value: string) => {
      swapped++;
      return `${key}="${FLIP[value]}"`;
    });
    return `<${tag}${next}${close}>`;
  });
  return { xml: out, swapped };
}

function resolveBase(tag: string, attrs: string, ctx: ColorContext): Rgb | null {
  if (tag === "srgbClr") return parseHex(attrOf(attrs, "val"));
  if (tag === "sysClr") {
    const last = parseHex(attrOf(attrs, "lastClr"));
    if (last) return last;
    const v = attrOf(attrs, "val");
    if (v === "window") return { r: 255, g: 255, b: 255 };
    if (v === "windowText") return { r: 0, g: 0, b: 0 };
    return null;
  }
  if (tag === "prstClr") return parseHex(NEUTRAL_PRESET_COLORS[attrOf(attrs, "val") ?? ""]);
  if (tag === "schemeClr") {
    const val = attrOf(attrs, "val");
    if (!val) return null;
    const name = (CLR_MAP_KEYS as string[]).includes(val) ? ctx.clrMap[val as ClrMapKey] : val;
    return parseHex(ctx.theme[name]);
  }
  return null;
}

interface ChildToken {
  name: string;
  raw: string;
  val: number | null;
}

function childTokens(inner: string): ChildToken[] {
  const out: ChildToken[] = [];
  for (const m of inner.matchAll(/<a:(\w+)\b([^>]*?)\/>/g)) {
    const v = attrOf(m[2], "val");
    out.push({ name: m[1], raw: m[0], val: v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null });
  }
  return out;
}

interface Mode {
  /** 文字の書式（rPr / defRPr / endParaRPr）の中の色 */
  text: boolean;
  /** 図形の標準スタイルの文字色（fontRef）の中の色 */
  fontRef: boolean;
}

function convertColor(whole: string, tag: string, attrs: string, inner: string, mode: Mode, ctx: ColorContext, options: InvertOptions, stats: ColorStats): string {
  const base = resolveBase(tag, attrs, ctx);
  if (!base) {
    stats.unresolved++;
    return whole;
  }
  const tokens = childTokens(inner);
  const mods: ColorModifier[] = tokens.filter((t) => APPLIED_MODIFIERS.has(t.name) && t.val !== null).map((t) => ({ name: t.name, val: t.val as number }));
  const final = applyColorModifiers(base, mods);
  const rest = tokens.filter((t) => !(APPLIED_MODIFIERS.has(t.name) && t.val !== null)).map((t) => t.raw).join("");
  const emit = (c: Rgb) => (rest ? `<a:srgbClr val="${toHex(c)}">${rest}</a:srgbClr>` : `<a:srgbClr val="${toHex(c)}"/>`);

  // 色つきの図形の上の白い文字（標準スタイルの文字色）は、そのまま残す
  const keepWhiteFontRef = mode.fontRef && chromaOf(final) <= 20 && rgbToHsl(final).l > 0.85;
  const inverted = keepWhiteFontRef ? null : invertDocumentColor(final, options.palette);
  if (inverted) {
    stats.inverted++;
    return emit(inverted);
  }

  if (options.brightenDarkText && mode.text) {
    const bright = brightenDarkTextColor(final);
    if (bright) {
      stats.brightened++;
      return emit(bright);
    }
  }

  stats.kept++;
  if (tag === "schemeClr") {
    const val = attrOf(attrs, "val");
    // 色の対応表（clrMap）を入れ替えるため、背景1/文字1などを指す色は、元の対応先（lt1/dk1…）に固定して、色が変わらないようにする
    if (val && (CLR_MAP_KEYS as string[]).includes(val)) return whole.replace(`val="${val}"`, `val="${ctx.clrMap[val as ClrMapKey]}"`);
  }
  return whole;
}

const COLOR_ELEMENT = String.raw`<a:(srgbClr|sysClr|schemeClr|prstClr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)`;
const SHADOW = String.raw`<a:(?:outerShdw|innerShdw|prstShdw)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:(?:outerShdw|innerShdw|prstShdw)>)`;

/** 色の要素だけを書き換える（影は除く）。mode は文字の書式の中かどうか */
function convertSegment(xml: string, mode: Mode, ctx: ColorContext, options: InvertOptions, stats: ColorStats): string {
  const re = new RegExp(`(${SHADOW})|${COLOR_ELEMENT.replace("\\1", "\\2")}`, "g");
  return xml.replace(re, (whole: string, shadow: string | undefined, tag: string | undefined, attrs: string, inner: string | undefined) => {
    if (shadow !== undefined || !tag) return whole;
    return convertColor(whole, tag, attrs, inner ?? "", mode, ctx, options, stats);
  });
}

const TEXT_PROPS = String.raw`<a:(rPr|defRPr|endParaRPr)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\2>)`;
const FONT_REF = String.raw`<a:fontRef\b[^>]*?(?:\/>|>[\s\S]*?<\/a:fontRef>)`;

/**
 * XML全体の色を書き換える。
 * 影・標準スタイルの文字色・文字の書式は、それぞれの決まりで処理し、それ以外の色の要素は通常の決まりで処理する。
 */
export function convertColorsInXml(xml: string, ctx: ColorContext, options: InvertOptions, stats: ColorStats = emptyColorStats()): string {
  const top = new RegExp(`(${SHADOW})|(${FONT_REF})|(${TEXT_PROPS.replace("\\2", "\\4")})|${COLOR_ELEMENT.replace("\\1", "\\5")}`, "g");
  return xml.replace(
    top,
    (whole: string, shadow: string | undefined, fontRef: string | undefined, textProps: string | undefined, _tp: string | undefined, tag: string | undefined, attrs: string, inner: string | undefined) => {
      if (shadow !== undefined) return whole;
      if (fontRef !== undefined) return convertSegment(whole, { text: false, fontRef: true }, ctx, options, stats);
      if (textProps !== undefined) return convertSegment(whole, { text: true, fontRef: false }, ctx, options, stats);
      if (!tag) return whole;
      return convertColor(whole, tag, attrs, inner ?? "", { text: false, fontRef: false }, ctx, options, stats);
    },
  );
}
