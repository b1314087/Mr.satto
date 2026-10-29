/**
 * .pptx ファイルの白黒反転（Mr.Satto「PowerPoint白黒反転」）。
 *
 * .pptx は、XMLと画像を ZIP にまとめたもの。ZIP（fflate）を開き、スライド・レイアウト・マスターなどのXMLの色と、
 * 挿入された画像（PNG・JPEG）を書き換えて、ZIPに戻す。スライドを画像にして作り直すことはしないので、
 * 変換後も、文字・図形・表・グラフはPowerPointで編集できる。すべてブラウザの中で処理し、何も送信しない。
 *
 * 元のファイルは変更しない（読み込んだデータのコピーを書き換える）。
 */
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from "fflate";
import { emptyColorStats, parseClrMap, parseThemeColors, swapClrMap, convertColorsInXml, DEFAULT_CLR_MAP, type ClrMap, type ColorContext, type ColorStats, type InvertOptions } from "./invert-xml";
import { resolvePalette, DEFAULT_COLOR_CHOICE, type ColorChoice } from "./palette";
import { analyzeImage, createBrowserImageCodec, invertImagePixels, shouldEnhance, sniffRasterKind, type ImageCodec, type ImageDecision } from "./image-invert";

export interface PptxInvertOptions extends InvertOptions {
  /** 白黒と判定できる挿入画像を反転する（既定はオン） */
  invertImages: boolean;
  /**
   * 文書のような（白地・黒地が中心の）画像の文字を、反転後に見やすくする（背景のにじみを消し、細い線の明るさを上げ、線を少し太らせる）。
   * 既定はオフ（従来と同じ単純な反転）。画面からはオンにして渡す。
   */
  enhanceText?: boolean;
  /**
   * 反転後の背景色・文字色（6桁の16進）。省略、または純黒×純白のときは、従来の白黒反転と同じ結果になる。
   * （InvertOptions の palette は処理の内部用。ここでは、画面から渡しやすい16進の指定を使う）
   */
  colors?: ColorChoice;
}

export const DEFAULT_PPTX_INVERT_OPTIONS: PptxInvertOptions = { invertImages: true, brightenDarkText: false, colors: DEFAULT_COLOR_CHOICE };

/** 処理できるファイルの大きさの上限 */
export const PPTX_MAX_BYTES = 150 * 1024 * 1024;
/** ZIPを展開したあとの大きさの上限（ZIP爆弾を避ける） */
export const PPTX_MAX_UNPACKED_BYTES = 800 * 1024 * 1024;
export const PPTX_MAX_ENTRIES = 20000;

export type ImageOutcome =
  /** 白黒と判定し、全体を反転した */
  | "inverted"
  /** 白黒が中心の画像として、白黒の画素だけを反転した（色のついた画素は残した） */
  | "inverted-gray"
  /** カラーの画像と判定し、変更しなかった */
  | "kept-color"
  /** 透明な画像で、変更しなかった */
  | "kept-transparent"
  /** この形式（GIF・SVG・EMFなど）は反転できないため、変更しなかった */
  | "unsupported"
  /** 大きすぎるため、変更しなかった */
  | "too-large"
  /** 読み込めなかったため、変更しなかった */
  | "failed"
  /** 画像の反転をオフにしているため、変更しなかった */
  | "skipped-option";

export interface ImageReport {
  /** パッケージ内のパス（例: ppt/media/image1.png） */
  path: string;
  outcome: ImageOutcome;
  width?: number;
  height?: number;
  /** 色のついた画素の割合（0〜1） */
  coloredRatio?: number;
  /** 文字を見やすくする調整をした */
  enhanced?: boolean;
  /** 画面で変換前後を並べて見せるための、元の画像と変換後の画像のバイト列（PNG・JPEGだけ） */
  mime?: string;
  before?: Uint8Array;
  after?: Uint8Array;
}

export interface PptxInvertReport {
  slideCount: number;
  /** 色を書き換えたXMLの部品の数 */
  partsConverted: number;
  colors: ColorStats;
  /** 色の対応表（背景・文字の既定の色）を入れ替えた箇所の数 */
  colorMapsSwapped: number;
  images: ImageReport[];
  /** 影響があること・変更しなかったものの説明（画面に表示する） */
  notes: string[];
  /** 適用した配色（背景色・文字色。6桁の16進）。指定がない、または正しくないときは、純黒×純白 */
  colorChoice: ColorChoice;
}

