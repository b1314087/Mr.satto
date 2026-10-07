/**
 * 整理券・金券・引換券の「券のデータ」と「1枚ぶんの配置」の計算（PDFとプレビューで共通）。
 *
 * - 券のデータ: 手入力の「券の種類」（タイトル・日付・金額・補足・開始番号〜終了番号）と、
 *   Excelから読み込んだ行（1行=1枚）のどちらからでも、同じ形の一覧(TicketData[])を作る。
 * - 配置: 1枚の券の中に、文字・連番・二次元コード・バーコードをどこにどの大きさで置くかを、
 *   図形(Op)の一覧として返す。PDF生成(ticket-voucher.ts)とプレビュー(ticket-preview.tsx)が
 *   同じ一覧を使うので、画面と出力が食い違わない。
 *
 * 座標は券の左上を原点とし、単位はpt。yは下向きに増える。
 */
import { mmToPt } from "@/lib/print/paper-sizes";

export type Rgb = [number, number, number];

/** コードを置く場所 */
export type CodePlacement =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "center"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";

export const PLACEMENT_LABELS: Record<CodePlacement, string> = {
  topLeft: "左上",
  topCenter: "上（中央）",
  topRight: "右上",
  center: "中央",
  bottomLeft: "左下",
  bottomCenter: "下（中央）",
  bottomRight: "右下",
};
export const PLACEMENT_IDS = Object.keys(PLACEMENT_LABELS) as CodePlacement[];

/** 手入力の「券の種類」。開始番号〜終了番号の枚数ぶんの券ができる */
export interface TicketGroup {
  title: string;
  date: string;
  amount: string;
  freeText: string;
  serialStart: number;
  serialEnd: number;
}

/** Excelから読み込んだ1行（=1枚）。空欄の項目は共通設定ではなく空のまま扱う */
export interface TicketRow {
  title: string;
  date: string;
  amount: string;
  freeText: string;
  /** 連番として表示する文字（空なら開始番号からの自動連番） */
  serial: string;
  /** 二次元コードの内容（空なら共通の内容テンプレートを使う） */
  qrContent: string;
  /** バーコードの内容（空なら共通の内容テンプレートを使う） */
  barcodeContent: string;
  /** Excelの列名→値。内容テンプレートの {列名} で使える */
  vars: Record<string, string>;
}

export interface TicketCodeSettings {
  showQr: boolean;
  /** 二次元コードの内容テンプレート。{n}=連番、{title}・{date}・{amount}・{text}、Excelの{列名}が使える */
  qrContent: string;
  qrPlacement: CodePlacement;
  /** 一辺の長さ(mm)。null=券の大きさに合わせて自動 */
  qrSizeMm: number | null;
  showBarcode: boolean;
  barcodeContent: string;
  barcodePlacement: CodePlacement;
  /** バーコードの幅・高さ(mm)。null=自動 */
  barcodeWidthMm: number | null;
  barcodeHeightMm: number | null;
}

export const DEFAULT_CODE_SETTINGS: TicketCodeSettings = {
  showQr: false,
  qrContent: "{n}",
  qrPlacement: "topRight",
  qrSizeMm: null,
  showBarcode: false,
  barcodeContent: "{n}",
  barcodePlacement: "bottomCenter",
  barcodeWidthMm: null,
  barcodeHeightMm: null,
};

export function emptyGroup(partial: Partial<TicketGroup> = {}): TicketGroup {
  return { title: "整理券", date: "", amount: "", freeText: "", serialStart: 1, serialEnd: 10, ...partial };
}

/** 1枚ぶんの、最終的な表示内容 */
export interface TicketData {
  title: string;
  date: string;
  amount: string;
  freeText: string;
  /** 表示する連番の文字（連番を表示しないときも、{n}の置き換えに使う） */
  serialText: string;
  qrContent: string;
  barcodeContent: string;
}

export const MAX_TICKETS = 2000;

export function padSerial(serial: number | string, digits: number): string {
  return String(serial).padStart(Math.max(1, digits), "0");
}

/** 内容テンプレートの {n}・{title}・{date}・{amount}・{text}・{列名} を、その券の値に置き換える */
export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

export interface TicketBuildInput {
  groups: TicketGroup[];
  /** Excelの行。1件以上あるときは、手入力の券の種類のかわりにこちらを使う */
  rows: TicketRow[] | null;
  /** Excelの行を使うときの、連番の開始番号 */
  rowsSerialStart: number;
  serialDigits: number;
  codes: TicketCodeSettings;
}

