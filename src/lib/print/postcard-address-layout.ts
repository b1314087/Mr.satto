import { mmToPt } from "./paper-sizes";
import { HONORIFIC_LABELS, type EnvelopeHonorific } from "./envelope-layout";

/**
 * ハガキ作成・宛名面（総合改修 28）の配置の計算。画面のプレビュー（SVG）とPDFの書き出しで同じ計算を使う。
 *
 * - 宛名面は、はがき（100mm × 148mm）の縦向き・縦書き。座標は、はがきの左上を原点にしたpt（yは下向き）。
 * - 宛先の郵便番号枠の位置は、日本郵便「郵便番号・バーコードマニュアル」の定形郵便物の様式
 *   （上端から記入枠まで12.0mm、右端から記入枠まで8.0mm。枠線の内側で測る）に合わせ、
 *   枠の大きさは 5.7mm × 8.0mm、上3けたは7.0mm間隔・下4けたは6.8mm間隔・3けた目と4けた目の間はハイフンの2.0mm。
 *   郵便番号の数字は、この枠の中央に1けたずつ入れる（枠が印刷済みのはがきにも、そのまま入る）。
 * - 宛先住所・宛先氏名・差出人は縦書き。位置（x：いちばん右の列の中心、y：上端）は、はがきの幅・高さに対する割合（0〜100%）。
 *   改行すると次の列（左）に移る。列が下まで埋まったときも左の列へ折り返す。数字は全角に、数字の間の「-」は縦の線「｜」にする。
 * - 印刷位置の微調整（mm）は、プリンターごとのずれを直すため、すべての文字と枠を同じだけ動かす。
 */

export const POSTCARD_W_MM = 100;
export const POSTCARD_H_MM = 148;

/** 宛先の郵便番号枠（mm。枠線の内側の四角）。左から7けた分 */
export const RECIPIENT_ZIP_BOX_MM = { top: 12, width: 5.7, height: 8 } as const;
export const RECIPIENT_ZIP_BOX_LEFTS_MM: readonly number[] = (() => {
  const right = POSTCARD_W_MM - 8; // 右端から8.0mm
  const w = RECIPIENT_ZIP_BOX_MM.width;
  const lower = [3, 2, 1, 0].map((i) => right - w - i * 6.8); // 下4けた（4けた目〜7けた目）
  const thirdLeft = lower[0] - 2 - w; // ハイフンの分（2.0mm）
  const upper = [2, 1, 0].map((i) => thirdLeft - i * 7.0);
  return [...upper, ...lower].map((v) => Math.round(v * 100) / 100);
})();

export type PostcardAddressBlockId = "address" | "name" | "sender";

export const POSTCARD_ADDRESS_BLOCK_IDS: PostcardAddressBlockId[] = ["address", "name", "sender"];

export const POSTCARD_ADDRESS_BLOCK_LABELS: Record<PostcardAddressBlockId, string> = {
  address: "宛先の住所",
  name: "宛先の氏名",
  sender: "差出人",
};

export interface PostcardAddressBlock {
  /** 文字の大きさ（pt） */
  size: number;
  /** いちばん右の列の中心（はがきの幅に対する%） */
  x: number;
  /** 上端（はがきの高さに対する%） */
  y: number;
}

/** 標準の文字の大きさ・位置 */
export const DEFAULT_POSTCARD_ADDRESS_BLOCKS: Record<PostcardAddressBlockId, PostcardAddressBlock> = {
  address: { size: 13, x: 86, y: 19 }, // 右側（郵便番号枠の下）
  name: { size: 24, x: 50, y: 25 }, // 中央
  sender: { size: 9, x: 24, y: 55 }, // 左下
};

export const POSTCARD_ADDRESS_MIN_PT = 6;
export const POSTCARD_ADDRESS_MAX_PT = 40;
export const POSTCARD_OFFSET_MAX_MM = 5;

