/**
 * 画像ファイルに埋め込まれたメタデータ(EXIF・GPS・XMP等)の有無を調べる軽量な検出器。
 * すべてブラウザ内で完結し、ファイルのバイト列を読むだけで何も書き換えない。
 * 「主要な形式(JPEG・PNG・WebP)の代表的な情報」を調べるもので、あらゆるメタデータを
 * 網羅できる保証はない(UIでもその旨を示す)。
 */
export interface ImageMetadataReport {
  format: "jpeg" | "png" | "webp" | "unknown";
  /** EXIF情報の有無 */
  exif: boolean;
  /** 撮影日時(EXIFにあれば。例: 2024:05:01 12:34:56) */
  dateTime: string | null;
  /** 位置情報(GPS)の有無 */
  gps: boolean;
  /** カメラの製造元・機種 */
  camera: string | null;
  /** 編集ソフト名 */
  software: string | null;
  /** XMP(Adobe等の拡張メタデータ)の有無 */
  xmp: boolean;
  /** IPTC(著作権・キャプション等)の有無 */
  iptc: boolean;
  /** ICCカラープロファイルの有無 */
  icc: boolean;
  /** PNGのテキストチャンク(tEXt/iTXt/zTXt)の有無 */
  textChunks: boolean;
}

function emptyReport(format: ImageMetadataReport["format"]): ImageMetadataReport {
  return {
    format,
    exif: false,
    dateTime: null,
    gps: false,
    camera: null,
    software: null,
    xmp: false,
    iptc: false,
    icc: false,
    textChunks: false,
  };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** EXIF(TIFF構造)を読み、report へ反映する。tiff は "II"/"MM" から始まるバイト列 */
function parseTiff(tiff: Uint8Array, report: ImageMetadataReport): void {
  if (tiff.length < 8) return;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  function readString(entryOffset: number): string | null {
    const count = u32(entryOffset + 4);
    if (count === 0) return null;
    const valueOffset = count <= 4 ? entryOffset + 8 : u32(entryOffset + 8);
    if (valueOffset + count > tiff.length) return null;
    const text = ascii(tiff, valueOffset, count).replace(/\0+$/, "").trim();
    return text === "" ? null : text;
  }

  function readIfd(ifdOffset: number, handler: (tag: number, entryOffset: number) => void): number {
    if (ifdOffset < 8 || ifdOffset + 2 > tiff.length) return 0;
    const entries = u16(ifdOffset);
    let read = 0;
    for (let i = 0; i < entries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > tiff.length) break;
      handler(u16(entryOffset), entryOffset);
      read++;
    }
    return read;
  }

  const names: { make: string | null; model: string | null } = { make: null, model: null };
  let exifIfd = 0;
  let gpsIfd = 0;
  try {
    readIfd(u32(4), (tag, entryOffset) => {
      if (tag === 0x010f) names.make = readString(entryOffset);
      else if (tag === 0x0110) names.model = readString(entryOffset);
      else if (tag === 0x0131) report.software = readString(entryOffset);
      else if (tag === 0x0132 && !report.dateTime) report.dateTime = readString(entryOffset);
      else if (tag === 0x8769) exifIfd = u32(entryOffset + 8);
      else if (tag === 0x8825) gpsIfd = u32(entryOffset + 8);
    });
    if (exifIfd) {
      readIfd(exifIfd, (tag, entryOffset) => {
        // DateTimeOriginal(撮影日時)を優先する
        if (tag === 0x9003) report.dateTime = readString(entryOffset) ?? report.dateTime;
        else if (tag === 0x9004 && !report.dateTime) report.dateTime = readString(entryOffset);
      });
    }
    if (gpsIfd) {
      // GPS用IFDに項目(緯度・経度など)が1つでもあれば位置情報ありとみなす
      const count = readIfd(gpsIfd, () => {});
      if (count > 0) report.gps = true;
    }
  } catch {
    // 壊れたEXIFでも例外にせず、読み取れた分だけ返す
  }
  const camera = [names.make, names.model].filter((v): v is string => !!v).join(" ");
  report.camera = camera === "" ? null : camera;
}

function scanJpeg(bytes: Uint8Array, report: ImageMetadataReport): void {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    // SOI/RSTn/TEM などの長さを持たないマーカー
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    // 画像データ本体(SOS)以降にメタデータは無い
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const start = pos + 4;
    const end = Math.min(bytes.length, pos + 2 + length);
    if (length < 2) break;
    if (marker === 0xe1) {
      if (ascii(bytes, start, 6) === "Exif\0\0") {
        report.exif = true;
        parseTiff(bytes.subarray(start + 6, end), report);
      } else if (ascii(bytes, start, 28).startsWith("http://ns.adobe.com/xap/1.0/")) {
        report.xmp = true;
      }
    } else if (marker === 0xe2) {
      if (ascii(bytes, start, 11) === "ICC_PROFILE") report.icc = true;
    } else if (marker === 0xed) {
      if (ascii(bytes, start, 13).startsWith("Photoshop 3.0")) report.iptc = true;
    }
    pos += 2 + length;
  }
}

function scanPng(bytes: Uint8Array, report: ImageMetadataReport): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = ascii(bytes, pos + 4, 4);
    const dataStart = pos + 8;
    if (type === "eXIf") {
      report.exif = true;
      parseTiff(bytes.subarray(dataStart, dataStart + length), report);
    } else if (type === "iCCP") {
      report.icc = true;
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      report.textChunks = true;
      if (type === "iTXt" && ascii(bytes, dataStart, 17) === "XML:com.adobe.xmp") report.xmp = true;
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + length + 4;
  }
}

function scanWebp(bytes: Uint8Array, report: ImageMetadataReport): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const type = ascii(bytes, pos, 4);
    const length = view.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    if (type === "EXIF") {
      report.exif = true;
      // 先頭に "Exif\0\0" が付く場合がある
      const hasPrefix = ascii(bytes, dataStart, 6) === "Exif\0\0";
      parseTiff(bytes.subarray(dataStart + (hasPrefix ? 6 : 0), dataStart + length), report);
    } else if (type === "XMP ") {
      report.xmp = true;
    } else if (type === "ICCP") {
      report.icc = true;
    }
    pos = dataStart + length + (length % 2);
  }
}

export function inspectImageMetadataBytes(bytes: Uint8Array): ImageMetadataReport {
  try {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      const report = emptyReport("jpeg");
      scanJpeg(bytes, report);
      return report;
    }
    if (bytes.length > 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
      const report = emptyReport("png");
      scanPng(bytes, report);
      return report;
    }
    if (bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
      const report = emptyReport("webp");
      scanWebp(bytes, report);
      return report;
    }
  } catch {
    // 解析に失敗しても「不明」として返す
  }
  return emptyReport("unknown");
}

export async function inspectImageMetadata(file: Blob): Promise<ImageMetadataReport> {
  return inspectImageMetadataBytes(new Uint8Array(await file.arrayBuffer()));
}

/** 何かしらの付随情報が含まれているか */
export function hasAnyMetadata(report: ImageMetadataReport): boolean {
  return report.exif || report.gps || report.xmp || report.iptc || report.icc || report.textChunks;
}
