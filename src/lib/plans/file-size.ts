import { featureFlags } from "@/lib/config/features";
import type { Plan } from "./types";

/**
 * プランごとのファイルサイズの上限（2026-11-15）。各ツールの上限（無料の値）に、この倍率をかける。
 *   無料 1倍 ／ スタンダード 2倍 ／ プレミアム 4倍
 * - 処理はすべてブラウザの中で行うため、これは画面での出し分け（ファイル選択の欄 FileDropzone が使う）。
 * - 課金の機能スイッチがオフ（プランが存在しない状態）の間は、だれでもプレミアムの上限で使える
 *   （件数の上限 src/lib/plans/tool-limits.ts と同じ考え方）。
 * - ツールの処理側の上限（壊れたファイルや大きすぎるファイルを止める安全装置）は、プレミアムの上限（4倍）にそろえる。
 */
export const FILE_SIZE_MULTIPLIER: Record<Plan, number> = { free: 1, standard: 2, premium: 4 };
/** いちばん大きい倍率（ツールの処理側の安全装置に使う） */
export const MAX_FILE_SIZE_MULTIPLIER = FILE_SIZE_MULTIPLIER.premium;

/** このプランの倍率。プランが分からないときは無料の倍率 */
export function fileSizeMultiplier(plan: Plan | null): number {
  if (!featureFlags.billing) return MAX_FILE_SIZE_MULTIPLIER;
  return plan ? FILE_SIZE_MULTIPLIER[plan] : FILE_SIZE_MULTIPLIER.free;
}

/** 無料の上限（MB）に倍率をかけた、このプランの上限（MB）。上限なし（Infinity）はそのまま */
export function scaleMaxSizeMB(baseMB: number, plan: Plan | null): number {
  if (!Number.isFinite(baseMB)) return baseMB;
  return baseMB * fileSizeMultiplier(plan);
}

/**
 * 説明文の中の「無料の上限（例: 50MB）」を、このプランの上限に書き換える（例: 「上限50MB」→「上限200MB」）。
 * 上限と同じ数字の「〇MB」だけを書き換える（ほかの数字は変えない）。
 */
export function rewriteSizeHint(hint: string, baseMB: number, scaledMB: number): string {
  if (!Number.isFinite(baseMB) || baseMB === scaledMB) return hint;
  const patterns = [String(baseMB), baseMB.toLocaleString("ja-JP")];
  let out = hint;
  for (const p of new Set(patterns)) {
    out = out.replace(new RegExp(`(^|[^\\d,])${p.replace(/,/g, ",")}(\\s?MB)`, "g"), `$1${scaledMB.toLocaleString("ja-JP")}$2`);
  }
  return out;
}
