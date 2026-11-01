import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { countByKind, DIFF_KIND_LABEL, type DiffResult, type DiffKind } from "./file-diff";
import { countByStatus, MATCH_RULES, MATCH_STATUS_LABEL, type MatchRow } from "./item-match";

/**
 * 比較結果の出力（Excel・Word）。画面に出したのと同じ行（DiffRow / MatchRow）を、そのまま表にする。
 * ファイル名は半角英数字とハイフンだけで作る（日本語のファイル名による文字化け・保存失敗を避けるため）。
 */

export type CompareReport =
  | { mode: "diff"; fileA: string; fileB: string; createdAt: Date; result: DiffResult }
  | { mode: "match"; fileA: string; fileB: string; createdAt: Date; rows: MatchRow[]; notes: string[] };

/** Excelの行数の上限に近い量は書き出さない（1シート約104万行） */
export const MAX_EXPORT_ROWS = 1_000_000;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function reportFileName(report: CompareReport, ext: "xlsx" | "docx"): string {
  return `${report.mode === "diff" ? "file-diff" : "document-match"}-${stamp(report.createdAt)}.${ext}`;
}

export function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function methodLabel(report: CompareReport): string {
  if (report.mode === "match") return "文書間の不一致を調べる（項目と値の照合）";
  return report.result.target === "xlsx" ? "ファイルの差分を調べる（Excel同士）" : "ファイルの差分を調べる（Word同士）";
}

export function summaryLines(report: CompareReport): [string, string][] {
  if (report.mode === "diff") {
    const counts = countByKind(report.result.rows);
    const parts = (Object.keys(counts) as DiffKind[]).map((k) => `${DIFF_KIND_LABEL[k]} ${counts[k]}件`);
    return [
      ["差分の件数", `${report.result.rows.length}件`],
      ["内訳", parts.length > 0 ? parts.join("、") : "違いはありませんでした"],
    ];
  }
  const c = countByStatus(report.rows);
  return [
    ["照合した項目", `${report.rows.length}件`],
    ["判定", `一致 ${c.match}件、不一致 ${c.mismatch}件、片方に記載なし ${c.missing}件、要確認 ${c.review}件`],
  ];
}

export function tableOf(report: CompareReport): { header: string[]; rows: string[][]; widths: number[] } {
  if (report.mode === "diff") {
    const isXlsx = report.result.target === "xlsx";
    return {
      header: [isXlsx ? "シート" : "見出し", isXlsx ? "セル・行" : "場所", "比較元", "比較先", "差分", "補足"],
      rows: report.result.rows.map((r) => [r.group, r.location, r.before, r.after, DIFF_KIND_LABEL[r.kind], r.note]),
      widths: [16, 14, 40, 40, 16, 24],
    };
  }
  return {
    header: ["項目（ファイルA）", "項目（ファイルB）", "ファイルAの値", "ファイルBの値", "判定", "判定の理由", "ファイルAの場所", "ファイルBの場所"],
    rows: report.rows.map((r) => [r.labelA, r.labelB, r.valueA, r.valueB, MATCH_STATUS_LABEL[r.status], r.reason, r.locationA, r.locationB]),
    widths: [20, 20, 28, 28, 14, 44, 18, 18],
  };
}

function notesOf(report: CompareReport): string[] {
  return report.mode === "diff" ? report.result.notes : report.notes;
}

export async function exportReportXlsx(report: CompareReport): Promise<Blob> {
  const { header, rows, widths } = tableOf(report);
  if (rows.length > MAX_EXPORT_ROWS) throw new Error("結果が多すぎるため、Excelに書き出せません。比べる範囲を分けてください。");
  const info: string[][] = [
    ["比較方式", methodLabel(report)],
    ["比較元（ファイルA）", report.fileA],
    ["比較先（ファイルB）", report.fileB],
    ["比較日時", formatDateTime(report.createdAt)],
    ...summaryLines(report),
    [],
    ["比べた範囲・扱い", ""],
    ...notesOf(report).map((n) => ["", n]),
  ];
  if (report.mode === "match") info.push([], ["照合のルール", ""], ...MATCH_RULES.map((r) => ["", r]));
  const text = (v: string) => ({ value: v, type: String, wrap: true });
  return writeXlsxSheets([
    {
      name: "比較結果",
      rows: [header.map((h) => ({ value: h, type: String, fontWeight: "bold" })), ...rows.map((r) => r.map(text))],
      columns: widths.map((w) => ({ width: w })),
    },
    { name: "概要", rows: info.map((r) => r.map((v) => ({ value: v, type: String }))), columns: [{ width: 22 }, { width: 100 }] },
  ]);
}