/** 手入力の券の種類・Excelの行から、券を1枚ずつ並べた一覧を作る */
export function buildTickets(input: TicketBuildInput): TicketData[] {
  const { groups, rows, rowsSerialStart, serialDigits, codes } = input;
  const out: TicketData[] = [];
  const make = (
    base: { title: string; date: string; amount: string; freeText: string },
    serialText: string,
    extraVars: Record<string, string>,
    qrOverride: string,
    barcodeOverride: string
  ) => {
    const vars: Record<string, string> = {
      ...extraVars,
      n: serialText,
      title: base.title,
      date: base.date,
      amount: base.amount,
      text: base.freeText,
    };
    out.push({
      ...base,
      serialText,
      qrContent: applyTemplate(qrOverride || codes.qrContent || "{n}", vars),
      barcodeContent: applyTemplate(barcodeOverride || codes.barcodeContent || "{n}", vars),
    });
  };

  if (rows && rows.length > 0) {
    rows.forEach((row, i) => {
      const serialText = row.serial.trim() !== "" ? row.serial.trim() : padSerial(rowsSerialStart + i, serialDigits);
      make(row, serialText, row.vars, row.qrContent, row.barcodeContent);
    });
    return out;
  }
  for (const g of groups) {
    for (let n = g.serialStart; n <= g.serialEnd; n++) {
      make(g, padSerial(n, serialDigits), {}, "", "");
      if (out.length > MAX_TICKETS + 1) return out;
    }
  }
  return out;
}

