import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { RECEIPT_CORPUS } from "../fixtures/receipt-corpus";
import { ocrScaleFor } from "@/lib/processors/browser/receipt-ocr";

/**
 * 画像の条件（文字の大きさ・解像度・傾き・薄さ・細長さ）を変えたときの、OCRの読み取りの比較（工程9）。
 *
 * - 実物の領収書ではなく、合成コーパスの書類を、同梱の日本語フォントでcanvasに描いた画像を使う。
 *   写真に特有の歪み・影・ピンぼけ・感熱紙の質感は再現していない。結果は、条件を変えたときの傾向を見るための目安。
 * - 通常のテストでは実行しない（時間がかかるため）。実行するには環境変数 RECEIPT_OCR_EVAL=1 を指定する。
 *   RECEIPT_OCR_EVAL_OUT にファイルパスを指定すると、結果（JSON）をそのファイルに書き出す。
 *   RECEIPT_OCR_EVAL_VARIANTS に、カンマ区切りで条件のIDを指定すると、その条件だけを実行する。
 * - OCRの結果は、実行環境（ブラウザ・OCRエンジン）で変わる。ここでは、精度の下限などを固定せず、集計して記録するだけにする。
 */

const CASE_IDS = ["conv-cash", "rest-service", "drug-discount", "formal-with-tax-lines", "gas-basic", "eReceipt-pdf"];

interface Variant {
  id: string;
  label: string;
  font: number;
  width: number;
  /** 描いた画像を、この倍率でリサイズして保存する（拡大・縮小の影響を見る） */
  scale?: number;
  skew?: number;
  color?: string;
  noise?: boolean;
  blur?: number;
  /** 品目の行を、この数だけ上に足して、細長い画像にする */
  filler?: number;
}

const VARIANTS: Variant[] = [
  { id: "base", label: "標準（文字32px・幅800px）", font: 32, width: 800 },
  { id: "small", label: "小さい文字（20px・幅500px）", font: 20, width: 500 },
  { id: "tiny", label: "とても小さい文字（14px・幅350px）", font: 14, width: 350 },
  { id: "small-x2", label: "小さい文字を2倍に拡大", font: 20, width: 500, scale: 2 },
  { id: "tiny-x2", label: "とても小さい文字を2倍に拡大", font: 14, width: 350, scale: 2 },
  { id: "tiny-x3", label: "とても小さい文字を3倍に拡大", font: 14, width: 350, scale: 3 },
  { id: "hires", label: "高解像度（標準を3倍・幅2400px）", font: 32, width: 800, scale: 3 },
  { id: "skew3", label: "3度の傾き", font: 32, width: 800, skew: 3 },
  { id: "skew8", label: "8度の傾き", font: 32, width: 800, skew: 8 },
  { id: "light", label: "薄い印字（灰色＋ノイズ）", font: 32, width: 800, color: "#a8a8a8", noise: true },
  { id: "blur", label: "ピンぼけ（1.2px）", font: 32, width: 800, blur: 1.2 },
  { id: "long", label: "細長い（文字24px・幅400px・品目100行）", font: 24, width: 400, filler: 100 },
  { id: "xlong", label: "とても細長い（文字24px・幅400px・品目260行）", font: 24, width: 400, filler: 260 },
];

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

async function render(page: Page, lines: string[], v: Variant): Promise<{ png: Buffer; width: number; height: number }> {
  const result = await page.evaluate(
    async ({ lines, v }) => {
      const font = new FontFace("EvalFont", "url(/fonts/NotoSansJP-Regular.ttf)");
      await font.load();
      document.fonts.add(font);
      const filler: string[] = [];
      for (let i = 0; i < (v.filler ?? 0); i++) filler.push(`商品${String(i + 1).padStart(3, "0")} ×1  ¥${(100 + ((i * 37) % 900)).toLocaleString("en-US")}`);
      const all = [...lines.slice(0, 3), ...filler, ...lines.slice(3)];
      const lineHeight = Math.round(v.font * 1.5);
      const margin = Math.round(v.font * 1.2);
      const w = v.width;
      const h = margin * 2 + all.length * lineHeight;
      const base = document.createElement("canvas");
      base.width = w;
      base.height = h;
      const ctx = base.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = v.color ?? "#000000";
      ctx.font = `${v.font}px EvalFont`;
      if (v.blur) ctx.filter = `blur(${v.blur}px)`;
      all.forEach((t, i) => ctx.fillText(t, margin, margin + (i + 1) * lineHeight - Math.round(v.font * 0.3), w - margin * 2));
      ctx.filter = "none";
      if (v.noise) {
        const img = ctx.getImageData(0, 0, w, h);
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (rnd() - 0.5) * 60;
          img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
          img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
          img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
        }
        ctx.putImageData(img, 0, 0);
      }
      let out = base;
      if (v.skew) {
        const rad = (v.skew * Math.PI) / 180;
        const nw = Math.ceil(w * Math.cos(rad) + h * Math.sin(rad));
        const nh = Math.ceil(h * Math.cos(rad) + w * Math.sin(rad));
        const c2 = document.createElement("canvas");
        c2.width = nw;
        c2.height = nh;
        const x2 = c2.getContext("2d")!;
        x2.fillStyle = "#ffffff";
        x2.fillRect(0, 0, nw, nh);
        x2.translate(nw / 2, nh / 2);
        x2.rotate(rad);
        x2.drawImage(base, -w / 2, -h / 2);
        out = c2;
      }
      if (v.scale && v.scale !== 1) {
        const c3 = document.createElement("canvas");
        c3.width = Math.round(out.width * v.scale);
        c3.height = Math.round(out.height * v.scale);
        const x3 = c3.getContext("2d")!;
        x3.imageSmoothingEnabled = true;
        x3.imageSmoothingQuality = "high";
        x3.drawImage(out, 0, 0, c3.width, c3.height);
        out = c3;
      }
      return { b64: out.toDataURL("image/png").split(",")[1], width: out.width, height: out.height };
    },
    { lines, v },
  );
  return { png: Buffer.from(result.b64, "base64"), width: result.width, height: result.height };
}

