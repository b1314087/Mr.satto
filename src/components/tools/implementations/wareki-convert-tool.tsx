"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { useCsvExport } from "@/components/common/csv-export-encoding";
import { Segmented } from "@/components/ui/segmented";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { parseCsv, serializeCsv } from "@/lib/utils/csv";
import { readCsvText } from "@/lib/utils/csv-encoding";
import { readXlsxSheets, writeXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import {
  convertValue,
  STATUS_LABELS,
  type ConvertDirection,
  type ConvertOptions,
  type ConvertResult,
  type SeirekiFormat,
  type WarekiFormat,
} from "@/lib/date/wareki";

/**
 * 和暦・西暦一括変換（2026-11-17）。
 * 貼り付けた日付、または Excel・CSV の選んだ列の日付を、まとめて和暦⇔西暦に変換する。
 * - 日付として読めない値・空欄は変えない。存在しない日付・元号の範囲外・改元の年で決められない値は「要確認」として残す。
 * - 元のファイルは変更しない。変換結果は、元の列の右に「（変換結果）」の列を足した別のファイルとして書き出す。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

type InputMode = "text" | "file";
type Table = { name: string; rows: XlsxCellValue[][] };

const MAX_MB = 30;
const PREVIEW_ROWS = 100;
const ACCEPT = ".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";

function cellText(v: XlsxCellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getUTCFullYear()}/${p(v.getUTCMonth() + 1)}/${p(v.getUTCDate())}`;
  }
  return String(v);
}

const STATUS_CLASS: Record<string, string> = {
  converted: "text-emerald-700 dark:text-emerald-300",
  check: "font-semibold text-amber-700 dark:text-amber-300",
  skipped: "text-neutral-500 dark:text-neutral-400",
  empty: "text-neutral-400",
};

export function WarekiConvertTool() {
  const [mode, setMode] = useState<InputMode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ConvertOptions>({ direction: "auto", warekiFormat: "kanji", gannen: true, seirekiFormat: "slash" });
  const [outFormat, setOutFormat] = useState<"xlsx" | "csv">("xlsx");
  const csvExport = useCsvExport();

  const table = tables[sheetIndex] ?? null;
  const width = table ? Math.max(0, ...table.rows.map((r) => r.length)) : 0;
  const headers = table
    ? Array.from({ length: width }, (_, c) => (hasHeader ? cellText(table.rows[0]?.[c] ?? null) : "") || `${c + 1}列目`)
    : [];
  const dataRows = useMemo(() => (table ? (hasHeader ? table.rows.slice(1) : table.rows) : []), [table, hasHeader]);

  /** 列ごとの「日付として読める値」の数（日付の列の候補を出すため） */
  const columnDateCounts = useMemo(() => {
    if (!table) return [];
    return Array.from({ length: width }, (_, c) => dataRows.filter((r) => convertValue(r[c] ?? null).status !== "skipped" && convertValue(r[c] ?? null).status !== "empty").length);
  }, [table, width, dataRows]);

  async function handleFile(files: File[]) {
    const f = files[0];
    if (!f) return;
    setError(null);
    setLoading(true);
    try {
      let loaded: Table[];
      if (/\.csv$/i.test(f.name) || f.type === "text/csv") {
        const { text: csvText } = await readCsvText(f);
        loaded = [{ name: "CSV", rows: parseCsv(csvText) }];
      } else if (/\.xlsx$/i.test(f.name)) {
        loaded = await readXlsxSheets(f);
      } else {
        throw new Error("Excel（.xlsx）またはCSV（.csv）のファイルを選んでください。古い形式（.xls）は、先に「Excel旧形式→新形式」で.xlsxに変換してください。");
      }
      loaded = loaded.map((t) => ({ ...t, rows: t.rows.filter((r) => r.some((v) => cellText(v).trim() !== "")) }));
      if (!loaded.some((t) => t.rows.length > 0)) throw new Error("このファイルには読み取れるデータがありません。");
      setFile(f);
      setTables(loaded);
      setOutFormat(/\.csv$/i.test(f.name) ? "csv" : "xlsx");
      const first = Math.max(0, loaded.findIndex((t) => t.rows.length > 0));
      setSheetIndex(first);
      // 日付が多く入っている列を、最初から選んでおく
      const t = loaded[first];
      const w = Math.max(0, ...t.rows.map((r) => r.length));
      const rows = t.rows.slice(1);
      const auto = Array.from({ length: w }, (_, c) => c).filter((c) => {
        const vals = rows.map((r) => r[c] ?? null).filter((v) => cellText(v).trim() !== "");
        if (vals.length === 0) return false;
        const ok = vals.filter((v) => ["converted", "check"].includes(convertValue(v).status)).length;
        return ok / vals.length >= 0.5;
      });
      setColumns(auto);
    } catch (e) {
      setFile(null);
      setTables([]);
      setColumns([]);
      setError(e instanceof Error ? e.message : "ファイルを読み取れませんでした。");
    } finally {
      setLoading(false);
    }
  }

  function clearFile() {
    setFile(null);
    setTables([]);
    setColumns([]);
    setError(null);
  }

  // 貼り付けた日付の変換結果
  const textResults = useMemo(() => {
    if (mode !== "text") return [];
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(0, 5000)
      .map((line) => ({ input: line, result: convertValue(line, options) }));
  }, [mode, text, options]);

  // ファイルの、選んだ列の変換結果（行ごと・選んだ列ごと）
  const fileResults = useMemo(() => {
    if (mode !== "file" || !table) return [];
    return dataRows.map((r) => columns.map((c) => convertValue(r[c] ?? null, options)));
  }, [mode, table, dataRows, columns, options]);

  const results: ConvertResult[] = mode === "text" ? textResults.map((t) => t.result) : fileResults.flat();
  const counts = {
    converted: results.filter((r) => r.status === "converted").length,
    check: results.filter((r) => r.status === "check").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  function resultHeader(c: number): string {
    const to = options.direction === "to-wareki" ? "和暦" : options.direction === "to-seireki" ? "西暦" : "変換結果";
    return `${headers[c]}（${to}）`;
  }

  /** 書き出す表：元の列の右に、変換結果の列を足す。変換しなかったセルは、元の値をそのまま入れる */
  function buildOutputRows(asText: boolean): (XlsxCellValue | string)[][] {
    if (mode === "text") {
      return [["元の値", "変換結果", "状態", "理由"], ...textResults.map((t) => [t.input, t.result.output ?? t.input, STATUS_LABELS[t.result.status], t.result.reason ?? ""])];
    }
    const sorted = [...columns].sort((a, b) => a - b);
    const out: (XlsxCellValue | string)[][] = [];
    const body = table!.rows;
    body.forEach((row, ri) => {
      const isHeader = hasHeader && ri === 0;
      const line: (XlsxCellValue | string)[] = [];
      for (let c = 0; c < width; c++) {
        const v = row[c] ?? null;
        line.push(asText ? cellText(v) : v);
        if (sorted.includes(c)) {
          if (isHeader) line.push(resultHeader(c));
          else {
            const r = fileResults[hasHeader ? ri - 1 : ri]?.[columns.indexOf(c)];
            line.push(r && r.status === "converted" ? r.output! : asText ? cellText(v) : v);
          }
        }
      }
      out.push(line);
    });
    if (!hasHeader) {
      // 見出しがないときも、変換結果の列が分かるように1行目に見出しを付ける
      const head: string[] = [];
      for (let c = 0; c < width; c++) {
        head.push(`${c + 1}列目`);
        if (sorted.includes(c)) head.push(resultHeader(c));
      }
      out.unshift(head);
    }
    return out;
  }

  const baseName = file ? stripExtension(file.name) : "和暦西暦変換";
  const canDownload = results.length > 0 && counts.converted > 0;

  async function downloadExcel() {
    const rows = buildOutputRows(false);
    const blob = await writeXlsxSheets([{ name: (mode === "file" && table?.name.slice(0, 31)) || "変換結果", rows }]);
    downloadBlob(blob, `${baseName}_変換.xlsx`);
  }

  function downloadCsv() {
    void csvExport.download(serializeCsv(buildOutputRows(true) as string[][], { includeBom: false }), `${baseName}_変換.csv`);
  }

  const previewRows =
    mode === "text"
      ? textResults.slice(0, PREVIEW_ROWS).map((t) => ({ label: t.input, cells: [{ input: t.input, result: t.result }] }))
      : dataRows.slice(0, PREVIEW_ROWS).map((r, i) => ({
          label: String(i + 1 + (hasHeader ? 1 : 0)),
          cells: columns.map((c, j) => ({ input: cellText(r[c] ?? null), result: fileResults[i]?.[j] })),
        }));

  return (
    <div className="flex flex-col gap-6" data-testid="wareki-tool">
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        ariaLabel="日付の入れ方"
        testId="wareki-mode"
        options={[
          { value: "text", label: "日付を貼り付ける" },
          { value: "file", label: "Excel・CSVから" },
        ]}
      />

      <SettingsStack>
        {mode === "text" ? (
          <SettingsSection n={1} title="変換する日付を入力" summary={textResults.length ? `${textResults.length}件` : undefined}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"1行に1つずつ入力します（例）\n2026/11/17\n令和8年11月17日\nH31.4.30\n昭和64年1月7日"}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              data-testid="wareki-text"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              西暦（2026/11/17・2026-11-17・2026年11月17日）、和暦（令和8年11月17日・R8.11.17・令和元年）、年だけ・年月だけ（令和8年・2026年5月）に対応します。
            </p>
          </SettingsSection>
        ) : (
          <SettingsSection n={1} title="Excel・CSVのファイルを選ぶ" summary={file?.name}>
            <FileDropzone
              compact={!!file}
              accept={ACCEPT}
              maxSizeMB={MAX_MB}
              label="Excel（.xlsx）・CSVをドラッグ&ドロップ"
              hint={`またはタップして選択（上限${MAX_MB}MB）`}
              onFilesSelected={(f) => void handleFile(f)}
              onError={setError}
            />
            {loading && <p className="text-xs text-neutral-500">読み込んでいます…</p>}
            {file && <FileList files={[file]} onRemove={clearFile} />}
            {tables.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                シート
                <select
                  value={sheetIndex}
                  onChange={(e) => {
                    setSheetIndex(Number(e.target.value));
                    setColumns([]);
                  }}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  data-testid="wareki-sheet"
                >
                  {tables.map((t, i) => (
                    <option key={i} value={i}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </SettingsSection>
        )}

        {mode === "file" && table && (
          <SettingsSection n={2} title="変換する日付の列を選ぶ" summary={columns.length ? `${columns.length}列` : "未選択"}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              1行目は見出し
            </label>
            <div className="flex flex-wrap gap-2" data-testid="wareki-columns">
              {headers.map((h, c) => (
                <label
                  key={c}
                  className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm ${
                    columns.includes(c) ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={columns.includes(c)}
                    onChange={(e) => setColumns((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
                  />
                  <span className="max-w-[12rem] truncate">{h}</span>
                  {columnDateCounts[c] > 0 && <span className="text-xs text-neutral-500">（日付{columnDateCounts[c]}件）</span>}
                </label>
              ))}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">日付が多く入っている列を、最初から選んでいます。選んだ列以外は変えません。</p>
          </SettingsSection>
        )}

        <SettingsSection n={mode === "file" ? 3 : 2} title="変換のしかた">
          <Segmented
            value={options.direction}
            onChange={(direction: ConvertDirection) => setOptions((o) => ({ ...o, direction }))}
            label="変換の向き"
            testId="wareki-direction"
            size="sm"
            options={[
              { value: "auto", label: "自動（西暦⇔和暦）" },
              { value: "to-wareki", label: "西暦→和暦" },
              { value: "to-seireki", label: "和暦→西暦" },
            ]}
          />
          {options.direction !== "to-seireki" && (
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={options.warekiFormat}
                onChange={(warekiFormat: WarekiFormat) => setOptions((o) => ({ ...o, warekiFormat }))}
                label="和暦の書き方"
                size="sm"
                options={[
                  { value: "kanji", label: "令和8年11月17日" },
                  { value: "letter", label: "R8.11.17" },
                ]}
              />
              {options.warekiFormat === "kanji" && (
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={options.gannen} onChange={(e) => setOptions((o) => ({ ...o, gannen: e.target.checked }))} data-testid="wareki-gannen" />
                  1年は「元年」と書く
                </label>
              )}
            </div>
          )}
          {options.direction !== "to-wareki" && (
            <Segmented
              value={options.seirekiFormat}
              onChange={(seirekiFormat: SeirekiFormat) => setOptions((o) => ({ ...o, seirekiFormat }))}
              label="西暦の書き方"
              size="sm"
              testId="wareki-seireki-format"
              options={[
                { value: "slash", label: "2026/11/17" },
                { value: "hyphen", label: "2026-11-17" },
                { value: "kanji", label: "2026年11月17日" },
              ]}
            />
          )}
        </SettingsSection>
      </SettingsStack>

      {error && <ErrorMessage message={error} testId="wareki-error" />}

      {results.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="wareki-result">
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100" data-testid="wareki-summary">
            変換 {counts.converted}件
            {counts.check > 0 && <span className="text-amber-700 dark:text-amber-300">・要確認 {counts.check}件</span>}
            {counts.skipped > 0 && <span className="text-neutral-500">・そのまま {counts.skipped}件</span>}
          </p>
          {counts.check > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              「要確認」の値は変換せず、元の値のまま書き出します。理由を見て、必要なら手で直してください。
            </p>
          )}
          <div className="max-h-96 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-xs" data-testid="wareki-preview">
              <thead className="sticky top-0 bg-neutral-50 dark:bg-neutral-900">
                <tr>
                  {mode === "file" && <th className="px-2 py-1.5 font-semibold">行</th>}
                  {(mode === "text" ? [null] : columns).map((c, j) => (
                    <th key={j} colSpan={2} className="px-2 py-1.5 font-semibold">
                      {mode === "text" ? "変換前 → 変換後" : `${headers[c as number]}：変換前 → 変換後`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-100 dark:border-neutral-800">
                    {mode === "file" && <td className="px-2 py-1 text-neutral-400">{row.label}</td>}
                    {row.cells.map((cell, j) => (
                      <td key={j} colSpan={2} className="px-2 py-1">
                        <span className="text-neutral-600 dark:text-neutral-300">{cell.input || "（空欄）"}</span>
                        {cell.result && cell.result.status !== "empty" && (
                          <>
                            <span className="mx-1 text-neutral-400">→</span>
                            <span className={STATUS_CLASS[cell.result.status]} data-status={cell.result.status}>
                              {cell.result.status === "converted" ? cell.result.output : `${STATUS_LABELS[cell.result.status]}：${cell.result.reason ?? ""}`}
                            </span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(mode === "text" ? textResults.length : dataRows.length) > PREVIEW_ROWS && (
            <p className="text-xs text-neutral-500">プレビューは先頭{PREVIEW_ROWS}行です（書き出すファイルには、すべての行が入ります）。</p>
          )}
          {canDownload ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {mode === "file"
                  ? "元のファイルは変更しません。選んだ列の右に「（変換結果）」の列を足した、別のファイルを書き出します（書式・数式は引き継がず、値の表として書き出します）。"
                  : "元の値・変換結果・状態・理由の表を書き出します。"}
              </p>
              <Segmented
                value={outFormat}
                onChange={(v: "xlsx" | "csv") => setOutFormat(v)}
                label="書き出す形式"
                size="sm"
                testId="wareki-out-format"
                options={[
                  { value: "xlsx", label: "Excel（.xlsx）" },
                  { value: "csv", label: "CSV" },
                ]}
              />
              {outFormat === "csv" && (
                <>
                  {csvExport.picker}
                  {csvExport.confirm}
                </>
              )}
              <RewardedDownloadGate
                onDownload={() => (outFormat === "xlsx" ? void downloadExcel() : downloadCsv())}
                label={outFormat === "xlsx" ? "Excel（.xlsx）でダウンロード" : "CSVでダウンロード"}
              />
            </div>
          ) : (
            <p className="text-xs text-neutral-500">変換できる日付がありません。列の選び方・変換の向きを確かめてください。</p>
          )}
        </section>
      )}
      {mode === "file" && table && columns.length === 0 && <p className="text-xs text-neutral-500">変換する日付の列を選んでください。</p>}
    </div>
  );
}