export interface PptxInvertResult {
  bytes: Uint8Array;
  report: PptxInvertReport;
}

export class PptxInvertError extends Error {}

const COMPRESSED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "mp4", "m4v", "mov", "mp3", "m4a", "wmv", "wma", "avi", "webp", "zip", "pptx", "xlsx", "docx", "heic"]);
const extensionOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

const COLOR_PART_PATTERNS = [
  /^ppt\/slides\/[^/]+\.xml$/,
  /^ppt\/slideLayouts\/[^/]+\.xml$/,
  /^ppt\/slideMasters\/[^/]+\.xml$/,
  /^ppt\/tableStyles\.xml$/,
  /^ppt\/presentation\.xml$/,
  /^ppt\/charts\/[^/]+\.xml$/,
  /^ppt\/diagrams\/[^/]+\.xml$/,
  /^ppt\/drawings\/[^/]+\.xml$/,
];
const isColorPart = (name: string) => COLOR_PART_PATTERNS.some((re) => re.test(name));

/** 画像を探すときに、使い道（参照元）として数える部品 */
const IMAGE_USER_PATTERNS = COLOR_PART_PATTERNS;

const SLIDE_RE = /^ppt\/slides\/[^/]+\.xml$/;
const LAYOUT_RE = /^ppt\/slideLayouts\/[^/]+\.xml$/;
const MASTER_RE = /^ppt\/slideMasters\/[^/]+\.xml$/;