interface Row {
  variant: string;
  case: string;
  width: number;
  height: number;
  ocrScale: number;
  ms: number;
  lineRecall: number;
  charAccuracy: number | null;
  date: string;
  vendor: string;
  total: string;
  dateOk: boolean;
  vendorOk: boolean;
  totalOk: boolean;
  /** 自動入力されたが誤っていた項目の数 */
  wrongAuto: number;
}

test.describe("receipt-ocr-eval", () => {
  test.skip(!process.env.RECEIPT_OCR_EVAL, "時間がかかるため、RECEIPT_OCR_EVAL=1 のときだけ実行する");
  test.setTimeout(60 * 60 * 1000);

  test("画像の条件を変えたときのOCR結果を比べる（記録のみ）", async ({ page }) => {
    const only = process.env.RECEIPT_OCR_EVAL_VARIANTS?.split(",").filter(Boolean);
    const variants = only ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-ocr-eval-"));
    const rows: Row[] = [];
    try {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/tools/receipt-accounting-csv");
      await expect(page.getByTestId("receipt-tool")).toBeVisible();

      for (const v of variants) {
        for (const id of CASE_IDS) {
          const c = RECEIPT_CORPUS.find((x) => x.id === id)!;
          const { png, width, height } = await render(page, c.lines, v);
          const file = path.join(dir, `${v.id}-${id}.png`);
          fs.writeFileSync(file, png);

          const before = await page.getByTestId("receipt-row").count();
          const started = Date.now();
          await uploadFixture(page, file);
          await expect(page.getByTestId("receipt-row")).toHaveCount(before + 1, { timeout: 15 * 60 * 1000 });
          const ms = Date.now() - started;
          const row = page.getByTestId("receipt-row").nth(before);
          const rawText = (await row.getByTestId("receipt-raw-text").textContent()) ?? "";
          const date = await row.getByTestId("receipt-date").inputValue();
          const vendor = await row.getByTestId("receipt-vendor").inputValue();
          const total = await row.getByTestId("receipt-total").inputValue();

          const ocrNorm = norm(rawText);
          const truthLines = c.lines.map(norm).filter((l) => l.length > 0);
          const lineRecall = truthLines.filter((l) => ocrNorm.includes(l)).length / truthLines.length;
          const truthText = truthLines.join("");
          const charAccuracy = v.filler ? null : Math.max(0, 1 - levenshtein(ocrNorm, truthText) / truthText.length);
          const truth = c.truth;
          const dateOk = date === (truth.date ?? "");
          const vendorOk = norm(vendor) === norm(truth.vendor ?? "");
          const totalOk = total === (truth.total === null ? "" : String(truth.total));
          const wrongAuto = [date !== "" && !dateOk, vendor !== "" && !vendorOk, total !== "" && !totalOk].filter(Boolean).length;
          rows.push({
            variant: v.id,
            case: id,
            width,
            height,
            ocrScale: Number(ocrScaleFor(width, height).toFixed(3)),
            ms,
            lineRecall,
            charAccuracy,
            date,
            vendor,
            total,
            dateOk,
            vendorOk,
            totalOk,
            wrongAuto,
          });
          // 次の条件に影響しないよう、行を消す
          await row.getByTestId("receipt-delete").click();
          await expect(page.getByTestId("receipt-row")).toHaveCount(before);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      const out = process.env.RECEIPT_OCR_EVAL_OUT;
      if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1), "utf8");
    }

    // 集計（記録のみ。精度の下限は固定しない）
    for (const v of variants) {
      const r = rows.filter((x) => x.variant === v.id);
      const avg = (f: (x: Row) => number) => r.reduce((s, x) => s + f(x), 0) / r.length;
      const acc = r.filter((x) => x.charAccuracy !== null);
      console.log(
        `${v.id}\t${v.label}\t${r[0]?.width}x${r[0]?.height}\tscale=${r[0]?.ocrScale}\t${Math.round(avg((x) => x.ms))}ms\t行の再現${(avg((x) => x.lineRecall) * 100).toFixed(0)}%\t文字${acc.length ? ((acc.reduce((s, x) => s + (x.charAccuracy ?? 0), 0) / acc.length) * 100).toFixed(0) + "%" : "-"}\t日付${r.filter((x) => x.dateOk).length}/${r.length}\t取引先${r.filter((x) => x.vendorOk).length}/${r.length}\t合計${r.filter((x) => x.totalOk).length}/${r.length}\t誤入力${r.reduce((s, x) => s + x.wrongAuto, 0)}`,
      );
    }
    expect(rows.length).toBe(variants.length * CASE_IDS.length);
  });
});
