/**
 * 見積書・注文書一体型(1枚のA4の上半分が見積書、下半分が注文書)のレイアウト計算。
 *
 * 1回の入力(宛先・発行者・明細など)から、両方の書類を1枚に並べる。
 * このファイルはPDFにも画面のプレビューにも依存せず、「どこに何を描くか」の図形(Op)の一覧を返す。
 * PDF生成(quote-order-pdf.ts)とプレビュー(quote-order-preview.tsx)が同じ一覧を使うことで、
 * プレビューと出力が同じ配置になる。文字の幅の測り方(measure)だけは呼び出し側が渡す
 * (PDFは埋め込みフォントの実測、プレビューは近似)。
 *
 * 座標は用紙の左上を原点とし、単位はpt。yは下向きに増える。
 */
import { computeDocumentTotals, formatYen, parseLineItem } from "./calc";
import { isPartyEmpty, type DocumentFormState, type ParsedLineItem, type PartyInfo } from "./types";

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const SIDE_MARGIN = 34;
export const CONTENT_W = PAGE_W - SIDE_MARGIN * 2;
export const HALF_H = PAGE_H / 2;

const COLOR_TEXT: Rgb = [0.13, 0.13, 0.15];
const COLOR_MUTED: Rgb = [0.4, 0.4, 0.43];
const COLOR_LINE: Rgb = [0.78, 0.78, 0.8];
const COLOR_HEADER_BG: Rgb = [0.93, 0.94, 0.96];

export type Rgb = [number, number, number];

export type Op =
  | { kind: "text"; x: number; y: number; size: number; text: string; align: "left" | "right" | "center"; color: Rgb }
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: Rgb; stroke?: Rgb }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; color: Rgb; dashed?: boolean };

export type MeasureFn = (text: string, size: number) => number;

export interface QuoteOrderExtra {
  /** 注文書に入れる納期(任意の文字。例: 2026年11月30日 / 受注後2週間) */
  deliveryDate: string;
}

export interface QuoteOrderLayout {
  ops: Op[];
  /** 見積書(上)・注文書(下)が、それぞれの半分の用紙に収まらなかったか */
  overflow: { quote: boolean; order: boolean };
  /** 明細の行数(空行を除く) */
  itemCount: number;
}

const FONT = { title: 17, body: 8.5, small: 8, name: 9.5, party: 11 };
const LINE_H = 11;

// 明細表の列(幅の合計 = CONTENT_W)
const COL_NAME_W = 215;
const COL_QTY_W = 40;
const COL_UNIT_W = 40;
const COL_PRICE_W = 110;
const COL_AMOUNT_W = CONTENT_W - COL_NAME_W - COL_QTY_W - COL_UNIT_W - COL_PRICE_W;
const COL_NAME_X = SIDE_MARGIN;
const COL_QTY_X = COL_NAME_X + COL_NAME_W;
const COL_UNIT_X = COL_QTY_X + COL_QTY_W;
const COL_PRICE_X = COL_UNIT_X + COL_UNIT_W;
const COL_AMOUNT_X = COL_PRICE_X + COL_PRICE_W;

