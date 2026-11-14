import type { Plan } from "./types";
import { featureFlags } from "@/lib/config/features";

/**
 * ツールごとの「一度に扱える数」の上限を、プラン別にまとめた設定（2026-11 料金プランの見直し）。
 *
 * - 値は運営が決めた料金プラン表（Mr.Satto_料金プラン提案.xlsx を編集したもの）のとおり。
 * - 数を変えるときは、ここだけを直す（各ツールの画面に数字を直接書かない）。
 * - 課金の機能スイッチがオフ（プランが存在しない状態）の間は、だれでもプレミアムの上限で使える
 *   （プレミアムに加入する手段がないのに、上限だけを厳しくしないため。一括処理 canUseBatch と同じ考え方）。
 * - プランが分からない（表示用のプランが渡されていない）ときは、無料の上限にする。
 * - 処理はすべてブラウザの中で行うため、これは画面での出し分け。ファイルの中身はサーバーへ送らない。
 *
 * 複数ファイルを同じ処理にかける「一括処理」の上限は src/lib/batch/batch-config.ts（BATCH_LIMITS）にある。
 */
export interface PlanLimit {
  free: number;
  standard: number;
  premium: number;
  /** 数の単位（案内の文に使う） */
  unit: string;
  /** 何の数か（案内の文に使う。例：「結合する画像」） */
  label: string;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLAN_LIMITS = {
  "image-layout": { free: 10, standard: 20, premium: 100, unit: "枚", label: "配置する画像" },
  // 2026-11：無料でも結合を試せるよう、画像結合・PDF結合の無料の上限を1から2にした
  // （旧スタンダードが無料より少なくならないよう、PDF結合の旧スタンダードも2にそろえた）
  "image-merge": { free: 2, standard: 5, premium: 50, unit: "枚", label: "結合する画像" },
  "pdf-merge": { free: 2, standard: 2, premium: 50, unit: "ファイル", label: "結合するPDF" },
  "image-to-pdf": { free: 1, standard: 1, premium: 200, unit: "枚", label: "PDFにする画像" },
  "pdf-ocr": { free: 1, standard: 1, premium: 200, unit: "ページ", label: "文字を読み取る（OCR）ページ" },
  "pdf-to-excel": { free: 1, standard: 1, premium: 200, unit: "ページ", label: "変換するページ" },
  "pdf-to-word": { free: 1, standard: 1, premium: 200, unit: "ページ", label: "変換するページ" },
  "file-bulk-rename": { free: 3, standard: 3, premium: 500, unit: "ファイル", label: "名前を変えるファイル" },
  "file-sequential-rename": { free: 3, standard: 3, premium: 500, unit: "ファイル", label: "名前を変えるファイル" },
  "file-zip": { free: 3, standard: 3, premium: 500, unit: "ファイル", label: "ZIPにまとめるファイル" },
  "excel-merge": { free: 2, standard: 2, premium: 50, unit: "ファイル", label: "結合するファイル" },
  "audio-merge": { free: 5, standard: 50, premium: 50, unit: "ファイル", label: "結合する音声" },
  "envelope-address": { free: 1, standard: 1, premium: 1000, unit: "件", label: "宛先" },
  "ticket-voucher": { free: 10, standard: 2000, premium: 2000, unit: "枚", label: "作成する券" },
  "roster-template": { free: 50, standard: 3000, premium: 3000, unit: "行", label: "名簿の行" },
  "postal-bulk": { free: 1, standard: 10, premium: 10000, unit: "件", label: "まとめて調べる住所・郵便番号" },
  "postcard": { free: 1, standard: 10, premium: 500, unit: "件", label: "宛先" },
  "receipt-accounting-csv": { free: 3, standard: 50, premium: 200, unit: "枚", label: "読み取る領収書" },
  "filled-pdf-to-excel": { free: 1, standard: 1, premium: 50, unit: "ファイル", label: "読み取るPDF" },
  "form-to-individual-pdfs": { free: 10, standard: 10, premium: 1000, unit: "件", label: "作成するPDF" },
  "excel-label": { free: 5, standard: 5, premium: UNLIMITED, unit: "シート", label: "印刷するラベルのシート" },
  "fiscal-calendar-import": { free: 5, standard: 5, premium: 20000, unit: "件", label: "取り込む予定" },
} as const satisfies Record<string, PlanLimit>;

export type PlanLimitKey = keyof typeof PLAN_LIMITS;

/** このプランでの上限（上限なしは Infinity） */
export function getPlanLimit(key: PlanLimitKey, plan: Plan | null): number {
  const def: PlanLimit = PLAN_LIMITS[key];
  if (!featureFlags.billing) return def.premium;
  return def[plan ?? "free"];
}

/** プレミアムでの上限（案内の文「プレミアムなら◯件まで」に使う） */
export function getPremiumLimit(key: PlanLimitKey): number {
  return PLAN_LIMITS[key].premium;
}

/** 上限を超えた分を切り捨てる。返り値の dropped は切り捨てた数 */
export function clampToLimit<T>(items: readonly T[], limit: number): { kept: T[]; dropped: number } {
  if (items.length <= limit) return { kept: [...items], dropped: 0 };
  return { kept: items.slice(0, limit), dropped: items.length - limit };
}

/** 上限の表示（上限なしは「上限なし」） */
export function formatLimit(limit: number, unit: string): string {
  return Number.isFinite(limit) ? `${limit.toLocaleString("ja-JP")}${unit}` : "上限なし";
}
