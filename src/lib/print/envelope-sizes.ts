/**
 * 日本の定型封筒サイズ定義（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * print/paper-sizes.ts の PAPER_SIZES_PT はA判/B判/Letter等の「用紙」サイズであり、
 * 封筒はそれとは別の規格（JIS）のため、無理に同じテーブルへ統合せず、
 * 封筒宛名作成ツール専用の定義として分ける。mm→pt変換のみ paper-sizes.ts の
 * mmToPt() を再利用する（変換ロジック自体は重複させない）。
 *
 * サイズはJIS規格の代表的な値（mm）。
 */
import { mmToPt, type PaperSizePt } from "./paper-sizes";

export type EnvelopeSizeId = "chou3" | "chou4" | "kaku2";

export interface EnvelopeSizeMm {
  width: number;
  height: number;
}

/** 封筒本体の寸法（mm）。width < height の縦向きを基準値とする */
export const ENVELOPE_SIZES_MM: Record<EnvelopeSizeId, EnvelopeSizeMm> = {
  chou3: { width: 120, height: 235 },
  chou4: { width: 90, height: 205 },
  kaku2: { width: 240, height: 332 },
};

export const ENVELOPE_SIZE_LABELS: Record<EnvelopeSizeId, string> = {
  chou3: "長形3号（120×235mm）",
  chou4: "長形4号（90×205mm）",
  kaku2: "角形2号（240×332mm）",
};

export const ENVELOPE_SIZE_IDS: EnvelopeSizeId[] = ["chou3", "chou4", "kaku2"];

/** 封筒サイズ(mm)をPDFページサイズ(pt)へ変換する。印刷時は封筒を横向き（長辺が横）に給紙することが多いため、常に横向き(width>height)で返す */
export function resolveEnvelopePageSizePt(id: EnvelopeSizeId): PaperSizePt {
  const mm = ENVELOPE_SIZES_MM[id];
  const w = mmToPt(Math.max(mm.width, mm.height));
  const h = mmToPt(Math.min(mm.width, mm.height));
  return { width: w, height: h };
}