/** 幅に収まるよう、1文字ずつ測って折り返す(日本語は単語の区切りがないため) */
export function wrapByMeasure(text: string, size: number, maxWidth: number, measure: MeasureFn): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && measure(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

interface Line {
  text: string;
  size: number;
  color: Rgb;
  /** 行の高さ(省略時は LINE_H) */
  height?: number;
}

function partyAddressLines(party: PartyInfo, maxWidth: number, measure: MeasureFn, maxLines = 2): Line[] {
  const addr = [party.postalCode ? `〒${party.postalCode}` : "", party.address].filter(Boolean).join(" ");
  if (addr.trim() === "") return [];
  return wrapByMeasure(addr, FONT.small, maxWidth, measure)
    .filter((l) => l !== "")
    .slice(0, maxLines)
    .map((text) => ({ text, size: FONT.small, color: COLOR_MUTED }));
}

function partyName(party: PartyInfo, fallback: string): string {
  return party.companyName.trim() || party.contactName.trim() || fallback;
}

function partyDetailLines(party: PartyInfo, maxWidth: number, measure: MeasureFn): Line[] {
  const lines: Line[] = [];
  if (party.companyName.trim() && party.contactName.trim()) {
    lines.push({ text: party.contactName, size: FONT.small, color: COLOR_MUTED });
  }
  lines.push(...partyAddressLines(party, maxWidth, measure));
  const contact = [party.tel.trim() ? `TEL: ${party.tel}` : "", party.email.trim()].filter(Boolean).join("  ");
  if (contact) lines.push({ text: contact, size: FONT.small, color: COLOR_MUTED });
  return lines;
}

/**
 * 見積書・注文書一体型のレイアウトを作る。
 * form は見積書の入力(宛先=お客様、発行者=自社)をそのまま使う。注文書側は、宛先を自社(発行者)、
 * 注文者を元の宛先(お客様)に入れ替えて作る。入力内容の検証(必須項目など)は呼び出し側で済ませておく。
 */
export function layoutQuoteOrder(form: DocumentFormState, extra: QuoteOrderExtra, measure: MeasureFn): QuoteOrderLayout {
  const items: ParsedLineItem[] = form.items
    .filter((item) => !(item.name.trim() === "" && item.unitPrice.trim() === ""))
    .map(parseLineItem);
  const totals = computeDocumentTotals(items, form.taxRatePercent, form.taxRounding);
  const ops: Op[] = [];
  const overflow = { quote: false, order: false };

  const text = (x: number, y: number, size: number, value: string, align: "left" | "right" | "center" = "left", color: Rgb = COLOR_TEXT) =>
    ops.push({ kind: "text", x, y, size, text: value, align, color });

  /** 半分の用紙(top〜top+HALF_H)に、1つの書類を描く */
  function drawHalf(kind: "quote" | "order", top: number): void {
    const bottomLimit = top + HALF_H - 14;
    let y = top + 34;

    // タイトル
    const title = kind === "quote" ? form.title.trim() || "見積書" : "注文書";
    text(PAGE_W / 2, y, FONT.title, title, "center");
    y += 14;

    // 宛先・発行者などの情報(左右2列)
    const left: Line[] = [];
    const right: Line[] = [];
    const rightX = PAGE_W - SIDE_MARGIN;
    const leftMax = 250;
    const rightMax = 230;
    const date = form.issueDate;

    if (kind === "quote") {
      left.push({ text: `${partyName(form.recipient, "お客様")} 御中`, size: FONT.party, color: COLOR_TEXT, height: 15 });
      left.push(...partyDetailLines(form.recipient, leftMax, measure));
      left.push({ text: "下記のとおり、お見積り申し上げます。", size: FONT.body, color: COLOR_TEXT, height: 14 });
      right.push({ text: `見積番号: ${form.documentNumber}`, size: FONT.body, color: COLOR_TEXT });
      right.push({ text: `発行日: ${date}`, size: FONT.body, color: COLOR_TEXT });
      if (form.secondaryDate.trim()) right.push({ text: `有効期限: ${form.secondaryDate}`, size: FONT.body, color: COLOR_TEXT });
      if (!isPartyEmpty(form.issuer)) {
        right.push({ text: partyName(form.issuer, ""), size: FONT.name, color: COLOR_TEXT, height: 14 });
        right.push(...partyDetailLines(form.issuer, rightMax, measure));
      }
    } else {
      left.push({ text: `${partyName(form.issuer, "御社")} 御中`, size: FONT.party, color: COLOR_TEXT, height: 15 });
      left.push({ text: "下記のとおり、注文いたします。", size: FONT.body, color: COLOR_TEXT, height: 14 });
      left.push({ text: `見積番号: ${form.documentNumber}`, size: FONT.body, color: COLOR_TEXT });
      if (extra.deliveryDate.trim()) left.push({ text: `納期: ${extra.deliveryDate.trim()}`, size: FONT.body, color: COLOR_TEXT });
      right.push({ text: "注文日:　　　　年　　月　　日", size: FONT.body, color: COLOR_TEXT, height: 15 });
      right.push({ text: "注文者", size: FONT.small, color: COLOR_MUTED });
      right.push({ text: partyName(form.recipient, "お客様"), size: FONT.name, color: COLOR_TEXT, height: 14 });
      right.push(...partyDetailLines(form.recipient, rightMax, measure));
    }

    // 左列を描く
    let leftY = y + 6;
    for (const l of left) {
      leftY += l.height ?? LINE_H;
      text(SIDE_MARGIN, leftY - 3, l.size, l.text, "left", l.color);
    }
    // 注文書の左列の下に、署名・捺印欄
    if (kind === "order") {
      leftY += 6;
      ops.push({ kind: "rect", x: SIDE_MARGIN, y: leftY, w: 170, h: 36, stroke: COLOR_LINE });
      text(SIDE_MARGIN + 5, leftY + 11, FONT.small, "ご署名・ご捺印", "left", COLOR_MUTED);
      leftY += 36;
    }
    // 右列を描く
    let rightY = y + 6;
    for (const r of right) {
      rightY += r.height ?? LINE_H;
      text(rightX, rightY - 3, r.size, r.text, "right", r.color);
    }
    y = Math.max(leftY, rightY) + 8;

    // 合計金額の強調表示
    ops.push({ kind: "rect", x: SIDE_MARGIN, y, w: CONTENT_W, h: 22, fill: COLOR_HEADER_BG });
    text(SIDE_MARGIN + 8, y + 15, 10, "合計金額（税込）");
    text(PAGE_W - SIDE_MARGIN - 8, y + 16, 13, formatYen(totals.total), "right");
    y += 28;

    // 明細表のヘッダー
    ops.push({ kind: "rect", x: SIDE_MARGIN, y, w: CONTENT_W, h: 16, fill: COLOR_HEADER_BG });
    const headerBase = y + 11.5;
    text(COL_NAME_X + 5, headerBase, FONT.small, "品名", "left", COLOR_MUTED);
    text(COL_QTY_X + COL_QTY_W - 5, headerBase, FONT.small, "数量", "right", COLOR_MUTED);
    text(COL_UNIT_X + COL_UNIT_W / 2, headerBase, FONT.small, "単位", "center", COLOR_MUTED);
    text(COL_PRICE_X + COL_PRICE_W - 5, headerBase, FONT.small, "単価", "right", COLOR_MUTED);
    text(COL_AMOUNT_X + COL_AMOUNT_W - 5, headerBase, FONT.small, "金額", "right", COLOR_MUTED);
    y += 16;

    // 備考・小計の分の高さを先に確保し、明細がそこまで入るかを調べる
    const noteLines = form.notes.trim() ? wrapByMeasure(form.notes, FONT.small, CONTENT_W - 36, measure).slice(0, 2) : [];
    const footerH = 18 + (noteLines.length > 0 ? 6 + noteLines.length * 10 : 0);
    let fit = true;
    for (const item of items) {
      const nameLines = wrapByMeasure(item.name || "（品名未入力）", FONT.name - 1, COL_NAME_W - 10, measure);
      const rowH = Math.max(nameLines.length, 1) * 10.5 + 6;
      if (y + rowH + footerH > bottomLimit) {
        fit = false;
        break;
      }
      const base = y + 3 + 8;
      nameLines.forEach((line, idx) => text(COL_NAME_X + 5, base + idx * 10.5, FONT.name - 1, line));
      text(COL_QTY_X + COL_QTY_W - 5, base, FONT.name - 1, String(item.quantity), "right");
      text(COL_UNIT_X + COL_UNIT_W / 2, base, FONT.name - 1, item.unit, "center");
      text(COL_PRICE_X + COL_PRICE_W - 5, base, FONT.name - 1, formatYen(item.unitPrice), "right");
      text(COL_AMOUNT_X + COL_AMOUNT_W - 5, base, FONT.name - 1, formatYen(item.amount), "right");
      y += rowH;
      ops.push({ kind: "line", x1: SIDE_MARGIN, y1: y, x2: SIDE_MARGIN + CONTENT_W, y2: y, color: COLOR_LINE });
    }
    if (!fit) {
      overflow[kind] = true;
      return;
    }

    // 小計・消費税・合計(1行)
    y += 13;
    text(
      PAGE_W - SIDE_MARGIN,
      y,
      FONT.body,
      `小計 ${formatYen(totals.subtotal)}　消費税（${form.taxRatePercent}%） ${formatYen(totals.tax)}　合計 ${formatYen(totals.total)}`,
      "right"
    );
    y += 5;
    if (noteLines.length > 0) {
      y += 6;
      text(SIDE_MARGIN, y + 4, FONT.small, `備考: ${noteLines[0]}`, "left", COLOR_MUTED);
      for (let i = 1; i < noteLines.length; i++) text(SIDE_MARGIN + 22, y + 4 + i * 10, FONT.small, noteLines[i], "left", COLOR_MUTED);
    }
  }

  drawHalf("quote", 0);
  drawHalf("order", HALF_H);

  // 切り取り線(用紙の真ん中)
  ops.push({ kind: "line", x1: SIDE_MARGIN - 10, y1: HALF_H, x2: PAGE_W - SIDE_MARGIN + 10, y2: HALF_H, color: COLOR_MUTED, dashed: true });
  const cutLabel = "キリトリ線";
  const cutW = measure(cutLabel, FONT.small) + 10;
  ops.push({ kind: "rect", x: PAGE_W / 2 - cutW / 2, y: HALF_H - 6, w: cutW, h: 12, fill: [1, 1, 1] });
  text(PAGE_W / 2, HALF_H + 3, FONT.small, cutLabel, "center", COLOR_MUTED);

  return { ops, overflow, itemCount: items.length };
}

/** 「1枚に収まらない」ときのエラーメッセージ */
export function overflowMessage(layout: QuoteOrderLayout): string | null {
  if (!layout.overflow.quote && !layout.overflow.order) return null;
  return `明細が多すぎて、1枚（上が見積書・下が注文書）に収まりません。明細の行数を減らす、品名を短くする、備考を短くするなど調整してください（現在${layout.itemCount}行）。明細が多いときは、「見積書作成」「注文書作成」を別々にお使いください。`;
}
