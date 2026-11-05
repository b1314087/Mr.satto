/**
 * JPEGの「向き」の情報（EXIF の Orientation）を読む。
 *
 * スマートフォンのカメラは、縦に持って撮っても画素は横向きのまま保存し、「表示するときは90度回す」という
 * 印（Orientation）だけを付けることが多い。ブラウザ（画面のプレビュー）はこの印に従って回して表示するが、
 * PDFにJPEGをそのまま埋め込むと印は使われないため、PDFでは横に倒れた画像になる。
 * そこで、印を読み取り、PDFに描くときに同じ向きに回す（画質を落とさないよう、画像は作り直さない）。
 *
 * 値の意味（EXIF 2.3）：1＝そのまま、2＝左右反転、3＝180度、4＝上下反転、
 * 5＝左右反転＋反時計回りに90度、6＝時計回りに90度、7＝左右反転＋時計回りに90度、8＝反時計回りに90度。
 */

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** JPEGのバイト列から Orientation を読む（無い・読めないときは 1） */
export function readJpegOrientation(bytes: Uint8Array): ExifOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return 1;
    const marker = bytes[pos + 1];
    // 画像データの始まり（SOS）・終わり（EOI）より後に EXIF は無い
    if (marker === 0xda || marker === 0xd9) return 1;
    const len = view.getUint16(pos + 2);
    if (len < 2) return 1;
    if (marker === 0xe1 && pos + 4 + 6 <= bytes.length) {
      const start = pos + 4;
      // "Exif\0\0"
      if (view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0) {
        const o = readTiffOrientation(view, start + 6, Math.min(bytes.length, pos + 2 + len));
        if (o) return o;
      }
    }
    pos += 2 + len;
  }
  return 1;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): ExifOrientation | null {
  if (tiff + 8 > end) return null;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  if (view.getUint16(tiff + 2, little) !== 42) return null;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const v = view.getUint16(entry + 8, little);
      return v >= 1 && v <= 8 ? (v as ExifOrientation) : null;
    }
  }
  return null;
}

/** 向きによって、表示するときに幅と高さが入れ替わるか（90度回す向き） */
export function orientationSwapsSides(o: ExifOrientation): boolean {
  return o >= 5;
}

/**
 * 画像（PDFの画像は、左下(0,0)〜右上(1,1)の正方形に描かれる）を、
 * 表示の向きに直して、ページ上の枠 (x, y, w, h)（左下が x,y）にぴったり描くための変換行列 [a b c d e f]。
 * 枠の w・h は、表示したときの幅・高さ。
 */
export function orientationMatrix(o: ExifOrientation, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  // 枠の四隅（PDFの座標は上が大きい）
  const TL: [number, number] = [x, y + h];
  const TR: [number, number] = [x + w, y + h];
  const BL: [number, number] = [x, y];
  const BR: [number, number] = [x + w, y];
  // 元の画像の 左上・右上・左下 が、表示したときに枠のどの隅へ行くか
  const map: Record<ExifOrientation, [[number, number], [number, number], [number, number]]> = {
    1: [TL, TR, BL],
    2: [TR, TL, BR],
    3: [BR, BL, TR],
    4: [BL, BR, TL],
    5: [TL, BL, TR],
    6: [TR, BR, TL],
    7: [BR, TR, BL],
    8: [BL, TL, BR],
  };
  const [tl, tr, bl] = map[o];
  // 画像の座標：左上(0,1)・右上(1,1)・左下(0,0)
  return [tr[0] - tl[0], tr[1] - tl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]];
}