export interface PostcardAddressInput {
  recipientZip: string;
  recipientAddress: string;
  recipientName: string;
  honorific: EnvelopeHonorific;
  useSender: boolean;
  senderZip: string;
  senderAddress: string;
  senderName: string;
  /** 郵便番号枠の線も印刷する（枠が印刷されていない用紙のとき） */
  printZipFrames: boolean;
  blocks: Record<PostcardAddressBlockId, PostcardAddressBlock>;
  /** 印刷位置の微調整（mm。右・下が＋） */
  offsetXmm: number;
  offsetYmm: number;
}

/** Excel・CSVから読み込んだ、1件分の宛先 */
export interface PostcardRecipient {
  zip: string;
  address: string;
  name: string;
  /** 敬称（列が無いときは、画面で選んだ敬称を使う） */
  honorific?: EnvelopeHonorific;
}

/** 画面の設定（差出人・位置など）に、1件分の宛先を当てはめる */
export function applyRecipient(base: PostcardAddressInput, r: PostcardRecipient): PostcardAddressInput {
  return { ...base, recipientZip: r.zip, recipientAddress: r.address, recipientName: r.name, honorific: r.honorific ?? base.honorific };
}

export function defaultPostcardAddress(): PostcardAddressInput {
  return {
    recipientZip: "",
    recipientAddress: "",
    recipientName: "",
    honorific: "sama",
    useSender: false,
    senderZip: "",
    senderAddress: "",
    senderName: "",
    printZipFrames: false,
    blocks: {
      address: { ...DEFAULT_POSTCARD_ADDRESS_BLOCKS.address },
      name: { ...DEFAULT_POSTCARD_ADDRESS_BLOCKS.name },
      sender: { ...DEFAULT_POSTCARD_ADDRESS_BLOCKS.sender },
    },
    offsetXmm: 0,
    offsetYmm: 0,
  };
}

export type PostcardAddressOp =
  | { kind: "text"; x: number; y: number; size: number; text: string; role: "zip" | PostcardAddressBlockId | "sender-zip" }
  | { kind: "rect"; x: number; y: number; width: number; height: number; lineWidth: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; lineWidth: number };

/** 郵便番号の入力を数字だけにする（全角・ハイフン・〒・空白を取り除く） */
export function zipDigits(input: string): string {
  return input.normalize("NFKC").replace(/[〒\s\-ー－‐―−]/g, "");
}

/** 縦書き用に文字を整える：数字・英字を全角に、数字の間のハイフン類を「｜」に */
export function toVerticalText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(\d)\s*[-‐―−ー－]\s*(?=\d)/g, "$1｜")
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, "　");
}

/** 縦書きの行（1文字分）の高さ・列の間隔（文字の大きさに対する倍率） */
const V_LINE = 1.15;
const V_COL_GAP = 1.6;

/** 縦書きの列に分ける（改行で次の列。列が下まで埋まったら次の列） */
export function verticalColumns(text: string, size: number, maxHeight: number): string[][] {
  const perColumn = Math.max(1, Math.floor(maxHeight / (size * V_LINE)));
  const columns: string[][] = [];
  for (const paragraph of toVerticalText(text).split(/\r\n|\r|\n/)) {
    const chars = Array.from(paragraph.trim());
    if (chars.length === 0) continue;
    for (let i = 0; i < chars.length; i += perColumn) columns.push(chars.slice(i, i + perColumn));
  }
  return columns;
}

function pushVertical(
  ops: PostcardAddressOp[],
  columns: string[][],
  startX: number,
  topY: number,
  size: number,
  role: PostcardAddressBlockId,
  colGap = size * V_COL_GAP
): void {
  const line = size * V_LINE;
  columns.forEach((chars, col) => {
    chars.forEach((ch, row) => {
      // ベースライン：1文字分の枠の中で、文字が上下の中央に来る位置
      ops.push({ kind: "text", x: startX - col * colGap, y: topY + row * line + (line - size) / 2 + size * 0.88, size, text: ch, role });
    });
  });
}