/** バーコード(CODE128)で表せるのは半角の英数字・記号のみ */
export function isBarcodeSafe(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

export interface TicketValidateInput extends TicketBuildInput {
  cellWidthMm: number;
  cellHeightMm: number;
  marginMm: number;
  gapMm: number;
}

/** 入力の検証。問題があれば日本語のメッセージ1件を返す */
export function validateTicketInput(input: TicketValidateInput): string | null {
  if (!(input.cellWidthMm > 0) || !(input.cellHeightMm > 0)) {
    return "1枚あたりのサイズは0より大きい値を指定してください";
  }
  if (input.marginMm < 0 || input.gapMm < 0) {
    return "余白・間隔にマイナスの値は指定できません";
  }
  const usingRows = input.rows !== null && input.rows.length > 0;
  if (!usingRows) {
    for (let i = 0; i < input.groups.length; i++) {
      const g = input.groups[i];
      const label = input.groups.length > 1 ? `券の種類${i + 1}の` : "";
      if (!Number.isInteger(g.serialStart) || !Number.isInteger(g.serialEnd)) {
        return `${label}開始番号・終了番号は整数で指定してください`;
      }
      if (g.serialStart < 0) return `${label}開始番号は0以上で指定してください`;
      if (g.serialEnd < g.serialStart) return `${label}終了番号は開始番号以上にしてください`;
    }
  } else if (!Number.isInteger(input.rowsSerialStart) || input.rowsSerialStart < 0) {
    return "開始番号は0以上の整数で指定してください";
  }
  // 枚数の上限(数え上げは上限+1で打ち切る)
  const tickets = buildTickets(input);
  if (tickets.length === 0) return "券が1枚もありません。開始番号・終了番号を見直してください";
  if (tickets.length > MAX_TICKETS) return `枚数が多すぎます（最大${MAX_TICKETS}枚まで）`;
  if (input.codes.showBarcode) {
    const bad = tickets.findIndex((t) => !isBarcodeSafe(t.barcodeContent));
    if (bad >= 0) {
      return `バーコードの内容は半角の英数字・記号のみ使えます（${bad + 1}枚目: 「${tickets[bad].barcodeContent}」）。日本語を入れたいときは二次元コードをお使いください`;
    }
  }
  if (input.codes.showQr) {
    const bad = tickets.findIndex((t) => t.qrContent === "");
    if (bad >= 0) return `二次元コードの内容が空です（${bad + 1}枚目）`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1枚ぶんの配置
// ---------------------------------------------------------------------------

export type TicketOp =
  | { kind: "text"; x: number; y: number; size: number; text: string; color: Rgb }
  | { kind: "cutRect"; x: number; y: number; w: number; h: number }
  | { kind: "qr"; x: number; y: number; size: number; content: string }
  | { kind: "barcode"; x: number; y: number; w: number; h: number; content: string };

export type MeasureFn = (text: string, size: number) => number;

const COLOR_TEXT: Rgb = [0.13, 0.13, 0.15];
const COLOR_MUTED: Rgb = [0.45, 0.45, 0.48];

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

/** 指定の場所・大きさの箱を、券(w×h)の中に置く左上座標を返す */
export function placeBox(placement: CodePlacement, w: number, h: number, pad: number, boxW: number, boxH: number): { x: number; y: number } {
  const left = pad;
  const centerX = (w - boxW) / 2;
  const right = w - pad - boxW;
  const top = pad;
  const centerY = (h - boxH) / 2;
  const bottom = h - pad - boxH;
  switch (placement) {
    case "topLeft":
      return { x: left, y: top };
    case "topCenter":
      return { x: centerX, y: top };
    case "topRight":
      return { x: right, y: top };
    case "center":
      return { x: centerX, y: centerY };
    case "bottomLeft":
      return { x: left, y: bottom };
    case "bottomCenter":
      return { x: centerX, y: bottom };
    case "bottomRight":
      return { x: right, y: bottom };
  }
}

export interface CodeBoxes {
  qr: { x: number; y: number; size: number } | null;
  barcode: { x: number; y: number; w: number; h: number } | null;
}

/** 二次元コード・バーコードを置く位置と大きさ(券の左上が原点)。券からはみ出さないよう収める */
export function computeCodeBoxes(w: number, h: number, codes: TicketCodeSettings): CodeBoxes {
  const pad = Math.min(w, h) * 0.06;
  const maxSide = Math.max(0, Math.min(w, h) - pad * 2);
  let qr: CodeBoxes["qr"] = null;
  if (codes.showQr) {
    const auto = Math.min(w, h) * 0.28;
    const size = Math.min(maxSide, codes.qrSizeMm && codes.qrSizeMm > 0 ? mmToPt(codes.qrSizeMm) : auto);
    if (size > 8) {
      const pos = placeBox(codes.qrPlacement, w, h, pad, size, size);
      qr = { ...pos, size };
    }
  }
  let barcode: CodeBoxes["barcode"] = null;
  if (codes.showBarcode && w > mmToPt(20)) {
    const wide = codes.barcodePlacement === "topCenter" || codes.barcodePlacement === "bottomCenter";
    const autoW = wide ? w - pad * 2 : (w - pad * 2) * 0.55;
    const bw = Math.min(w - pad * 2, codes.barcodeWidthMm && codes.barcodeWidthMm > 0 ? mmToPt(codes.barcodeWidthMm) : autoW);
    const autoH = Math.min(h * 0.18, 28);
    const bh = Math.min(h - pad * 2, codes.barcodeHeightMm && codes.barcodeHeightMm > 0 ? mmToPt(codes.barcodeHeightMm) : autoH);
    if (bw > 4 && bh > 4) {
      const pos = placeBox(codes.barcodePlacement, w, h, pad, bw, bh);
      barcode = { ...pos, w: bw, h: bh };
    }
  }
  return { qr, barcode };
}

export interface TicketLayoutInput {
  /** 券のサイズ(pt) */
  w: number;
  h: number;
  showSerial: boolean;
  showCutLines: boolean;
  codes: TicketCodeSettings;
  ticket: TicketData;
}

/** 1枚の券(左上が原点)の中身の図形一覧 */
export function layoutTicket(input: TicketLayoutInput, measure: MeasureFn): TicketOp[] {
  const { w, h, ticket, codes } = input;
  const ops: TicketOp[] = [];
  const pad = Math.min(w, h) * 0.06;
  if (input.showCutLines) ops.push({ kind: "cutRect", x: 0, y: 0, w, h });

  const boxes = computeCodeBoxes(w, h, codes);
  // 文字は左上から順に積む。二次元コードが上の角にあるときは、そこに文字がかからないよう幅(または左端)を空ける
  let textLeft = pad;
  let textRight = w - pad;
  if (boxes.qr && boxes.qr.y < h / 2 && boxes.qr.size < w - pad * 2 - 20) {
    if (boxes.qr.x > w / 2) textRight = Math.min(textRight, boxes.qr.x - 4);
    else if (boxes.qr.x + boxes.qr.size < w / 2) textLeft = Math.max(textLeft, boxes.qr.x + boxes.qr.size + 4);
  }
  const maxW = Math.max(10, textRight - textLeft);

  let y = pad + 10;
  if (ticket.title.trim()) {
    for (const line of wrapByMeasure(ticket.title, 12, maxW, measure).slice(0, 2)) {
      ops.push({ kind: "text", x: textLeft, y, size: 12, text: line, color: COLOR_TEXT });
      y += 15;
    }
  }
  if (ticket.date.trim()) {
    ops.push({ kind: "text", x: textLeft, y, size: 8, text: ticket.date, color: COLOR_MUTED });
    y += 12;
  }
  if (ticket.amount.trim()) {
    ops.push({ kind: "text", x: textLeft, y, size: 16, text: ticket.amount, color: COLOR_TEXT });
    y += 20;
  }
  if (ticket.freeText.trim()) {
    for (const line of wrapByMeasure(ticket.freeText, 8, maxW, measure).slice(0, 3)) {
      ops.push({ kind: "text", x: textLeft, y, size: 8, text: line, color: COLOR_MUTED });
      y += 11;
    }
  }
  if (input.showSerial) {
    // 下側にバーコードがあるときは、その上に連番を置く(重ならないように)
    let baseline = h - pad - 8;
    if (boxes.barcode && boxes.barcode.y > h / 2) baseline = Math.min(baseline, boxes.barcode.y - 4);
    ops.push({ kind: "text", x: pad, y: baseline, size: 8, text: `No. ${ticket.serialText}`, color: COLOR_MUTED });
  }
  if (boxes.qr) ops.push({ kind: "qr", x: boxes.qr.x, y: boxes.qr.y, size: boxes.qr.size, content: ticket.qrContent });
  if (boxes.barcode) {
    ops.push({ kind: "barcode", x: boxes.barcode.x, y: boxes.barcode.y, w: boxes.barcode.w, h: boxes.barcode.h, content: ticket.barcodeContent });
  }
  return ops;
}
