/**
 * 領収書・レシートの画像を、OCRに渡す前の「大きさ」と「切り分け方」を決める（工程9）。純粋な関数だけ。
 *
 * 工程9で、合成画像（実物の領収書ではない）を使い、画像の条件を変えて比べた結果に基づく:
 * - 文字が小さい画像（幅350px・文字14px）は、そのままだと日付の読み取りが落ちる（6件中4件）。2倍に拡大すると6件中6件になった。
 * - 細長い画像（幅400px・高さ約10,000px）を、画素数・長辺の上限で縮小すると、倍率0.4になって文字が潰れ、全く読めなかった（0件）。
 *   縦に切り分け（ストリップ）、倍率を変えずに1本ずつ読むと読める。
 * - 画像が大きすぎても精度は上がらない（幅2400pxでは、標準の幅800pxよりわずかに下がった）。画素数の上限は維持する。
 */

/** OCRに渡す画像の画素数の上限（メモリと処理時間の保護） */
export const OCR_MAX_PIXELS = 4_000_000;
/** OCRに渡す画像の長辺の上限(px) */
export const OCR_MAX_LONG_SIDE = 4000;
/** 長辺がこれより小さい画像は、文字が小さい可能性が高いため、拡大して読む */
export const OCR_SMALL_LONG_SIDE = 1000;
/** 拡大する場合の最大倍率 */
export const OCR_MAX_UPSCALE = 2;
/** 細長い画像（高さ÷幅がこれより大きい）で、縮小すると文字が潰れる場合に、縦に切り分けて読む */
export const OCR_TALL_ASPECT = 2.5;
/** 切り分けるときの、1本の高さ(OCRに渡す画像でのpx) */
export const OCR_STRIP_HEIGHT = 3000;
/** 切り分けるときの、幅の上限(OCRに渡す画像でのpx) */
export const OCR_STRIP_MAX_WIDTH = 2000;
/** この倍率より小さく縮小されそうな細長い画像を、切り分けの対象にする */
const TALL_SCALE_THRESHOLD = 0.85;

export interface OcrPlan {
  /** 元の画像に掛ける倍率（1より小さければ縮小、大きければ拡大） */
  scale: number;
  /** 縦に切り分けて読むときの、1本の高さ（OCRに渡す画像でのpx）。切り分けないときは null */
  stripHeight: number | null;
}

export function planOcr(width: number, height: number): OcrPlan {
  if (width <= 0 || height <= 0) return { scale: 1, stripHeight: null };
  const long = Math.max(width, height);
  // 小さい画像：文字が小さいことが多いため、拡大して読む
  if (long < OCR_SMALL_LONG_SIDE) {
    return { scale: Math.min(OCR_MAX_UPSCALE, OCR_SMALL_LONG_SIDE / long), stripHeight: null };
  }
  const byPixels = Math.sqrt(OCR_MAX_PIXELS / (width * height));
  const byLongSide = OCR_MAX_LONG_SIDE / long;
  const base = Math.min(1, byPixels, byLongSide);
  // 縦に細長く、上限に合わせて縮小すると文字が潰れる画像：幅だけを基準に倍率を決め、縦に切り分けて読む
  if (height > width * OCR_TALL_ASPECT && base < TALL_SCALE_THRESHOLD) {
    return { scale: Math.min(1, OCR_STRIP_MAX_WIDTH / width), stripHeight: OCR_STRIP_HEIGHT };
  }
  return { scale: base, stripHeight: null };
}

export interface StripRange {
  /** 元の画像での位置(px) */
  top: number;
  height: number;
}

/**
 * 画像を縦に切り分ける位置を決める。
 * @param sourceHeight 元の画像の高さ(px)
 * @param stripSourceHeight 1本の高さ（元の画像でのpx）
 * @param rowActivity 画像を縮小した行ごとの「文字らしさ」（その行の明るさのばらつき）。行が少ないほど荒い。null なら、等間隔で切る
 * @param searchRadius 切る位置を、本来の位置の前後この範囲（元の画像でのpx）で探す
 *
 * 文字の行を真ん中で切ると、その行が読めなくなるため、本来の位置の近くで、文字がもっとも少ない（空白に近い）行を探して切る。
 */
export function planStrips(sourceHeight: number, stripSourceHeight: number, rowActivity: number[] | null, searchRadius: number): StripRange[] {
  if (sourceHeight <= 0) return [];
  const count = Math.max(1, Math.ceil(sourceHeight / stripSourceHeight));
  const cuts: number[] = [0];
  for (let k = 1; k < count; k++) {
    const target = Math.round((sourceHeight * k) / count);
    let cut = target;
    if (rowActivity && rowActivity.length > 1) {
      const ratio = sourceHeight / rowActivity.length;
      const from = Math.max(0, Math.floor((target - searchRadius) / ratio));
      const to = Math.min(rowActivity.length - 1, Math.ceil((target + searchRadius) / ratio));
      let best = -1;
      for (let r = from; r <= to; r++) {
        const better =
          best < 0 ||
          rowActivity[r] < rowActivity[best] ||
          (rowActivity[r] === rowActivity[best] && Math.abs(r * ratio - target) < Math.abs(best * ratio - target));
        if (better) best = r;
      }
      if (best >= 0) cut = Math.round((best + 0.5) * ratio);
    }
    // 前の切り位置より後ろ、かつ画像の中にあること
    cut = Math.min(Math.max(cut, cuts[cuts.length - 1] + 1), sourceHeight - 1);
    cuts.push(cut);
  }
  cuts.push(sourceHeight);
  const strips: StripRange[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] > cuts[i]) strips.push({ top: cuts[i], height: cuts[i + 1] - cuts[i] });
  }
  return strips;
}
