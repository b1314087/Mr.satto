import { normalizeExtractedText, type PdfjsPage, type PositionedTextItem } from "./pdfjs-client";

/**
 * PDFの入力フォーム（AcroForm の入力欄・チェックボックス・ラジオボタン・選択欄）に入っている値を読み取る（工程4）。
 *
 * 入力欄に記入したPDF（フォームを平坦化していないもの）は、記入した文字がページの文字情報（テキストレイヤー）に入らず、
 * 入力欄の「値」として持っている。これまでの記入済みPDF→Excelは文字情報だけを読んでいたため、
 * こうしたPDFでは記入内容を読み落としていた（文字情報がないページとしてOCRに回り、読み間違いも起きた）。
 *
 * ここでは、pdf.js の注釈（Widget）から値を取り出し、文字情報と同じ形（PositionedTextItem）にして返す。
 * - テキスト欄：入力された文字（複数行の欄は改行を残す）
 * - チェックボックス：チェックありは「☑」、なしは「☐」
 * - ラジオボタン：選ばれているボタンは「☑」、それ以外は「☐」（どれが選ばれたかを、位置で表の中に残す）
 * - 選択欄（コンボボックス・リスト）：選ばれている項目（複数なら「、」でつなぐ）
 * 値はPDFの中のものをそのまま使い、補ったり推測したりしない。ブラウザの中だけで処理する。
 */

export const FORM_CHECKED_MARK = "☑";
export const FORM_UNCHECKED_MARK = "☐";

/** pdf.js の注釈のうち、ここで使う項目 */
export interface WidgetAnnotationLike {
  subtype?: string;
  fieldType?: string;
  fieldValue?: unknown;
  rect?: number[];
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: unknown;
  buttonValue?: unknown;
  multiLine?: boolean;
  hidden?: boolean;
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("、");
  return String(v);
}

/** 1つの注釈の値を、表に入れる文字にする（値がない・読めないときは null） */
export function widgetValueText(a: WidgetAnnotationLike): string | null {
  if (a.subtype !== "Widget" || a.hidden) return null;
  if (a.fieldType === "Btn") {
    if (a.pushButton) return null;
    const value = asText(a.fieldValue);
    if (a.radioButton) {
      const own = asText(a.buttonValue);
      return value !== "" && value !== "Off" && own !== "" && value === own ? FORM_CHECKED_MARK : FORM_UNCHECKED_MARK;
    }
    if (a.checkBox) {
      const exportValue = asText(a.exportValue);
      const checked = value !== "" && value !== "Off" && (exportValue === "" || value === exportValue || value === "Yes" || value === "On");
      return checked ? FORM_CHECKED_MARK : FORM_UNCHECKED_MARK;
    }
    return null;
  }
  if (a.fieldType === "Tx" || a.fieldType === "Ch") {
    const text = normalizeExtractedText(asText(a.fieldValue)).replace(/\r\n?/g, "\n");
    if (text.trim() === "") return null;
    return a.multiLine ? text : text.replace(/\n+/g, " ");
  }
  return null;
}

function estimateTextWidth(text: string, fontHeight: number): number {
  let w = 0;
  for (const ch of text) w += /[\u3000-\u9fff\uf900-\uffef]/.test(ch) ? fontHeight : fontHeight * 0.55;
  return w;
}

/** 注釈の一覧から、値の入った入力欄を、文字情報と同じ形にして返す（テスト用に、PDFを使わない純粋な関数にしている） */
export function widgetsToTextItems(annotations: readonly WidgetAnnotationLike[]): PositionedTextItem[] {
  const items: PositionedTextItem[] = [];
  for (const a of annotations) {
    const text = widgetValueText(a);
    if (text === null || !a.rect || a.rect.length < 4) continue;
    const [x1, y1, x2, y2] = a.rect;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const bottom = Math.min(y1, y2);
    const top = Math.max(y1, y2);
    const h = Math.max(1, top - bottom);
    const lines = text.split("\n");
    // 1行の欄は欄の高さから文字の大きさを見積もる（複数行の欄は、行の数で割る）
    const fontHeight = Math.max(4, Math.min(h * 0.7, (h / Math.max(1, lines.length)) * 0.85));
    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      items.push({
        str: line,
        x: left + 1,
        // 上の行から順に、欄の中に置く（ベースラインの位置）
        y: top - fontHeight * (i + 1) * 1.15,
        // 文字の幅は、欄の幅ではなく文字数から見積もる（欄の幅のままだと、表の列の区切りを見誤るため）
        width: Math.max(1, Math.min(right - left - 2, estimateTextWidth(line, fontHeight))),
        height: fontHeight,
        fontHeight,
        hasEOL: true,
      });
    });
  }
  return items;
}

/** ページの入力欄の値を、文字情報と同じ形で読み取る（入力欄がない・読めないときは空の配列） */
export async function getFormFieldItems(page: PdfjsPage): Promise<PositionedTextItem[]> {
  try {
    const annotations = (await page.getAnnotations({ intent: "display" })) as WidgetAnnotationLike[];
    return widgetsToTextItems(annotations);
  } catch {
    return [];
  }
}
