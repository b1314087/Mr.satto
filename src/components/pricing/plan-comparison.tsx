import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { PLAN_LIMITS, type PlanLimitKey } from "@/lib/plans/tool-limits";
import { BATCH_LIMITS } from "@/lib/batch/batch-config";
import { featureFlags } from "@/lib/config/features";

/**
 * 料金ページの下に置く、プランの比較表。
 * - 上の表：プランの違いを1行ずつ（○／—）で並べる。
 * - 下の表（開いて見る）：ツールごとの件数の上限。数字は src/lib/plans/tool-limits.ts（PLAN_LIMITS）から作る。
 */

/** PLAN_LIMITS のキーごとの、画面に出すツール名（ツール一覧の名前にそろえる） */
const LIMIT_TOOL_NAMES: Record<PlanLimitKey, string> = {
  "image-layout": "画像ホワイトボード",
  "image-merge": "画像結合",
  "pdf-merge": "PDF結合",
  "image-to-pdf": "画像→PDF",
  "pdf-ocr": "PDF→テキスト（OCR）",
  "pdf-to-excel": "PDF→Excel",
  "pdf-to-word": "PDF→Word",
  "file-bulk-rename": "一括ファイル名変更",
  "file-sequential-rename": "連番リネーム",
  "file-zip": "ZIP作成",
  "excel-merge": "Excel・CSV結合",
  "audio-merge": "音声結合",
  "envelope-address": "封筒宛名作成",
  "ticket-voucher": "整理券・金券・引換券作成",
  "roster-template": "名簿テンプレート作成",
  "postal-bulk": "郵便番号・住所検索（まとめて）",
  postcard: "ハガキ作成",
  "receipt-accounting-csv": "領収書から会計CSV作成",
  "filled-pdf-to-excel": "記入済みPDF→Excel",
  "form-to-individual-pdfs": "PDF差し込み印刷",
  "excel-label": "ラベル作成",
  "fiscal-calendar-import": "年度カレンダー（予定の取り込み）",
};

const YES = "○";
const NO = "—";

function formatLimit(n: number, unit: string): string {
  return Number.isFinite(n) ? `${n.toLocaleString("ja-JP")}${unit}` : "制限なし";
}

type Row = { label: string; free: string; standard: string; premium: string };

export function PlanComparison({ adGateActive }: { adGateActive: boolean }) {
  const batchMax = Math.max(...Object.values(BATCH_LIMITS));
  const rows: Row[] = [
    {
      label: "月額（税込）",
      free: "0円",
      standard: `${PLAN_DEFINITIONS.standard.priceYen.toLocaleString("ja-JP")}円`,
      premium: `${PLAN_DEFINITIONS.premium.priceYen.toLocaleString("ja-JP")}円`,
    },
    { label: "ログイン", free: "不要", standard: "必要", premium: "必要" },
    { label: "すべてのツール", free: YES, standard: YES, premium: YES },
    { label: "件数の上限", free: "少なめ", standard: "一部ツールで多め", premium: "最大" },
    { label: "複数ファイルの一括処理", free: NO, standard: NO, premium: `${YES}（最大${batchMax}ファイル）` },
    { label: "記入済みPDF→Excel", free: "1回1ページ", standard: "1回1ページ", premium: "制限なし" },
    { label: "AIの補助", free: NO, standard: NO, premium: YES },
  ];
  // 広告は、実際に出している（または広告視聴が必要な）間だけ行を出す。出していない間は差がないので書かない
  if (adGateActive || featureFlags.ads) {
    rows.splice(3, 0, { label: "広告", free: adGateActive ? "ダウンロードごとに視聴" : "あり", standard: "なし", premium: "なし" });
  }

  const th = "px-3 py-2 text-center font-semibold text-ms-text";
  const td = "px-3 py-2 text-center text-ms-text";

  return (
    <section className="ms-glass mt-10 p-6" data-testid="plan-comparison">
      <h2 className="mb-4 text-base font-semibold text-ms-text">プランの比較</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-ms-border">
              <th className="px-3 py-2 text-left font-semibold text-ms-muted" scope="col"></th>
              <th className={th} scope="col">無料</th>
              <th className={th} scope="col">スタンダード</th>
              <th className={th} scope="col">プレミアム</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-ms-border last:border-0">
                <th className="px-3 py-2 text-left font-normal text-ms-muted" scope="row">{r.label}</th>
                <td className={td}>{r.free}</td>
                <td className={td}>{r.standard}</td>
                <td className={td}>{r.premium}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-4" data-testid="plan-limit-details">
        <summary className="cursor-pointer text-sm font-medium text-ms-accent dark:text-ms-focus">ツールごとの件数の上限を見る</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-ms-border">
                <th className="px-3 py-2 text-left font-semibold text-ms-muted" scope="col">ツール</th>
                <th className={th} scope="col">無料</th>
                <th className={th} scope="col">スタンダード</th>
                <th className={th} scope="col">プレミアム</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(PLAN_LIMITS) as PlanLimitKey[]).map((key) => {
                const l = PLAN_LIMITS[key];
                const up = l.standard > l.free;
                return (
                  <tr key={key} className="border-b border-ms-border last:border-0">
                    <th className="px-3 py-1.5 text-left font-normal text-ms-text" scope="row">{LIMIT_TOOL_NAMES[key]}</th>
                    <td className={td}>{formatLimit(l.free, l.unit)}</td>
                    <td className={`${td} ${up ? "font-semibold" : ""}`}>{formatLimit(l.standard, l.unit)}</td>
                    <td className={td}>{formatLimit(l.premium, l.unit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
