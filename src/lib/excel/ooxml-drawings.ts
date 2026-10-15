import type { SheetPicture, SheetShape } from "@/lib/excel/ooxml-page-settings";

/**
 * シートに貼られた図・画像・図形(xl/drawings/drawingN.xml)の読み取り。
 *
 * 対応するもの: 画像(PNG・JPEG。GIF・BMP等は描画側でブラウザの機能でPNGへ変換する)、
 * 単純な図形(四角形・角丸四角形・楕円・直線)と、その中の文字。
 * 対応しないもの(グラフ・SmartArt・グループ化された図形・EMF/WMF画像・ワードアート等)は、
 * 数だけ数えて呼び出し側が「再現できない」と警告する。
 */

const EMU_PER_PT = 12700;

function parseXml(text: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}

function entryText(entries: Record<string, Uint8Array>, path: string): string | null {
  const data = entries[path];
  if (!data) return null;
  try {
    return new TextDecoder("utf-8").decode(data);
  } catch {
    return null;
  }
}

/** 名前空間の接頭辞(xdr:・a:等)に依存せず、ローカル名で子要素を探す */
function child(el: Element | null | undefined, local: string): Element | undefined {
  if (!el) return undefined;
  return Array.from(el.children).find((c) => c.localName === local);
}
function children(el: Element | null | undefined, local: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.localName === local);
}
function descendant(el: Element | null | undefined, local: string): Element | undefined {
  if (!el) return undefined;
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) if (all[i].localName === local) return all[i];
  return undefined;
}

/** テーマの色名(a:schemeClr@val)→ 色。themeColorsはstyles.xmlと同じ並び(0=lt1,1=dk1,2=lt2,3=dk2,4〜9=accent1〜6) */
const SCHEME_INDEX: Record<string, number> = {
  lt1: 0,
  bg1: 0,
  dk1: 1,
  tx1: 1,
  lt2: 2,
  bg2: 2,
  dk2: 3,
  tx2: 3,
  accent1: 4,
  accent2: 5,
  accent3: 6,
  accent4: 7,
  accent5: 8,
  accent6: 9,
  hlink: 10,
  folHlink: 11,
};

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const x = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${x(r)}${x(g)}${x(b)}`;
}

/** <a:solidFill>の中の色(srgbClr・schemeClr・prstClr。lumMod/lumOffによる明度調整を含む) */
function readDrawingColor(fillEl: Element | undefined, themeColors: string[] | null): string | null {
  if (!fillEl) return null;
  const srgb = child(fillEl, "srgbClr");
  const scheme = child(fillEl, "schemeClr");
  const prst = child(fillEl, "prstClr");
  const colorEl = srgb ?? scheme ?? prst;
  if (!colorEl) return null;
  let hex: string | null = null;
  if (srgb) hex = `#${(srgb.getAttribute("val") ?? "000000").slice(-6)}`;
  else if (scheme) {
    const idx = SCHEME_INDEX[scheme.getAttribute("val") ?? ""];
    hex = idx !== undefined && themeColors ? (themeColors[idx] ?? null) : null;
  } else if (prst) {
    const v = prst.getAttribute("val");
    hex = v === "white" ? "#FFFFFF" : v === "red" ? "#FF0000" : v === "blue" ? "#0000FF" : v === "green" ? "#008000" : v === "yellow" ? "#FFFF00" : "#000000";
  }
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const lumMod = child(colorEl, "lumMod")?.getAttribute("val");
  const lumOff = child(colorEl, "lumOff")?.getAttribute("val");
  if (lumMod || lumOff) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const [h, s, l] = rgbToHsl(r, g, b);
    const mod = lumMod ? Number(lumMod) / 100000 : 1;
    const off = lumOff ? Number(lumOff) / 100000 : 0;
    return hslToHex(h, s, Math.min(1, Math.max(0, l * mod + off)));
  }
  return hex;
}

