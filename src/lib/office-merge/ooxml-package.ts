import { unzipSync, zipSync, type Zippable } from "fflate";

/**
 * Word・Excel のファイル（OOXML：中身は XML を ZIP にまとめたもの）を、ブラウザの中で読み書きするための共通の部品
 * （Word結合・Excelシート分割/結合。2026-11-17）。
 *
 * - ZIP の展開・圧縮は fflate、XML の読み書きはブラウザの DOMParser・XMLSerializer を使う（新しいライブラリは使わない）。
 * - 部品（パーツ）どうしのつながり（.rels）と、部品の種類の一覧（[Content_Types].xml）を扱う関数をまとめる。
 */

export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
export const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export class OoxmlError extends Error {}

export type Files = Record<string, Uint8Array>;

export function unzipPackage(bytes: Uint8Array, label: string): Files {
  try {
    const files = unzipSync(bytes);
    if (!files["[Content_Types].xml"]) throw new Error("no content types");
    return files;
  } catch {
    throw new OoxmlError(`${label}を開けませんでした。壊れているか、パスワードが付いているか、対応していない形式の可能性があります。`);
  }
}

export function zipPackage(files: Files): Uint8Array {
  const z: Zippable = {};
  // [Content_Types].xml を先頭に置く（Office はどの順でも読めるが、慣例に合わせる）
  const names = Object.keys(files).sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : 0));
  for (const n of names) z[n] = [files[n], { level: /\.(png|jpe?g|gif|emf|wmf|bin)$/i.test(n) ? 0 : 6 }];
  return zipSync(z);
}

export function parseXmlText(text: string, label: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new OoxmlError(`${label}の中身を読み取れませんでした（壊れている可能性があります）。`);
  return doc;
}

export function readXml(files: Files, path: string, label: string): Document | null {
  const b = files[path];
  if (!b) return null;
  return parseXmlText(decoder.decode(b), label);
}

export function xmlBytes(doc: Document): Uint8Array {
  const text = new XMLSerializer().serializeToString(doc);
  return encoder.encode(text.startsWith("<?xml") ? text : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}`);
}

export function byLocal(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", local));
}

export function childrenByLocal(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}

export function firstChild(el: Element, local: string): Element | null {
  return Array.from(el.children).find((c) => c.localName === local) ?? null;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function relsPathOf(partPath: string): string {
  const d = dirOf(partPath);
  const name = partPath.slice(d.length ? d.length + 1 : 0);
  return `${d ? `${d}/` : ""}_rels/${name}.rels`;
}

export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dirOf(partPath).split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** fromPart から toPart への相対パス（.rels の Target に書く値） */
export function relativeTarget(fromPart: string, toPart: string): string {
  const from = dirOf(fromPart).split("/").filter(Boolean);
  const to = toPart.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  el: Element;
}

export function emptyRelsDoc(): Document {
  return parseXmlText(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG_REL_NS}"></Relationships>`, "関係の一覧");
}

export function readRels(files: Files, partPath: string): Document {
  return readXml(files, relsPathOf(partPath), "部品の関係の一覧") ?? emptyRelsDoc();
}

export function listRels(relsDoc: Document): Rel[] {
  return byLocal(relsDoc, "Relationship").map((el) => ({
    id: el.getAttribute("Id") ?? "",
    type: el.getAttribute("Type") ?? "",
    target: el.getAttribute("Target") ?? "",
    external: el.getAttribute("TargetMode") === "External",
    el,
  }));
}

export function relTypeIs(type: string, name: string): boolean {
  return type.endsWith(`/${name}`);
}

