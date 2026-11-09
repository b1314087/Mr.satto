import { execFileSync } from "node:child_process";

/**
 * 画像の中のQRコードを、独立した2つの読み取りライブラリで読む(テスト用)。
 * - OpenCV(opencv-python の cv2.QRCodeDetector)
 * - ZXing(zxing-cpp の Python 版。Android などで広く使われる ZXing の C++ 版)
 * どちらも、このリポジトリの依存ではなく、テストを動かすPCに入っているときだけ使う(pip install opencv-python zxing-cpp)。
 * 透明な背景は、白い紙に押したときと同じように白の上に重ね、周りに白い余白を足してから読む。
 * scales を渡すと、画像の大きさを変えたもの(縮小は面積の平均、拡大は線形補間)でも読む。
 */

export interface QrDecoders {
  opencv: boolean;
  zxing: boolean;
}

let cached: QrDecoders | null = null;

export function qrDecoders(): QrDecoders {
  if (cached) return cached;
  const has = (mod: string) => {
    try {
      execFileSync("python3", ["-c", `import ${mod}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  cached = { opencv: has("cv2"), zxing: has("zxingcpp") && has("cv2") };
  return cached;
}

export interface QrDecodeResult {
  scale: number;
  /** 読み取れた文字列(読めなかったら ""、ライブラリが無ければ null) */
  opencv: string | null;
  zxing: string | null;
}

const SCRIPT = String.raw`
import sys, json, cv2, numpy as np
try:
    import zxingcpp
except Exception:
    zxingcpp = None
img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
if img.ndim == 3 and img.shape[2] == 4:
    a = img[:, :, 3:4].astype(float) / 255.0
    img = (img[:, :, :3].astype(float) * a + 255 * (1 - a)).astype(np.uint8)
out = []
for s in json.loads(sys.argv[2]):
    v = img if s == 1 else cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    g = cv2.cvtColor(v, cv2.COLOR_BGR2GRAY)
    g = cv2.copyMakeBorder(g, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    cv = ""
    for k in (1, 2, 3):
        gg = g if k == 1 else cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_NEAREST)
        try:
            cv = cv2.QRCodeDetector().detectAndDecode(gg)[0]
        except cv2.error:
            cv = ""
        if cv:
            break
    zx = None
    if zxingcpp is not None:
        r = zxingcpp.read_barcodes(g)
        zx = r[0].text if r else ""
    out.append({"scale": s, "opencv": cv, "zxing": zx})
print(json.dumps(out))
`;

export function decodeQrFile(file: string, scales: number[] = [1]): QrDecodeResult[] {
  if (!qrDecoders().opencv) return scales.map((scale) => ({ scale, opencv: null, zxing: null }));
  return JSON.parse(execFileSync("python3", ["-c", SCRIPT, file, JSON.stringify(scales)]).toString()) as QrDecodeResult[];
}

const CORNERS_SCRIPT = String.raw`
import sys, json, cv2, numpy as np
img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
if img.ndim == 3 and img.shape[2] == 4:
    a = img[:, :, 3:4].astype(float) / 255.0
    img = (img[:, :, :3].astype(float) * a + 255 * (1 - a)).astype(np.uint8)
g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
g = cv2.copyMakeBorder(g, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
ok, pts = cv2.QRCodeDetector().detect(g)
print(json.dumps((pts.reshape(-1, 2) - 40).tolist() if ok and pts is not None else None))
`;

/** OpenCV が見つけたQRコードの4つの角(画像の座標)。見つからなければ null */
export function qrCorners(file: string): [number, number][] | null {
  if (!qrDecoders().opencv) return null;
  return JSON.parse(execFileSync("python3", ["-c", CORNERS_SCRIPT, file]).toString()) as [number, number][] | null;
}