interface Anchor {
  fromCol: number;
  fromRow: number;
  fromColOffPt: number;
  fromRowOffPt: number;
  toCol: number | null;
  toRow: number | null;
  toColOffPt: number;
  toRowOffPt: number;
  extWidthPt: number | null;
  extHeightPt: number | null;
}

function readMarker(el: Element | undefined): { col: number; row: number; colOffPt: number; rowOffPt: number } | null {
  if (!el) return null;
  const num = (local: string) => Number(child(el, local)?.textContent ?? "0") || 0;
  return { col: num("col"), row: num("row"), colOffPt: num("colOff") / EMU_PER_PT, rowOffPt: num("rowOff") / EMU_PER_PT };
}

function readAnchor(anchorEl: Element): Anchor | null {
  const from = readMarker(child(anchorEl, "from"));
  if (!from) return null; // absoluteAnchor等は対象外
  const to = readMarker(child(anchorEl, "to"));
  const ext = child(anchorEl, "ext");
  return {
    fromCol: from.col,
    fromRow: from.row,
    fromColOffPt: from.colOffPt,
    fromRowOffPt: from.rowOffPt,
    toCol: to ? to.col : null,
    toRow: to ? to.row : null,
    toColOffPt: to ? to.colOffPt : 0,
    toRowOffPt: to ? to.rowOffPt : 0,
    extWidthPt: ext ? Number(ext.getAttribute("cx") ?? "0") / EMU_PER_PT : null,
    extHeightPt: ext ? Number(ext.getAttribute("cy") ?? "0") / EMU_PER_PT : null,
  };
}

function resolveRelTarget(base: string, target: string): string {
  // base: "xl/drawings/drawing1.xml" の ".../_rels/drawing1.xml.rels" から見た相対パスを、パッケージのルートからの絶対パスへ
  if (target.startsWith("/")) return target.replace(/^\//, "");
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function readRels(entries: Record<string, Uint8Array>, relsPath: string, ownerPath: string): Map<string, { type: string; target: string }> {
  const map = new Map<string, { type: string; target: string }>();
  const text = entryText(entries, relsPath);
  const doc = text ? parseXml(text) : null;
  if (!doc) return map;
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, { type: rel.getAttribute("Type") ?? "", target: resolveRelTarget(ownerPath, target) });
  }
  return map;
}

export interface SheetDrawings {
  pictures: SheetPicture[];
  shapes: SheetShape[];
  /** 再現できなかった図形・グラフ・画像の数 */
  unsupportedCount: number;
  /** PNG・JPEG以外の画像(描画側でブラウザの機能を使ってPNGへ変換する) */
  otherImages: { picture: Omit<SheetPicture, "mime" | "bytes">; bytes: Uint8Array; ext: string }[];
}

const SHAPE_KINDS: Record<string, SheetShape["kind"]> = {
  rect: "rect",
  flowChartProcess: "rect",
  roundRect: "roundRect",
  flowChartAlternateProcess: "roundRect",
  ellipse: "ellipse",
  flowChartConnector: "ellipse",
  line: "line",
  straightConnector1: "line",
};

