/**
 * 封筒宛名作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * 長形3号・長形4号・角形2号の3封筒サイズに、宛先（複数可）と差出人を
 * 縦書き／横書きで印刷するPDFを生成する。1宛先につき1ページとし、
 * 複数宛先はまとめて1つのPDFとして書き出す。封筒の向き（縦長／横長）、
 * 宛名の敬称（様・御中・なし）、文字サイズ・太字を指定できる。
 *
 * 配置の計算は src/lib/print/envelope-layout.ts にまとめ、画面のプレビューと共通にしている
 * （ここでは計算された図形をpdf-libで描くだけ）。
 *
 * 日本語フォント埋め込みは document-pdf.ts（見積書・請求書・注文書）と
 * 同じ pdf-lib + @pdf-lib/fontkit + loadJapaneseFontBytes の組み合わせを
 * そのまま再利用する（新しいPDFライブラリ・フォント資産は追加しない）。
 * 太字は、太字専用のフォント資産が無いため「塗り＋縁取り」による疑似ボールドで近似する。
 */
import {
  PDFDocument,
  type PDFFont,
  rgb,
  setLineWidth,
  setStrokingRgbColor,
  setTextRenderingMode,
  TextRenderingMode,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { ENVELOPE_SIZES_MM, resolveEnvelopePageSizePt, type EnvelopeSizeId } from "@/lib/print/envelope-sizes";
import {
  defaultBlocks,
  ENVELOPE_BLOCK_IDS,
  isTextEmpty,
  layoutEnvelope,
  MAX_FONT_PT,
  MIN_FONT_PT,
  type EnvelopeBlocks,
  type EnvelopeFreeText,
  type EnvelopeHonorific,
  type EnvelopeOrientation,
  type EnvelopeWritingMode,
} from "@/lib/print/envelope-layout";
import { sanitizeFileName } from "@/lib/utils/format";

export type { EnvelopeBlocks, EnvelopeFreeText, EnvelopeHonorific, EnvelopeOrientation, EnvelopeWritingMode };

export interface EnvelopeAddressInput {
  envelopeSize: EnvelopeSizeId;
  writingMode: EnvelopeWritingMode;
  /** 封筒の向き(省略時は横長) */
  orientation?: EnvelopeOrientation;
  /** 宛名の敬称(省略時は様) */
  honorific?: EnvelopeHonorific;
  /** 宛先・差出人の各項目の文字サイズ・太字・位置(省略時は標準) */
  blocks?: EnvelopeBlocks;
  /** 自由に入力するテキスト(すべての封筒に印刷) */
  freeTexts?: EnvelopeFreeText[];
  /** 宛先(1件につき1ページ)。郵便番号・住所・氏名などを改行で区切った複数行の文字 */
  recipients: string[];
  /** 差出人(複数行)。印刷しないときは null */
  sender: string | null;
}

export interface EnvelopeAddressOutput {
  blob: Blob;
  pageCount: number;
}

const MAX_RECIPIENTS = 300;

function validSize(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= MIN_FONT_PT && value <= MAX_FONT_PT);
}

export function validateEnvelopeAddressInput(input: EnvelopeAddressInput): string | null {
  const valid = input.recipients.filter((r) => !isTextEmpty(r));
  if (valid.length === 0) {
    return "宛先を1件以上入力してください";
  }
  if (valid.length > MAX_RECIPIENTS) {
    return `宛先が多すぎます（最大${MAX_RECIPIENTS}件まで）`;
  }
  const blocks = input.blocks ?? defaultBlocks();
  const sizes = [...ENVELOPE_BLOCK_IDS.map((id) => blocks[id].size), ...(input.freeTexts ?? []).map((f) => f.size)];
  if (sizes.some((v) => !validSize(v))) {
    return `文字サイズは${MIN_FONT_PT}〜${MAX_FONT_PT}ptの範囲で指定してください`;
  }
  const inPct = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 100);
  const positions = [...ENVELOPE_BLOCK_IDS.flatMap((id) => [blocks[id].x, blocks[id].y]), ...(input.freeTexts ?? []).flatMap((f) => [f.x, f.y])];
  if (!positions.every(inPct)) return "位置は0〜100%の範囲で指定してください";
  return null;
}

export class EnvelopeAddressProcessor extends BrowserProcessor<EnvelopeAddressInput, EnvelopeAddressOutput> {
  async process(input: EnvelopeAddressInput): Promise<EnvelopeAddressOutput> {
    const validationError = validateEnvelopeAddressInput(input);
    if (validationError) throw new Error(validationError);

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    const { width, height } = resolveEnvelopePageSizePt(input.envelopeSize, input.orientation ?? "landscape");
    const recipients = input.recipients.filter((r) => !isTextEmpty(r));
    const measure = (t: string, size: number) => font.widthOfTextAtSize(t, size);

    for (const recipient of recipients) {
      const page = doc.addPage([width, height]);
      const ops = layoutEnvelope(
        {
          width,
          height,
          writingMode: input.writingMode,
          honorific: input.honorific ?? "sama",
          blocks: input.blocks ?? defaultBlocks(),
          freeTexts: input.freeTexts ?? [],
          recipient,
          sender: input.sender,
        },
        measure
      );
      for (const op of ops) {
        const w = font.widthOfTextAtSize(op.text, op.size);
        const x = op.align === "center" ? op.x - w / 2 : op.x;
        const color = rgb(...op.color);
        if (op.bold) {
          // 太字専用のフォントが無いため、塗り＋縁取りで疑似的に太くする
          page.pushOperators(
            setLineWidth(op.size * 0.028),
            setStrokingRgbColor(color.red, color.green, color.blue),
            setTextRenderingMode(TextRenderingMode.FillAndOutline)
          );
        }
        page.drawText(op.text, { x, y: height - op.y, size: op.size, font, color });
        if (op.bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, pageCount: doc.getPageCount() };
  }
}

export function buildEnvelopeFileName(size: EnvelopeSizeId): string {
  const label = size === "chou3" ? "長形3号" : size === "chou4" ? "長形4号" : "角形2号";
  return sanitizeFileName(`封筒宛名_${label}.pdf`);
}

export { ENVELOPE_SIZES_MM };