export function postcardAddressSizePt(): { width: number; height: number } {
  return { width: mmToPt(POSTCARD_W_MM), height: mmToPt(POSTCARD_H_MM) };
}

/** 入力の確かめ（問題があれば日本語のメッセージ） */
export function validatePostcardAddress(a: PostcardAddressInput): string | null {
  const zip = zipDigits(a.recipientZip);
  if (a.recipientAddress.trim() === "" && a.recipientName.trim() === "") return "宛先の住所か氏名を入れてください。";
  if (zip !== "" && !/^\d{7}$/.test(zip)) return "宛先の郵便番号は7けたの数字で入れてください（例：100-0001）。";
  if (a.useSender) {
    const s = zipDigits(a.senderZip);
    if (s !== "" && !/^\d{7}$/.test(s)) return "差出人の郵便番号は7けたの数字で入れてください。";
    if (a.senderAddress.trim() === "" && a.senderName.trim() === "" && s === "") return "差出人を印刷するときは、差出人の住所か氏名を入れてください。";
  }
  for (const id of POSTCARD_ADDRESS_BLOCK_IDS) {
    const b = a.blocks[id];
    if (!Number.isFinite(b.size) || b.size < POSTCARD_ADDRESS_MIN_PT || b.size > POSTCARD_ADDRESS_MAX_PT) {
      return `${POSTCARD_ADDRESS_BLOCK_LABELS[id]}の文字の大きさは${POSTCARD_ADDRESS_MIN_PT}〜${POSTCARD_ADDRESS_MAX_PT}ptの範囲で指定してください。`;
    }
    if (!(b.x >= 0 && b.x <= 100 && b.y >= 0 && b.y <= 100)) return `${POSTCARD_ADDRESS_BLOCK_LABELS[id]}の位置は0〜100%の範囲で指定してください。`;
  }
  if (!(Math.abs(a.offsetXmm) <= POSTCARD_OFFSET_MAX_MM && Math.abs(a.offsetYmm) <= POSTCARD_OFFSET_MAX_MM)) {
    return `印刷位置の微調整は−${POSTCARD_OFFSET_MAX_MM}〜${POSTCARD_OFFSET_MAX_MM}mmの範囲で指定してください。`;
  }
  return null;
}

/** 郵便番号枠の四角（pt。微調整の前） */
export function recipientZipBoxesPt(): { x: number; y: number; width: number; height: number }[] {
  return RECIPIENT_ZIP_BOX_LEFTS_MM.map((left) => ({
    x: mmToPt(left),
    y: mmToPt(RECIPIENT_ZIP_BOX_MM.top),
    width: mmToPt(RECIPIENT_ZIP_BOX_MM.width),
    height: mmToPt(RECIPIENT_ZIP_BOX_MM.height),
  }));
}