/** シート(worksheets/sheetN.xml)に紐づく描画(drawing)から、画像と単純な図形を読み取る */
export function parseSheetDrawings(
  entries: Record<string, Uint8Array>,
  sheetPath: string,
  themeColors: string[] | null
): SheetDrawings {
  const out: SheetDrawings = { pictures: [], shapes: [], unsupportedCount: 0, otherImages: [] };
  const sheetName = sheetPath.split("/").pop() ?? "";
  const sheetRelsPath = `${sheetPath.slice(0, sheetPath.length - sheetName.length)}_rels/${sheetName}.rels`;
  const sheetRels = readRels(entries, sheetRelsPath, sheetPath);
  const drawingPaths = Array.from(sheetRels.values())
    .filter((r) => /\/drawing$/.test(r.type))
    .map((r) => r.target);
  // グラフだけがあるシート(drawingの中にグラフ)も、drawing内のgraphicFrameとして数える。

  for (const drawingPath of drawingPaths) {
    const text = entryText(entries, drawingPath);
    const doc = text ? parseXml(text) : null;
    if (!doc) continue;
    const dName = drawingPath.split("/").pop() ?? "";
    const drawingRels = readRels(entries, `${drawingPath.slice(0, drawingPath.length - dName.length)}_rels/${dName}.rels`, drawingPath);

    const root = doc.documentElement;
    for (const anchorEl of Array.from(root.children)) {
      if (!["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"].includes(anchorEl.localName)) continue;
      const anchor = readAnchor(anchorEl);
      const content = Array.from(anchorEl.children).find((c) => ["pic", "sp", "cxnSp", "graphicFrame", "grpSp"].includes(c.localName));
      if (!content) continue;
      if (!anchor) {
        out.unsupportedCount++;
        continue;
      }

      if (content.localName === "pic") {
        const blip = descendant(content, "blip");
        const rid = blip?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? blip?.getAttribute("r:embed");
        const rel = rid ? drawingRels.get(rid) : undefined;
        const bytes = rel ? entries[rel.target] : undefined;
        if (!rel || !bytes) {
          out.unsupportedCount++;
          continue;
        }
        const ext = (rel.target.split(".").pop() ?? "").toLowerCase();
        if (ext === "png" || ext === "jpg" || ext === "jpeg") {
          out.pictures.push({ ...anchor, mime: ext === "png" ? "image/png" : "image/jpeg", bytes });
        } else if (["gif", "bmp", "webp", "tif", "tiff"].includes(ext)) {
          out.otherImages.push({ picture: anchor, bytes, ext });
        } else {
          out.unsupportedCount++; // EMF・WMF・SVG等
        }
        continue;
      }

      if (content.localName === "sp" || content.localName === "cxnSp") {
        const spPr = child(content, "spPr");
        const geom = child(spPr, "prstGeom")?.getAttribute("prst") ?? "";
        const kind = SHAPE_KINDS[geom] ?? (content.localName === "cxnSp" ? "line" : null);
        if (!kind) {
          out.unsupportedCount++;
          continue;
        }
        const style = child(content, "style");
        const fillEl = child(spPr, "solidFill");
        const noFill = !!child(spPr, "noFill");
        let fill: string | null = null;
        if (!noFill) {
          fill = fillEl ? readDrawingColor(fillEl, themeColors) : readDrawingColor(child(style, "fillRef"), themeColors);
        }
        const ln = child(spPr, "ln");
        let line: string | null = null;
        if (ln && child(ln, "noFill")) line = null;
        else if (ln && child(ln, "solidFill")) line = readDrawingColor(child(ln, "solidFill"), themeColors);
        else line = readDrawingColor(child(style, "lnRef"), themeColors);
        const lineWidthPt = ln?.getAttribute("w") ? Number(ln.getAttribute("w")) / EMU_PER_PT : 1;

        // 文字: 段落(a:p)ごとに行にする。書式は最初の区間(a:r)のものを使う
        const txBody = child(content, "txBody");
        const paragraphs = children(txBody, "p").map((p) =>
          children(p, "r")
            .map((r) => child(r, "t")?.textContent ?? "")
            .join("")
        );
        const firstRun = descendant(txBody ?? undefined, "r");
        const rPr = child(firstRun, "rPr");
        const szAttr = rPr?.getAttribute("sz");
        const textFill = child(rPr, "solidFill");
        out.shapes.push({
          ...anchor,
          kind,
          fill,
          line,
          lineWidthPt: Number.isFinite(lineWidthPt) && lineWidthPt > 0 ? lineWidthPt : 1,
          text: paragraphs.join("\n").replace(/\n+$/, ""),
          textColor: textFill ? readDrawingColor(textFill, themeColors) : kind === "line" ? null : fill ? "#FFFFFF" : "#000000",
          fontSizePt: szAttr ? Number(szAttr) / 100 : null,
          bold: rPr?.getAttribute("b") === "1",
        });
        continue;
      }

      // graphicFrame(グラフ・表)・grpSp(グループ化された図形)は再現しない
      out.unsupportedCount++;
    }
  }
  return out;
}
