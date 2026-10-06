/**
 * QRコードの上にマーク(ロゴ)を重ねる処理。ブラウザのCanvasだけで完結する。
 *
 * マークの下には背景色の台(角丸の四角)を敷き、マークの周りのQRの点を消して読み取りやすくする。
 * 隠れた部分は QRコードの誤り訂正で補うため、マークを付けるときは誤り訂正レベルを最高の H にする
 * (Hは全体の約30%まで欠けても復元できる)。マークの一辺を QRの一辺の30%以内にすると、
 * 面積は約9%以下で、この範囲に収まる。
 */

export type QrLogoPosition = "center" | "bottomRight";

export interface QrLogo {
  /** 画像のdata URL(PNG/JPEG/SVGなど) */
  src: string;
  position: QrLogoPosition;
  /** マークの一辺が、QRコードの一辺の何%か(10〜30) */
  sizePct: number;
}

export const QR_LOGO_MIN_PCT = 10;
export const QR_LOGO_MAX_PCT = 30;
export const QR_LOGO_DEFAULT_PCT = 22;

/**
 * Mr.Satto のアイコン(サイトのヘッダー・アプリアイコンと同じ、青〜紺のグラデーションの角丸に道具箱)。
 * 絵文字のフォントに頼らず、どの環境でも同じ見た目になるようSVGで持つ。
 */
export const DEFAULT_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs>
<rect width="128" height="128" rx="26" fill="url(#g)"/>
<path d="M50 56V44a7 7 0 0 1 7-7h14a7 7 0 0 1 7 7v12" fill="none" stroke="#e5e7eb" stroke-width="7" stroke-linecap="round"/>
<rect x="24" y="54" width="80" height="50" rx="8" fill="#ef4444"/>
<rect x="24" y="72" width="80" height="7" fill="#b91c1c"/>
<rect x="56" y="66" width="16" height="20" rx="3" fill="#fbbf24"/>
</svg>`;

export const DEFAULT_MARK_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DEFAULT_MARK_SVG)}`;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("マークの画像を読み込めませんでした。別の画像を選んでください。"));
    img.src = src;
  });
}

/** 角丸の四角のパスを作る */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** マークを置く四角(QR左上を原点とするpx)を返す */
export function logoBox(qrSize: number, logo: Pick<QrLogo, "position" | "sizePct">): { x: number; y: number; side: number } {
  const pct = Math.min(QR_LOGO_MAX_PCT, Math.max(QR_LOGO_MIN_PCT, logo.sizePct));
  const side = Math.round((qrSize * pct) / 100);
  if (logo.position === "bottomRight") {
    // 右下の端のすき間(QRの周りの余白の内側)に寄せる
    const inset = Math.round(qrSize * 0.035);
    return { x: qrSize - inset - side, y: qrSize - inset - side, side };
  }
  return { x: Math.round((qrSize - side) / 2), y: Math.round((qrSize - side) / 2), side };
}

/** QRコード画像(data URL)にマークを重ねて、PNGのdata URLで返す */
export async function addLogoToQr(qrDataUrl: string, logo: QrLogo, backgroundColor: string): Promise<string> {
  const [qrImg, logoImg] = await Promise.all([loadImage(qrDataUrl), loadImage(logo.src)]);
  const size = qrImg.naturalWidth || qrImg.width;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  ctx.drawImage(qrImg, 0, 0, size, size);

  const box = logoBox(size, logo);
  const pad = Math.max(2, Math.round(box.side * 0.08));
  // 台(背景色)を敷いてから、マークを縦横比を保って収める
  ctx.fillStyle = backgroundColor;
  roundRectPath(ctx, box.x - pad, box.y - pad, box.side + pad * 2, box.side + pad * 2, Math.round(box.side * 0.18));
  ctx.fill();

  const lw = logoImg.naturalWidth || logoImg.width || 1;
  const lh = logoImg.naturalHeight || logoImg.height || 1;
  const scale = Math.min(box.side / lw, box.side / lh);
  const dw = lw * scale;
  const dh = lh * scale;
  ctx.save();
  roundRectPath(ctx, box.x + (box.side - dw) / 2, box.y + (box.side - dh) / 2, dw, dh, Math.round(Math.min(dw, dh) * 0.2));
  ctx.clip();
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(logoImg, box.x + (box.side - dw) / 2, box.y + (box.side - dh) / 2, dw, dh);
  ctx.restore();
  return canvas.toDataURL("image/png");
}

/** アップロードされた画像を、長辺256pxまでに縮めたPNGのdata URLにする(大きな画像で動作が重くならないように) */
export async function fileToMarkDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth || img.width || 256;
    const h = img.naturalHeight || img.height || 256;
    const scale = Math.min(1, 256 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