interface Relationship {
  type: string;
  target: string;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = [...(dirOf(sourcePart) ? dirOf(sourcePart).split("/") : []), ...target.split("/")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** 「ppt/slides/_rels/slide1.xml.rels」→「ppt/slides/slide1.xml」 */
function sourceOfRels(relsPath: string): string | null {
  const m = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (m) return `${m[1]}/${m[2]}`;
  const top = /^_rels\/([^/]+)\.rels$/.exec(relsPath);
  return top ? top[1] : null;
}

function parseRels(relsPath: string, xml: string): { source: string; rels: Relationship[] } | null {
  const source = sourceOfRels(relsPath);
  if (source === null) return null;
  const rels: Relationship[] = [];
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    if (/TargetMode="External"/i.test(attrs)) continue;
    const type = /\bType="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    if (target) rels.push({ type, target: resolveTarget(source, target) });
  }
  return { source, rels };
}

const typeEnds = (r: Relationship, suffix: string) => r.type.endsWith(`/${suffix}`);

export function decodeXmlBytes(bytes: Uint8Array): string | null {
  // UTF-16 のXMLは、この処理では扱わない（PowerPointのXMLはUTF-8）
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return null;
  return strFromU8(bytes);
}

export interface InvertProgress {
  stage: "unzip" | "colors" | "images" | "zip";
  done: number;
  total: number;
}

export async function invertPptx(
  input: Uint8Array,
  options: PptxInvertOptions = DEFAULT_PPTX_INVERT_OPTIONS,
  codec?: ImageCodec,
  onProgress?: (p: InvertProgress) => void,
): Promise<PptxInvertResult> {
  if (input.length === 0) throw new PptxInvertError("ファイルが空です。");
  if (input.length > PPTX_MAX_BYTES) throw new PptxInvertError(`ファイルが大きすぎます（${Math.floor(PPTX_MAX_BYTES / 1024 / 1024)}MBまで）。`);
  const isZip = input[0] === 0x50 && input[1] === 0x4b;
  if (!isZip) {
    const isOle = input[0] === 0xd0 && input[1] === 0xcf && input[2] === 0x11 && input[3] === 0xe0;
    throw new PptxInvertError(
      isOle
        ? "パスワードで保護されているか、古い形式（.ppt）のファイルです。パスワードを解除するか、.pptx 形式で保存し直してから、もう一度お試しください。"
        : "PowerPointファイル（.pptx）として読み込めませんでした。ファイルが壊れているか、別の形式のファイルです。",
    );
  }

  onProgress?.({ stage: "unzip", done: 0, total: 1 });
  let files: Record<string, Uint8Array>;
  try {
    let entries = 0;
    let unpacked = 0;
    files = unzipSync(input, {
      filter(file) {
        entries++;
        unpacked += file.originalSize;
        if (entries > PPTX_MAX_ENTRIES || unpacked > PPTX_MAX_UNPACKED_BYTES) throw new PptxInvertError("ファイルの内容が大きすぎるため、処理できません。");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof PptxInvertError) throw e;
    throw new PptxInvertError("PowerPointファイル（.pptx）として読み込めませんでした。ファイルが壊れている可能性があります。");
  }
  if (!files["[Content_Types].xml"] || !files["ppt/presentation.xml"]) {
    throw new PptxInvertError("PowerPointファイル（.pptx）ではないようです。（ppt/presentation.xml が見つかりません）");
  }
  onProgress?.({ stage: "unzip", done: 1, total: 1 });

  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const text = new Map<string, string>();
  const readText = (name: string): string | null => {
    if (text.has(name)) return text.get(name) ?? null;
    const bytes = files[name];
    if (!bytes) return null;
    const s = decodeXmlBytes(bytes);
    if (s !== null) text.set(name, s);
    return s;
  };

  // --- 部品どうしの参照（スライド→レイアウト→マスター→テーマ、部品→画像など） ---
  const relsOf = new Map<string, Relationship[]>();
  const referencedBy = new Map<string, string[]>();
  for (const name of names) {
    if (!name.endsWith(".rels")) continue;
    const xml = readText(name);
    if (xml === null) continue;
    const parsed = parseRels(name, xml);
    if (!parsed) continue;
    relsOf.set(parsed.source, parsed.rels);
    for (const r of parsed.rels) {
      const list = referencedBy.get(r.target) ?? [];
      list.push(parsed.source);
      referencedBy.set(r.target, list);
    }
  }
  const targetOf = (source: string, suffix: string): string | undefined => relsOf.get(source)?.find((r) => typeEnds(r, suffix))?.target;

  // --- 反転後の配色（既定の純黒×純白のときは palette が null で、従来の単純な白黒反転） ---
  const resolved = resolvePalette(options.colors);
  const palette = resolved.palette;
  const convertOptions = { brightenDarkText: options.brightenDarkText, palette };

  // --- マスターごとの、テーマの色と色の対応表（元のもの） ---
  const masters = names.filter((n) => MASTER_RE.test(n)).sort();
  const masterCtx = new Map<string, ColorContext>();
  for (const m of masters) {
    const xml = readText(m) ?? "";
    const themePath = targetOf(m, "theme");
    const theme = themePath ? parseThemeColors(readText(themePath) ?? "") : {};
    masterCtx.set(m, { theme, clrMap: parseClrMap(xml) ?? { ...DEFAULT_CLR_MAP } });
  }
  const fallbackCtx: ColorContext = masterCtx.get(masters[0]) ?? { theme: {}, clrMap: { ...DEFAULT_CLR_MAP } };

  /** 部品が属するマスター（スライド→レイアウト→マスター。グラフなどは、それを使うスライドをたどる） */
  const masterOf = (part: string, seen = new Set<string>()): string | null => {
    if (seen.has(part)) return null;
    seen.add(part);
    if (MASTER_RE.test(part)) return part;
    if (SLIDE_RE.test(part)) {
      const layout = targetOf(part, "slideLayout");
      return layout ? masterOf(layout, seen) : null;
    }
    if (LAYOUT_RE.test(part)) return targetOf(part, "slideMaster") ?? null;
    for (const user of referencedBy.get(part) ?? []) {
      const m = masterOf(user, seen);
      if (m) return m;
    }
    return null;
  };

  /** 部品に使う色の情報（スライド・レイアウトの色の対応表の上書きも反映する） */
  const contextOf = (part: string): ColorContext => {
    const master = masterOf(part);
    const base = (master ? masterCtx.get(master) : undefined) ?? fallbackCtx;
    let clrMap: ClrMap = base.clrMap;
    const chain: string[] = [];
    if (SLIDE_RE.test(part)) {
      chain.push(part);
      const layout = targetOf(part, "slideLayout");
      if (layout) chain.push(layout);
    } else if (LAYOUT_RE.test(part)) {
      chain.push(part);
    }
    for (const p of chain) {
      const xml = readText(p);
      const override = xml && /<a:overrideClrMapping\b/.test(xml) ? parseClrMap(xml) : null;
      if (override) {
        clrMap = override;
        break;
      }
    }
    return { theme: base.theme, clrMap };
  };

  // --- XMLの色を書き換える ---
  const stats = emptyColorStats();
  let partsConverted = 0;
  let colorMapsSwapped = 0;
  const out: Record<string, Uint8Array> = { ...files };
  const colorParts = names.filter(isColorPart);
  colorParts.forEach((name, i) => {
    const xml = readText(name);
    if (xml === null) return;
    const ctx = contextOf(name);
    let next = convertColorsInXml(xml, ctx, convertOptions, stats);
    const swapped = swapClrMap(next);
    next = swapped.xml;
    colorMapsSwapped += swapped.swapped;
    if (next !== xml) {
      out[name] = strToU8(next);
      partsConverted++;
    }
    onProgress?.({ stage: "colors", done: i + 1, total: colorParts.length });
  });

  // --- 挿入画像 ---
  const images: ImageReport[] = [];
  const mediaNames = names.filter((n) => /^ppt\/media\//i.test(n));
  const rasterExt = new Set(["png", "jpg", "jpeg"]);
  const nonRasterImageExt = new Set(["gif", "bmp", "tif", "tiff", "webp", "svg", "emf", "wmf", "wdp", "jxr", "heic", "avif", "pict"]);
  const usedBySlideParts = (media: string) => (referencedBy.get(media) ?? []).some((src) => IMAGE_USER_PATTERNS.some((re) => re.test(src)));
  const activeCodec = codec ?? (typeof document !== "undefined" ? createBrowserImageCodec() : undefined);
  let imageNotesOnly = 0;
  let imageDone = 0;
  for (const name of mediaNames) {
    const ext = extensionOf(name);
    const isRaster = rasterExt.has(ext);
    if (!isRaster && !nonRasterImageExt.has(ext)) continue; // 音声・動画など（画像ではない）
    // 発表者ノートだけで使われている画像・どこからも使われていない画像は、変更しない
    if (!usedBySlideParts(name)) {
      imageNotesOnly++;
      continue;
    }
    if (!isRaster) {
      images.push({ path: name, outcome: "unsupported" });
      continue;
    }
    const original = files[name];
    const kind = sniffRasterKind(original);
    if (!kind) {
      images.push({ path: name, outcome: "unsupported" });
      continue;
    }
    if (!options.invertImages) {
      images.push({ path: name, outcome: "skipped-option" });
      continue;
    }
    const mime = kind === "png" ? "image/png" : "image/jpeg";
    if (!activeCodec) {
      images.push({ path: name, outcome: "failed", mime });
      continue;
    }
    try {
      const raster = await activeCodec.decode(original, kind);
      const analysis = analyzeImage(raster.data, raster.width, raster.height);
      const base: ImageReport = { path: name, outcome: "kept-color", width: raster.width, height: raster.height, coloredRatio: analysis.coloredRatio, mime };
      const decision: ImageDecision = analysis.decision;
      if (decision === "keep-transparent") {
        images.push({ ...base, outcome: "kept-transparent", before: original });
      } else if (decision === "keep-color") {
        images.push({ ...base, outcome: "kept-color", before: original });
      } else {
        const enhance = options.enhanceText === true && shouldEnhance(analysis);
        invertImagePixels(raster.data, decision, palette, enhance ? { width: raster.width, height: raster.height } : undefined);
        // 文字を見やすくする調整をしたJPEGは、圧縮の乱れ（文字のまわりの縁）が目立たないよう、画質を高くして保存する
        const encoded = await activeCodec.encode(raster, kind, enhance ? 0.98 : undefined);
        out[name] = encoded;
        images.push({ ...base, outcome: decision === "invert-all" ? "inverted" : "inverted-gray", enhanced: enhance, before: original, after: encoded });
      }
    } catch (e) {
      images.push({ path: name, outcome: e instanceof Error && e.message === "too-large" ? "too-large" : "failed", mime });
    }
    imageDone++;
    onProgress?.({ stage: "images", done: imageDone, total: mediaNames.length });
  }

  // --- 影響の説明 ---
  const slideCount = names.filter((n) => SLIDE_RE.test(n)).length;
  const notes: string[] = [];
  if (resolved.invalid) notes.push("背景色・文字色の指定を読み取れなかったため、純黒×純白で変換しました。");
  if (palette) {
    notes.push(
      "配色を指定した場合、元の白系の色は背景色、黒系の色は文字色に、灰色はその間の色になります。色の指定のない既定の文字・背景（テーマの標準の黒・白）と、色つきの図形の上の白い文字は、純黒・純白のまま表示されることがあります。",
    );
  }
  const count = (re: RegExp) => names.filter((n) => re.test(n)).length;
  const notesSlides = count(/^ppt\/notesSlides\/[^/]+\.xml$/);
  if (notesSlides > 0) notes.push(`発表者ノート（${notesSlides}件）は、変更していません。`);
  const withTiming = names.filter((n) => SLIDE_RE.test(n) && /<p:timing\b/.test(readText(n) ?? "")).length;
  if (withTiming > 0) notes.push(`アニメーションのあるスライドが${withTiming}枚あります。動きの設定は変えていませんが、アニメーションで色を変える設定は、白黒の色だけ反転しています。`);
  const charts = count(/^ppt\/charts\/chart[^/]*\.xml$/);
  if (charts > 0) notes.push(`グラフ（${charts}件）は、文字・枠線・背景の白黒を反転しています。データ系列の色（カラー）は、そのままです。`);
  const smartArt = count(/^ppt\/diagrams\/data[^/]*\.xml$/);
  if (smartArt > 0) notes.push(`SmartArt（${smartArt}件）は、白黒の色を反転しています。`);
  const media = names.filter((n) => /^ppt\/media\//i.test(n) && /\.(mp4|m4v|mov|wmv|avi|mp3|m4a|wav|wma)$/i.test(n)).length;
  if (media > 0) notes.push(`動画・音声（${media}件）は、変更していません。`);
  const embeddings = count(/^ppt\/embeddings\//);
  if (embeddings > 0) notes.push(`埋め込まれたExcelなどのオブジェクト（${embeddings}件）の中身は、変更していません。表示用の画像がある場合、その画像は反転していません。`);
  const unsupported = images.filter((i) => i.outcome === "unsupported").length;
  if (unsupported > 0) notes.push(`GIF・SVG・EMF・WMFなどの画像（${unsupported}件）は、反転できないため変更していません。`);
  const failed = images.filter((i) => i.outcome === "failed" || i.outcome === "too-large").length;
  if (failed > 0) notes.push(`読み込めない、または大きすぎる画像（${failed}件）は、変更していません。`);
  if (imageNotesOnly > 0) notes.push(`発表者ノートだけで使われている画像（${imageNotesOnly}件）は、変更していません。`);
  if (names.some((n) => n.startsWith("_xmlsignatures/"))) notes.push("元のファイルにデジタル署名があります。内容を変更したため、署名は無効になります。");
  if (names.some((n) => /^docProps\/thumbnail\.(jpe?g|png|emf|wmf)$/i.test(n))) notes.push("ファイルのプレビュー用の小さな画像（サムネイル）は、元のままです。PowerPointで開いて保存し直すと、更新されます。");
  if (names.some((n) => /^ppt\/theme\/theme\d*\.xml$/.test(n))) notes.push("テーマの色（アクセント色など）と、ハイパーリンクの色は、変更していません。");

  // --- ZIPに戻す ---
  onProgress?.({ stage: "zip", done: 0, total: 1 });
  const zippable: Zippable = {};
  for (const name of Object.keys(out)) {
    if (name.endsWith("/")) continue;
    zippable[name] = [out[name], { level: COMPRESSED_EXTENSIONS.has(extensionOf(name)) ? 0 : 6 }];
  }
  const bytes = zipSync(zippable);
  onProgress?.({ stage: "zip", done: 1, total: 1 });

  return {
    bytes,
    report: { slideCount, partsConverted, colors: stats, colorMapsSwapped, images, notes, colorChoice: resolved.choice },
  };
}