/** 宛名面に描くもの（文字・枠）の一覧。x は文字の中心、y はベースライン（pt・上から） */
export function layoutPostcardAddress(a: PostcardAddressInput): PostcardAddressOp[] {
  const page = postcardAddressSizePt();
  const ops: PostcardAddressOp[] = [];
  const bottomLimit = page.height - mmToPt(8);

  // 宛先の郵便番号（枠の中央に1けたずつ）
  const boxes = recipientZipBoxesPt();
  if (a.printZipFrames) {
    boxes.forEach((b, i) => ops.push({ kind: "rect", ...b, lineWidth: mmToPt(i < 3 ? 0.5 : 0.3) }));
    const hy = boxes[0].y + boxes[0].height / 2;
    ops.push({ kind: "line", x1: boxes[2].x + boxes[2].width + mmToPt(0.4), y1: hy, x2: boxes[3].x - mmToPt(0.4), y2: hy, lineWidth: mmToPt(0.5) });
  }
  const zip = zipDigits(a.recipientZip);
  if (/^\d{7}$/.test(zip)) {
    const size = 16;
    Array.from(zip).forEach((d, i) => {
      const b = boxes[i];
      ops.push({ kind: "text", x: b.x + b.width / 2, y: b.y + b.height / 2 + size * 0.36, size, text: d, role: "zip" });
    });
  }

  // 宛先の住所
  const addr = a.blocks.address;
  const addrTop = (addr.y / 100) * page.height;
  pushVertical(ops, verticalColumns(a.recipientAddress, addr.size, bottomLimit - addrTop), (addr.x / 100) * page.width, addrTop, addr.size, "address");

  // 宛先の氏名。敬称は氏名の下に続ける。改行した氏名（連名）は列を分け、それぞれに敬称をつける
  const name = a.blocks.name;
  const nameTop = (name.y / 100) * page.height;
  const label = a.honorific === "none" ? "" : HONORIFIC_LABELS[a.honorific];
  const nameText = a.recipientName
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => `${l}${label}`)
    .join("\n");
  pushVertical(ops, verticalColumns(nameText, name.size, bottomLimit - nameTop), (name.x / 100) * page.width, nameTop, name.size, "name", name.size * 1.35);

  // 差出人（住所の列 → 氏名の列を右から左へ。郵便番号はその下に横書き）
  if (a.useSender) {
    const s = a.blocks.sender;
    const top = (s.y / 100) * page.height;
    const sx = (s.x / 100) * page.width;
    const sZip = zipDigits(a.senderZip);
    const zipSize = Math.max(6, s.size);
    const zipSpace = /^\d{7}$/.test(sZip) ? zipSize * 1.8 : 0;
    const maxH = Math.max(s.size, bottomLimit - top - zipSpace);
    const addrCols = verticalColumns(a.senderAddress, s.size, maxH);
    const gap = s.size * V_COL_GAP;
    const line = s.size * V_LINE;
    pushVertical(ops, addrCols, sx, top, s.size, "sender");
    // 差出人の氏名：住所の左の列に、少し大きく、住所より少し下げて始める（一般的な書き方）
    const nameSize = Math.min(POSTCARD_ADDRESS_MAX_PT, Math.round(s.size * 1.2 * 10) / 10);
    const nameTopS = top + (addrCols.length > 0 ? line * 2 : 0);
    const nameColsS = verticalColumns(a.senderName, nameSize, Math.max(nameSize, maxH - (nameTopS - top)));
    const nameX = sx - addrCols.length * gap;
    pushVertical(ops, nameColsS, nameX, nameTopS, nameSize, "sender", nameSize * V_COL_GAP);
    if (zipSpace > 0) {
      // 郵便番号：差出人の文字のいちばん下の、さらに下に、列の幅の中央にそろえて横書き
      const addrBottom = top + Math.max(0, ...addrCols.map((c) => c.length)) * line;
      const nameBottom = nameColsS.length > 0 ? nameTopS + Math.max(...nameColsS.map((c) => c.length)) * nameSize * V_LINE : top;
      const leftMost = nameColsS.length > 0 ? nameX - (nameColsS.length - 1) * nameSize * V_COL_GAP : sx - Math.max(0, addrCols.length - 1) * gap;
      const zipY = Math.max(addrBottom, nameBottom) + zipSize * 1.3;
      ops.push({ kind: "text", x: (sx + leftMost) / 2, y: Math.min(zipY, bottomLimit), size: zipSize, text: `〒${sZip.slice(0, 3)}-${sZip.slice(3)}`, role: "sender-zip" });
    }
  }

  // 印刷位置の微調整
  const dx = mmToPt(a.offsetXmm);
  const dy = mmToPt(a.offsetYmm);
  if (dx === 0 && dy === 0) return ops;
  return ops.map((op) =>
    op.kind === "text"
      ? { ...op, x: op.x + dx, y: op.y + dy }
      : op.kind === "rect"
        ? { ...op, x: op.x + dx, y: op.y + dy }
        : { ...op, x1: op.x1 + dx, x2: op.x2 + dx, y1: op.y1 + dy, y2: op.y2 + dy }
  );
}