export function addRel(relsDoc: Document, type: string, target: string, external = false, preferredId?: string): string {
  const used = new Set(listRels(relsDoc).map((r) => r.id));
  let id = preferredId && !used.has(preferredId) ? preferredId : "";
  for (let n = used.size + 1; !id; n++) if (!used.has(`rId${n}`)) id = `rId${n}`;
  const el = relsDoc.createElementNS(PKG_REL_NS, "Relationship");
  el.setAttribute("Id", id);
  el.setAttribute("Type", type);
  el.setAttribute("Target", target);
  if (external) el.setAttribute("TargetMode", "External");
  relsDoc.documentElement.appendChild(el);
  return id;
}

/** [Content_Types].xml の扱い */
export class ContentTypes {
  doc: Document;
  constructor(files: Files) {
    const d = readXml(files, "[Content_Types].xml", "部品の種類の一覧");
    if (!d) throw new OoxmlError("ファイルの中に部品の種類の一覧が見つかりませんでした。");
    this.doc = d;
  }
  override(partPath: string): string | null {
    const el = byLocal(this.doc, "Override").find((o) => o.getAttribute("PartName") === `/${partPath}`);
    return el?.getAttribute("ContentType") ?? null;
  }
  defaultFor(ext: string): string | null {
    const el = byLocal(this.doc, "Default").find((o) => (o.getAttribute("Extension") ?? "").toLowerCase() === ext.toLowerCase());
    return el?.getAttribute("ContentType") ?? null;
  }
  typeOf(partPath: string): string | null {
    return this.override(partPath) ?? this.defaultFor(partPath.split(".").pop() ?? "");
  }
  setOverride(partPath: string, contentType: string) {
    const existing = byLocal(this.doc, "Override").find((o) => o.getAttribute("PartName") === `/${partPath}`);
    if (existing) {
      existing.setAttribute("ContentType", contentType);
      return;
    }
    const el = this.doc.createElementNS(CT_NS, "Override");
    el.setAttribute("PartName", `/${partPath}`);
    el.setAttribute("ContentType", contentType);
    this.doc.documentElement.appendChild(el);
  }
  removeOverride(partPath: string) {
    for (const o of byLocal(this.doc, "Override")) if (o.getAttribute("PartName") === `/${partPath}`) o.parentNode?.removeChild(o);
  }
  ensureDefault(ext: string, contentType: string) {
    if (this.defaultFor(ext)) return;
    const el = this.doc.createElementNS(CT_NS, "Default");
    el.setAttribute("Extension", ext);
    el.setAttribute("ContentType", contentType);
    const firstOverride = byLocal(this.doc, "Override")[0];
    this.doc.documentElement.insertBefore(el, firstOverride ?? null);
  }
  /** 別のファイルの部品を、新しい名前で入れるときに、種類も写す */
  copyFrom(src: ContentTypes, srcPath: string, dstPath: string) {
    const o = src.override(srcPath);
    if (o) {
      this.setOverride(dstPath, o);
      return;
    }
    const ext = srcPath.split(".").pop() ?? "";
    const d = src.defaultFor(ext);
    const dstExt = dstPath.split(".").pop() ?? "";
    if (d && !this.defaultFor(dstExt)) this.ensureDefault(dstExt, d);
    else if (d && this.defaultFor(dstExt) !== d) this.setOverride(dstPath, d);
  }
}

/** 使われていない部品の名前を作る（例：word/media/image1.png → word/media/image1_m2.png） */
export function uniquePartName(files: Files, wanted: string, suffix: string): string {
  if (!files[wanted]) return wanted;
  const dot = wanted.lastIndexOf(".");
  const stem = dot > wanted.lastIndexOf("/") ? wanted.slice(0, dot) : wanted;
  const ext = dot > wanted.lastIndexOf("/") ? wanted.slice(dot) : "";
  for (let n = 1; ; n++) {
    const name = `${stem}_${suffix}${n > 1 ? n : ""}${ext}`;
    if (!files[name]) return name;
  }
}

/** XMLとして読み直せるか（書き出す前の確認） */
export function verifyXmlParts(files: Files, label: string) {
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    parseXmlText(decoder.decode(bytes), `${label}（${name}）`);
  }
}

export function textOf(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}