export async function exportReportDocx(report: CompareReport): Promise<Blob> {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, PageOrientation, TableLayoutType, WidthType, ShadingType } =
    await import("docx");
  const { header, rows } = tableOf(report);
  const font = { ascii: "Meiryo", hAnsi: "Meiryo", eastAsia: "Meiryo", cs: "Meiryo" };
  const small = 16; // 8pt（半ポイント単位）
  // A4横・余白15mm。表の幅は、文字が欄の外へはみ出さないよう固定し、長い文は欄の中で折り返す
  const pageW = 16838;
  const pageH = 11906;
  const margin = 850;
  const usable = pageW - margin * 2;
  const ratios = report.mode === "diff" ? [12, 10, 28, 28, 10, 12] : [12, 12, 15, 15, 8, 22, 8, 8];
  const total = ratios.reduce((a, b) => a + b, 0);
  const colWidths = ratios.map((r) => Math.floor((usable * r) / total));

  const para = (text: string, opts: { bold?: boolean; size?: number } = {}) =>
    (text === "" ? [""] : text.split("\n")).map(
      (line) => new Paragraph({ spacing: { before: 0, after: 0 }, children: [new TextRun({ text: line, bold: opts.bold, size: opts.size ?? small, font })] })
    );
  const cell = (text: string, width: number, headerCell = false) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      margins: { top: 40, bottom: 40, left: 60, right: 60 },
      shading: headerCell ? { type: ShadingType.CLEAR, color: "auto", fill: "E8EEF8" } : undefined,
      children: para(text, { bold: headerCell }),
    });

  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "比較レポート", font, size: 32, bold: true })] }),
    ...[
      ["比較方式", methodLabel(report)],
      ["比較元（ファイルA）", report.fileA],
      ["比較先（ファイルB）", report.fileB],
      ["比較日時", formatDateTime(report.createdAt)],
      ...summaryLines(report),
    ].map(([k, v]) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `${k}：`, bold: true, font, size: 20 }), new TextRun({ text: v, font, size: 20 })] })),
    new Paragraph({ spacing: { before: 160, after: 60 }, children: [new TextRun({ text: "比べた範囲・扱い", bold: true, font, size: 20 })] }),
    ...notesOf(report).map((n) => new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: `・${n}`, font, size: 18 })] })),
    ...(report.mode === "match"
      ? [
          new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: "照合のルール", bold: true, font, size: 20 })] }),
          ...MATCH_RULES.map((r) => new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: `・${r}`, font, size: 18 })] })),
        ]
      : []),
    new Paragraph({ spacing: { before: 200, after: 60 }, children: [new TextRun({ text: report.mode === "diff" ? "差分の一覧" : "照合の一覧", bold: true, font, size: 24 })] }),
  ];
  const body =
    rows.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: report.mode === "diff" ? "違いはありませんでした。" : "照合できる項目がありませんでした。", font, size: 20 })] })]
      : [
          new Table({
            width: { size: usable, type: WidthType.DXA },
            columnWidths: colWidths,
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, colWidths[i], true)) }),
              ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, colWidths[i])) })),
            ],
          }),
        ];
  const doc = new Document({
    styles: { default: { document: { run: { font, size: 20 } } } },
    sections: [
      {
        properties: { page: { size: { width: pageH, height: pageW, orientation: PageOrientation.LANDSCAPE }, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
        children: [...children, ...body],
      },
    ],
  });
  return Packer.toBlob(doc);
}
