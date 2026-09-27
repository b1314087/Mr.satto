import fs from "node:fs";
import zlib from "node:zlib";

/**
 * テスト側（Node.js実行環境）でのPNG内容検証ヘルパー（Phase 16）。
 *
 * 「ダウンロードイベントが発火した」「PNGの先頭バイトが正しい」だけでなく、
 * 実際にピクセルをデコードして「透明ピクセルが存在するか」「印影部分（不透明な
 * ピクセル）が完全に消えていないか」まで確認するために使う。
 *
 * 新しいnpm依存は追加せず、Node.js標準の zlib（PNGのIDATチャンクはzlib圧縮）
 * だけを使って最小限のPNGデコーダーを自前実装する。対象はブラウザの
 * canvas.toBlob("image/png") が出力する非インターレース・8bit深度のPNG
 * （カラータイプ2:RGB / 6:RGBA）に限定した、本テスト用途に絞った実装。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isValidPngFile(filePath: string): boolean {
  const buf = fs.readFileSync(filePath);
  return buf.length > PNG_SIGNATURE.length && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBAまたはRGB、常に4チャンネル(RGBA)に正規化済み。値は0-255 */
  data: Uint8Array;
  hasAlphaChannel: boolean;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 対象を canvas.toBlob("image/png") 出力に限定した最小限のPNGデコーダー */
export function decodePng(filePath: string): DecodedPng {
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("有効なPNGファイルではありません");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8) {
        throw new Error(`未対応のPNG bitDepthです(${bitDepth})。本テストヘルパーは8bitのみ対応しています。`);
      }
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`未対応のPNG colorTypeです(${colorType})。本テストヘルパーはRGB(2)/RGBA(6)のみ対応しています。`);
      }
      if (interlace !== 0) {
        throw new Error("インターレースPNGには対応していません。");
      }
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }

    offset = dataStart + length + 4; // +4 = CRC
  }

  if (width === 0 || height === 0) throw new Error("PNGのIHDRを読み取れませんでした");

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));

  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prevLine: Uint8Array = new Uint8Array(stride);
  let rawOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prevLine[x];
      const c = x >= channels ? prevLine[x - channels] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + a) & 0xff;
          break;
        case 2:
          value = (rawByte + b) & 0xff;
          break;
        case 3:
          value = (rawByte + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          value = (rawByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`未対応のPNGフィルタタイプです(${filterType})`);
      }
      line[x] = value;
    }
    rawOffset += stride;

    for (let x = 0; x < width; x++) {
      const srcIdx = x * channels;
      const dstIdx = (y * width + x) * 4;
      out[dstIdx] = line[srcIdx];
      out[dstIdx + 1] = line[srcIdx + 1];
      out[dstIdx + 2] = line[srcIdx + 2];
      out[dstIdx + 3] = channels === 4 ? line[srcIdx + 3] : 255;
    }
    prevLine = line;
  }

  return { width, height, data: out, hasAlphaChannel: channels === 4 };
}

/** 完全または部分的に透明なピクセル(alpha < 250)の数を数える */
export function countTransparentPixels(png: DecodedPng): number {
  let count = 0;
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] < 250) count += 1;
  }
  return count;
}

/** 十分に不透明で、かつ明るすぎない(=単なる白背景の残り物ではない)ピクセルの数を数える */
export function countOpaqueInkPixels(png: DecodedPng, lightnessCutoff = 200): number {
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.data[i + 3];
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    if (a > 200 && lightness < lightnessCutoff) count += 1;
  }
  return count;
}
