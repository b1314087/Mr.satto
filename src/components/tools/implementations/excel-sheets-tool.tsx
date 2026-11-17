"use client";

import { useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { fileKey as fileIdentity, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { RunBar } from "@/components/ui/run-bar";
import { createZip } from "@/lib/utils/zip";
import { dedupeFileNames, downloadBlob, formatBytes, sanitizeFileName, stripExtension } from "@/lib/utils/format";
import { listSheets, MAX_XLSX_MERGE_FILES, MAX_XLSX_SHEETS_MB, mergeWorkbooks, splitSheets, type SheetInfo } from "@/lib/office-merge/xlsx-sheets";

/**
 * Excelシート分割・結合（2026-11-17）。
 * - シート分割：1つのブックの、選んだシートを1シートずつ別のブックにする（複数のときは ZIP）。
 * - シート結合：複数のブックのシートを、選んだ順に1つのブックへまとめる。
 * どちらも、値を取り出して作り直すのではなく、シートの中身（値・数式・書式・結合・列の幅・行の高さ・非表示）をそのまま使う。
 * 1つのシートにデータを縦に積み上げる「データの結合」は、「Excel・CSV結合」を使う。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

type Mode = "split" | "merge";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ACCEPT = `${XLSX_MIME},.xlsx`;

const MODES: { mode: Mode; label: string; description: string }[] = [
  { mode: "split", label: "シート分割", description: "1つのExcelの各シートを、別々のExcelファイルに分けます（書式・数式もそのまま）。" },
  { mode: "merge", label: "シート結合", description: "複数のExcelのシートを、1つのExcelファイルにまとめます（シートはそのまま並べます）。" },
];

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

const fileKeys = new WeakMap<File, number>();
let nextFileKey = 1;
function fileKey(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = nextFileKey++;
    fileKeys.set(file, key);
  }
  return key;
}

const STATE_LABEL: Record<string, string> = { hidden: "非表示", veryHidden: "非表示（特別）" };

export function ExcelSheetsTool() {
  const [mode, setMode] = useState<Mode>("split");
  const info = MODES.find((m) => m.mode === mode)!;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="操作の種類" data-testid="excel-sheets-modes" className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`excel-sheets-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="excel-sheets-mode-description">
          {info.description}
        </p>
      </div>
      {mode === "split" ? <SplitPanel /> : <MergePanel />}
    </div>
  );
}

function badExcel(f: File): string | null {
  if (/\.xlsx$/i.test(f.name)) return null;
  if (/\.xls$/i.test(f.name)) return `${f.name}は古い形式（.xls）です。先に「Excel旧形式→新形式」で .xlsx に変換してください。`;
  if (/\.xlsm$/i.test(f.name)) return `${f.name}はマクロ付きのブック（.xlsm）のため、扱えません。`;
  return `${f.name}はExcel（.xlsx）ではありません。`;
}

// ---------------------------------------------------------------------------
// 分割
// ---------------------------------------------------------------------------

interface SplitOutput {
  files: { name: string; blob: Blob }[];
  zip: Blob | null;
  notices: string[];
}

function SplitPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const settingKey = file ? `${fileIdentity(file)}#${[...selected].sort((a, b) => a - b).join(",")}` : "";
  const run = useKeyedRun<SplitOutput>(settingKey);
  const error = run.error ?? inputError;

  async function handleSelect(files: File[]) {
    const f = files[0];
    if (!f) return;
    const bad = badExcel(f);
    if (bad) {
      setInputError(bad);
      return;
    }
    setInputError(null);
    try {
      const list = await listSheets(new Uint8Array(await f.arrayBuffer()), f.name);
      if (list.length === 0) throw new Error("このExcelにはシートがありません。");
      setFile(f);
      setSheets(list);
      setSelected(list.map((s) => s.index));
    } catch (e) {
      setFile(null);
      setSheets([]);
      setSelected([]);
      setInputError(e instanceof Error ? e.message : "Excelのファイルを読み取れませんでした。");
    }
  }

  function clear() {
    setFile(null);
    setSheets([]);
    setSelected([]);
    setInputError(null);
  }

  function handleRun() {
    if (!file || selected.length === 0) return;
    const target = file;
    const idx = [...selected].sort((a, b) => a - b);
    void run.run(async () => {
      const res = await splitSheets(new Uint8Array(await target.arrayBuffer()), target.name, idx);
      const names = dedupeFileNames(res.files.map((f) => `${sanitizeFileName(f.name) || "Sheet"}.xlsx`));
      const files = res.files.map((f, i) => ({ name: names[i], blob: new Blob([f.bytes as BlobPart], { type: XLSX_MIME }) }));
      const zip = files.length > 1 ? await createZip(files.map((f) => ({ name: f.name, blob: f.blob }))) : null;
      return { files, zip, notices: res.notices };
    });
  }

  const result = run.value;
  const allOn = sheets.length > 0 && selected.length === sheets.length;

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        sheets.length > 0 ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">分割してできるファイル（{selected.length}個）</p>
            <ul className="flex flex-col gap-1.5">
              {sheets
                .filter((s) => selected.includes(s.index))
                .map((s) => (
                  <li key={s.index} className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white/70 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
                    <span className="min-w-0 truncate">{sanitizeFileName(s.name) || "Sheet"}.xlsx</span>
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            Excelを選ぶと、ここに分割してできるファイルが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        compact={!!file}
        accept={ACCEPT}
        maxSizeMB={MAX_XLSX_SHEETS_MB}
        label="Excel（.xlsx）をドラッグ&ドロップ"
        hint={`またはタップして選択（上限${MAX_XLSX_SHEETS_MB}MB）`}
        onFilesSelected={(f) => void handleSelect(f)}
        onError={setInputError}
      />
      {file && <FileList files={[file]} onRemove={clear} />}

      {sheets.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="excel-split-sheets">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">分割するシート（{sheets.length}シート中 {selected.length}）</p>
            <button
              type="button"
              onClick={() => setSelected(allOn ? [] : sheets.map((s) => s.index))}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:border-blue-400 dark:border-neutral-700"
              data-testid="excel-split-toggle-all"
            >
              {allOn ? "すべて外す" : "すべて選ぶ"}
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            {sheets.map((s) => (
              <li key={s.index}>
                <label className="flex min-h-9 min-w-0 items-center gap-2 rounded-md px-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <input
                    type="checkbox"
                    checked={selected.includes(s.index)}
                    onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, s.index] : prev.filter((x) => x !== s.index)))}
                    data-testid="excel-split-sheet"
                  />
                  <span className="min-w-0 truncate">{s.name}</span>
                  {STATE_LABEL[s.state] && <span className="shrink-0 rounded bg-neutral-100 px-1.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{STATE_LABEL[s.state]}</span>}
                  {s.kind === "chartsheet" && <span className="shrink-0 text-[10px] text-neutral-500">グラフシート</span>}
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">ファイル名は、シート名になります（ファイル名に使えない文字は置き換えます）。</p>
        </div>
      )}

      {sheets.length > 0 && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={run.status === "processing" || selected.length === 0}
            aria-busy={run.status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="excel-split-run"
          >
            {selected.length === 0 ? "シートを選んでください" : `${selected.length}シートを分割する`}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={run.status} successLabel="分割が完了しました" />
      {error && <ErrorMessage message={error} testId="excel-sheets-error" />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="excel-split-result">
            {result.files.length}ファイル ・ {formatBytes(result.zip?.size ?? result.files[0].blob.size)}
            {result.zip ? "（ZIPにまとめます）" : ""}
          </p>
          <Notices notices={result.notices} />
          <RewardedDownloadGate
            onDownload={() => (result.zip && file ? downloadBlob(result.zip, `${stripExtension(file.name)}_シート分割.zip`) : downloadBlob(result.files[0].blob, result.files[0].name))}
            label={result.zip ? "ZIPをダウンロード" : "ダウンロード"}
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}

// ---------------------------------------------------------------------------
// 結合
// ---------------------------------------------------------------------------

interface MergeOutput {
  blob: Blob;
  notices: string[];
}

function MergePanel() {
  const [files, setFiles] = useState<File[]>([]);
  const [sheetLists, setSheetLists] = useState<Map<File, SheetInfo[]>>(new Map());
  /** ファイルごとの、結合するシート（元の並びの番号）。最初はすべて */
  const [selection, setSelection] = useState<Map<File, number[]>>(new Map());
  const [inputError, setInputError] = useState<string | null>(null);
  const selectedOf = (f: File) => selection.get(f) ?? (sheetLists.get(f) ?? []).map((s) => s.index);
  const settingKey = files.length > 0 ? files.map((f) => `${fileKey(f)}:${fileIdentity(f)}:${selectedOf(f).join(",")}`).join("|") : "";
  const run = useKeyedRun<MergeOutput>(settingKey);
  const error = run.error ?? inputError;

  async function addFiles(picked: File[]) {
    const errors: string[] = [];
    const ok: File[] = [];
    const lists = new Map(sheetLists);
    for (const f of picked) {
      const bad = badExcel(f);
      if (bad) {
        errors.push(bad);
        continue;
      }
      try {
        lists.set(f, await listSheets(new Uint8Array(await f.arrayBuffer()), f.name));
        ok.push(f);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `${f.name}を読み取れませんでした。`);
      }
    }
    const room = Math.max(0, MAX_XLSX_MERGE_FILES - files.length);
    if (ok.length > room) errors.push(`一度に結合できるのは${MAX_XLSX_MERGE_FILES}ファイルまでです。`);
    setInputError(errors.length ? errors.join(" ") : null);
    setSheetLists(lists);
    setSelection((prev) => {
      const next = new Map(prev);
      for (const f of ok) next.set(f, (lists.get(f) ?? []).map((sh) => sh.index));
      return next;
    });
    if (ok.length && room) setFiles((prev) => [...prev, ...ok.slice(0, room)]);
  }

  function toggleSheet(f: File, index: number, on: boolean) {
    setSelection((prev) => {
      const next = new Map(prev);
      const cur = selectedOf(f);
      next.set(f, on ? [...cur, index].sort((x, y) => x - y) : cur.filter((i) => i !== index));
      return next;
    });
  }

  function toggleFile(f: File, on: boolean) {
    setSelection((prev) => new Map(prev).set(f, on ? (sheetLists.get(f) ?? []).map((sh) => sh.index) : []));
  }

  const totalSelected = files.reduce((n, f) => n + selectedOf(f).length, 0);

  function handleRun() {
    if (totalSelected < 2) return;
    const targets = files.filter((f) => selectedOf(f).length > 0);
    const sel = new Map(targets.map((f) => [f, selectedOf(f)]));
    void run.run(async () => {
      const inputs = await Promise.all(targets.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), sheets: sel.get(f) })));
      const res = await mergeWorkbooks(inputs);
      return { blob: new Blob([res.files[0].bytes as BlobPart], { type: XLSX_MIME }), notices: res.notices };
    });
  }

  const result = run.value;
  const totalSheets = totalSelected;

  // 結合したあとのシート名（重なる名前に番号が付くことを先に見せる）
  const preview: { file: number; name: string; renamed: boolean; state: string }[] = [];
  const used = new Set<string>();
  files.forEach((f, fi) => {
    const chosen = selectedOf(f);
    for (const s of (sheetLists.get(f) ?? []).filter((sh) => chosen.includes(sh.index))) {
      let name = s.name;
      if (used.has(name.toLowerCase())) {
        for (let i = 2; ; i++) {
          const suffix = ` (${i})`;
          const n = `${s.name.slice(0, 31 - suffix.length)}${suffix}`;
          if (!used.has(n.toLowerCase())) {
            name = n;
            break;
          }
        }
      }
      used.add(name.toLowerCase());
      preview.push({ file: fi, name, renamed: name !== s.name, state: s.state });
    }
  });

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        files.length > 0 ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合したあとのシート（{totalSheets}シート・左から順）</p>
            <ol className="flex flex-col gap-1.5" data-testid="excel-merge-preview">
              {preview.map((p, i) => (
                <li key={i} className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white/70 px-3 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
                  <span className="inline-block shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">{p.file + 1}</span>
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.renamed && <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">名前を変更</span>}
                  {STATE_LABEL[p.state] && <span className="shrink-0 text-[10px] text-neutral-500">{STATE_LABEL[p.state]}</span>}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            Excelを選ぶと、ここに結合したあとのシートが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        compact={files.length > 0}
        compactAction="add"
        accept={ACCEPT}
        multiple
        maxSizeMB={MAX_XLSX_SHEETS_MB}
        label="Excel（.xlsx）をドラッグ&ドロップ（複数可）"
        hint={`またはタップして選択（上限${MAX_XLSX_SHEETS_MB}MB）`}
        onFilesSelected={(f) => void addFiles(f)}
        onError={setInputError}
      />
      {files.length > 0 && <ReorderableFileList files={files} onReorder={setFiles} onRemove={(i) => setFiles((prev) => prev.filter((_, x) => x !== i))} />}
      {files.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="excel-merge-sheets">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合するシートを選ぶ（{totalSelected}シートを選択中）</p>
          {files.map((f, fi) => {
            const list = sheetLists.get(f) ?? [];
            const chosen = selectedOf(f);
            const allOn = list.length > 0 && chosen.length === list.length;
            return (
              <div key={fileKey(f)} className="flex flex-col gap-1" data-testid="excel-merge-file-sheets">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                    <span className="inline-block shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">{fi + 1}</span>
                    <span className="min-w-0 truncate">{f.name}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => toggleFile(f, !allOn)}
                    className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:border-blue-400 dark:border-neutral-700"
                    data-testid="excel-merge-toggle-file"
                  >
                    {allOn ? "すべて外す" : "すべて選ぶ"}
                  </button>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {list.map((sh) => (
                    <li key={sh.index}>
                      <label
                        className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm ${
                          chosen.includes(sh.index) ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-300 dark:border-neutral-700"
                        }`}
                      >
                        <input type="checkbox" checked={chosen.includes(sh.index)} onChange={(e) => toggleSheet(f, sh.index, e.target.checked)} data-testid="excel-merge-sheet" />
                        <span className="max-w-[12rem] truncate">{sh.name}</span>
                        {STATE_LABEL[sh.state] && <span className="text-[10px] text-neutral-500">{STATE_LABEL[sh.state]}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            選んだシートだけを、上のファイルの順・シートの順に1つのExcelにまとめます。1つのファイルの中から、いくつかのシートを選んでまとめることもできます。
          </p>
        </div>
      )}
      {files.length > 0 && totalSelected < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="excel-merge-need-more">結合するシートを2つ以上選んでください（ファイルを追加することもできます）。</p>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        シートを1つの表に縦に積み上げたいときは、「Excel・CSV結合」を使ってください。
      </p>

      {totalSelected >= 2 && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={run.status === "processing"}
            aria-busy={run.status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="excel-merge-run"
          >
            選んだ{totalSelected}シートを結合する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={run.status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} testId="excel-sheets-error" />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="excel-merge-result">
            {totalSheets}シート ・ {formatBytes(result.blob.size)}
          </p>
          <Notices notices={result.notices} />
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, `${stripExtension(files[0].name)}_シート結合.xlsx`)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}

function Notices({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-600 dark:text-neutral-300" data-testid="excel-sheets-notices">
      {notices.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
