"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob, formatBytes } from "@/lib/utils/format";
import { detectOfficeKind, readDocxContent, readXlsxBook, type OfficeKind } from "@/lib/compare/office-reader";
import { countByKind, DIFF_KIND_LABEL, diffDocx, diffXlsx, type DiffKind, type DiffResult, type DiffRow } from "@/lib/compare/file-diff";
import {
  countByStatus,
  extractFromDocx,
  extractFromXlsx,
  MATCH_RULES,
  MATCH_STATUS_LABEL,
  matchItems,
  type ExtractedItem,
  type MatchRow,
  type MatchStatus,
} from "@/lib/compare/item-match";
import { exportReportDocx, exportReportXlsx, reportFileName, type CompareReport } from "@/lib/compare/report-export";
import { diffChars } from "@/lib/compare/sequence-diff";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { RunBar } from "@/components/ui/run-bar";
import { StepHeading } from "@/components/ui/step-heading";

type Mode = "diff" | "match";

interface Picked {
  file: File;
  kind: OfficeKind;
  macro: boolean;
}

const ACCEPT = ".xlsx,.xlsm,.docx,.xls,.doc,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel.sheet.macroEnabled.12";
const MAX_MB = 30;
const PAGE_SIZE = 300;

const KIND_NAME: Record<OfficeKind, string> = { xlsx: "Excel", docx: "Word" };

type DiffOutcome = { mode: "diff"; result: DiffResult };
type MatchOutcome = { mode: "match"; itemsA: ExtractedItem[]; itemsB: ExtractedItem[] };

const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const smallButton =
  "ms-focus-ring rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800";

function formatLabel(p: Picked): string {
  if (p.kind === "docx") return "Word（.docx）";
  return p.macro ? "Excel（.xlsm・マクロ有効）" : "Excel（.xlsx）";
}

const STATUS_STYLE: Record<MatchStatus, string> = {
  match: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  mismatch: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
  missing: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200",
  review: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
};

export function OfficeCompareTool() {
  const [mode, setMode] = useState<Mode>("diff");
  const [fileA, setFileA] = useState<Picked | null>(null);
  const [fileB, setFileB] = useState<Picked | null>(null);
  const [compareFormulas, setCompareFormulas] = useState(true);
  const [alignRows, setAlignRows] = useState(true);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<(DiffOutcome | MatchOutcome) & { fileA: string; fileB: string; createdAt: Date } | null>(null);
  const [manualPairs, setManualPairs] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<"xlsx" | "docx">("xlsx");
  const [exportError, setExportError] = useState<string | null>(null);

  function resetResult() {
    setOutcome(null);
    setStatus("idle");
    setError(null);
    setManualPairs({});
    setExcluded(new Set());
    setExportError(null);
  }

  async function pick(slot: "A" | "B", files: File[]) {
    const file = files[0];
    if (!file) return;
    resetResult();
    const kind = await detectOfficeKind(file);
    if ("problem" in kind) {
      setError(kind.message);
      return;
    }
    const picked: Picked = { file, kind: kind.kind, macro: kind.macro };
    if (slot === "A") setFileA(picked);
    else setFileB(picked);
  }

  function swap() {
    setFileA(fileB);
    setFileB(fileA);
    resetResult();
  }

  const kindMismatch = mode === "diff" && fileA && fileB && fileA.kind !== fileB.kind;
  const canRun = !!fileA && !!fileB && !kindMismatch && status !== "processing";

  async function run() {
    if (!fileA || !fileB) return;
    resetResult();
    setStatus("processing");
    // 「比較中」の表示を先に出してから、重い処理に入る
    await new Promise((r) => setTimeout(r, 30));
    try {
      const read = async (p: Picked) => (p.kind === "xlsx" ? { kind: "xlsx" as const, book: await readXlsxBook(p.file, p.macro) } : { kind: "docx" as const, doc: await readDocxContent(p.file) });
      const [ra, rb] = await Promise.all([read(fileA), read(fileB)]);
      const base = { fileA: fileA.file.name, fileB: fileB.file.name, createdAt: new Date() };
      if (mode === "diff") {
        const result =
          ra.kind === "xlsx" && rb.kind === "xlsx"
            ? diffXlsx(ra.book, rb.book, { compareFormulas, alignRows })
            : ra.kind === "docx" && rb.kind === "docx"
              ? diffDocx(ra.doc, rb.doc)
              : null;
        if (!result) throw new Error("ファイルの差分は、Excel同士・Word同士で比べます。");
        setOutcome({ mode: "diff", result, ...base });
      } else {
        const itemsA = ra.kind === "xlsx" ? extractFromXlsx(ra.book) : extractFromDocx(ra.doc);
        const itemsB = rb.kind === "xlsx" ? extractFromXlsx(rb.book) : extractFromDocx(rb.doc);
        setOutcome({ mode: "match", itemsA, itemsB, ...base });
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "比べられませんでした。ファイルが壊れていないか確かめてください。");
      setStatus("error");
    }
  }

  const matchRows = useMemo(() => {
    if (!outcome || outcome.mode !== "match") return null;
    return matchItems(outcome.itemsA, outcome.itemsB, manualPairs).rows;
  }, [outcome, manualPairs]);

  const report: CompareReport | null = useMemo(() => {
    if (!outcome) return null;
    if (outcome.mode === "diff") return { mode: "diff", fileA: outcome.fileA, fileB: outcome.fileB, createdAt: outcome.createdAt, result: outcome.result };
    const rows = (matchRows ?? []).filter((r) => !excluded.has(r.id));
    const notes = [
      `ファイルAから${outcome.itemsA.length}件、ファイルBから${outcome.itemsB.length}件の項目を取り出しました。`,
      ...(excluded.size > 0 ? [`利用者が「比べない」にした項目（${excluded.size}件）は、結果に含めていません。`] : []),
    ];
    return { mode: "match", fileA: outcome.fileA, fileB: outcome.fileB, createdAt: outcome.createdAt, rows, notes };
  }, [outcome, matchRows, excluded]);

  async function download() {
    if (!report) return;
    setExportError(null);
    try {
      const blob = exportFormat === "xlsx" ? await exportReportXlsx(report) : await exportReportDocx(report);
      downloadBlob(blob, reportFileName(report, exportFormat));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "ファイルを作成できませんでした。もう一度お試しください。");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass} aria-labelledby="cmp-step1">
        <StepHeading n={1} as="h2" id="cmp-step1">調べ方を選ぶ</StepHeading>
        <div role="radiogroup" aria-label="調べ方" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { value: "diff", title: "ファイルの差分を調べる", desc: "同じファイルの2つの版で、変わった箇所を探します（Excel同士・Word同士）" },
              { value: "match", title: "文書間の不一致を調べる", desc: "見積書と注文書など、別々の資料に書かれた項目・金額・日付を照合します（ExcelとWordの組み合わせも可）" },
            ] as { value: Mode; title: string; desc: string }[]
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={mode === opt.value}
              data-testid={`cmp-mode-${opt.value}`}
              onClick={() => {
                setMode(opt.value);
                resetResult();
              }}
              className={`ms-focus-ring flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                mode === opt.value
                  ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/40"
                  : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              }`}
            >
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{opt.title}</span>
              <span className="text-xs text-neutral-600 dark:text-neutral-300">{opt.desc}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="cmp-formats">
          {mode === "diff"
            ? "対応形式：Excel（.xlsx・.xlsm）同士、またはWord（.docx）同士。古い形式（.xls・.doc）とパスワード付きのファイルは読み込めません。"
            : "対応形式：Excel（.xlsx・.xlsm）とWord（.docx）。2つのファイルの形式が違っていても照合できます。古い形式（.xls・.doc）とパスワード付きのファイルは読み込めません。"}
        </p>
      </section>

      <section className={sectionClass} aria-labelledby="cmp-step2">
        <StepHeading n={2} as="h2" id="cmp-step2">比べる2つのファイルを選ぶ</StepHeading>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-start">
          <FileSlot title={mode === "diff" ? "ファイルA（比較元・前の版）" : "ファイルA"} picked={fileA} onPick={(f) => pick("A", f)} onClear={() => { setFileA(null); resetResult(); }} onError={setError} slot="a" />
          <div className="flex justify-center md:pt-10">
            <button type="button" onClick={swap} disabled={!fileA && !fileB} className={smallButton} data-testid="cmp-swap" aria-label="ファイルAとファイルBを入れ替える">
              ⇄ 入れ替える
            </button>
          </div>
          <FileSlot title={mode === "diff" ? "ファイルB（比較先・新しい版）" : "ファイルB"} picked={fileB} onPick={(f) => pick("B", f)} onClear={() => { setFileB(null); resetResult(); }} onError={setError} slot="b" secondary />
        </div>

        {(fileA || fileB) && (
          <PreviewFullscreenFrame>
          <div data-testid="tool-preview" className="flex flex-col gap-1 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300">
            <p className="font-medium text-neutral-800 dark:text-neutral-100">選んだファイル</p>
            <p>
              A：{fileA ? `${fileA.file.name}（${formatLabel(fileA)}・${formatBytes(fileA.file.size)}）` : "まだ選んでいません"}
            </p>
            <p>
              B：{fileB ? `${fileB.file.name}（${formatLabel(fileB)}・${formatBytes(fileB.file.size)}）` : "まだ選んでいません"}
            </p>
            {kindMismatch && (
              <p className="font-medium text-red-700 dark:text-red-300" data-testid="cmp-kind-mismatch">
                ファイルの差分は、Excel同士・Word同士で比べます。ExcelとWordを照合するときは「文書間の不一致を調べる」を選んでください。
              </p>
            )}
            {(fileA?.macro || fileB?.macro) && <p>マクロ有効ブック（.xlsm）は、セルの値と数式だけを読み取ります。マクロは比べません。元のファイルは変更しません。</p>}
          </div>
          </PreviewFullscreenFrame>
        )}

        {mode === "diff" && (fileA?.kind === "xlsx" || fileB?.kind === "xlsx") && (
          <div className="flex flex-col gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="ms-focus-ring mt-1" checked={compareFormulas} onChange={(e) => { setCompareFormulas(e.target.checked); resetResult(); }} data-testid="cmp-formulas" />
              <span>
                数式も比べる
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">外すと、セルの値（数式のセルは計算結果）だけを比べます</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="ms-focus-ring mt-1" checked={alignRows} onChange={(e) => { setAlignRows(e.target.checked); resetResult(); }} data-testid="cmp-align" />
              <span>
                行の追加・削除を見つける
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">外すと、同じ番地のセルどうしを比べます（行を足した下は、すべて違いとして出ます）</span>
              </span>
            </label>
          </div>
        )}

        <RunBar>
          <button
            type="button"
            onClick={run}
            disabled={!canRun}
            aria-busy={status === "processing" || undefined}
            data-testid="cmp-run"
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            比べる
          </button>
        </RunBar>
        {!fileA || !fileB ? <p className="text-xs text-neutral-500 dark:text-neutral-400">2つのファイルを選ぶと、「比べる」を押せます。</p> : null}
      </section>

      <ProcessingStatus state={status} processingLabel="比べています…" successLabel="比べ終わりました" />
      {error && <ErrorMessage message={error} />}

      {outcome && report && (
        <section className={sectionClass} aria-labelledby="cmp-step3" data-testid="cmp-result">
          <StepHeading n={3} as="h2" id="cmp-step3">結果</StepHeading>
          {outcome.mode === "diff" ? (
            <DiffView result={outcome.result} />
          ) : (
            <MatchView
              rows={matchRows ?? []}
              itemsA={outcome.itemsA}
              itemsB={outcome.itemsB}
              manualPairs={manualPairs}
              onManualPair={(aKey, bKey) => setManualPairs((prev) => { const next = { ...prev }; if (bKey) next[aKey] = bKey; else delete next[aKey]; return next; })}
              excluded={excluded}
              onToggleExcluded={(id) => setExcluded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
            />
          )}

          <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">結果をファイルで保存する</p>
            <div role="radiogroup" aria-label="保存の形式" className="ms-seg">
              {(
                [
                  { value: "xlsx", label: "Excel（一覧の表）" },
                  { value: "docx", label: "Word（レポート）" },
                ] as { value: "xlsx" | "docx"; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={exportFormat === opt.value}
                  data-testid={`cmp-export-${opt.value}`}
                  onClick={() => setExportFormat(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <RewardedDownloadGate onDownload={download} label={exportFormat === "xlsx" ? "Excelでダウンロード" : "Wordでダウンロード"} />
            {exportError && <ErrorMessage message={exportError} />}
          </div>
        </section>
      )}
    </div>
  );
}

function FileSlot({
  title,
  picked,
  onPick,
  onClear,
  onError,
  slot,
  secondary,
}: {
  title: string;
  picked: Picked | null;
  onPick: (files: File[]) => void;
  onClear: () => void;
  onError: (m: string) => void;
  slot: "a" | "b";
  secondary?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`cmp-slot-${slot}`}>
      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{title}</p>
      {picked ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <p className="break-all text-sm text-neutral-900 dark:text-neutral-100" data-testid={`cmp-file-${slot}`}>
            {picked.file.name}
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            {KIND_NAME[picked.kind]}として読み込みます（{formatLabel(picked)}）
          </p>
          <button type="button" onClick={onClear} className={`${smallButton} w-fit`} data-testid={`cmp-clear-${slot}`}>
            選び直す
          </button>
        </div>
      ) : (
        <FileDropzone
          accept={ACCEPT}
          maxSizeMB={MAX_MB}
          label={`${title.replace(/（.*）/, "")}をドラッグ&ドロップ`}
          hint={`またはタップして選択（.xlsx・.xlsm・.docx／${MAX_MB}MBまで）`}
          onFilesSelected={onPick}
          onError={onError}
          acceptHandoff={!secondary}
        />
      )}
    </div>
  );
}

function Notes({ notes, title = "比べた範囲・扱い" }: { notes: string[]; title?: string }) {
  return (
    <details className="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300" data-testid="cmp-notes">
      <summary className="cursor-pointer font-medium text-neutral-800 dark:text-neutral-100">{title}</summary>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </details>
  );
}

function Highlighted({ before, after, side }: { before: string; after: string; side: "before" | "after" }) {
  const spans = useMemo(() => diffChars(before, after), [before, after]);
  const text = side === "before" ? before : after;
  if (!spans) return <>{text}</>;
  return (
    <>
      {spans.map((s, i) => {
        if (s.type === "equal") return <span key={i}>{s.text}</span>;
        if (side === "before" && s.type === "delete")
          return (
            <del key={i} className="rounded bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100">
              {s.text}
            </del>
          );
        if (side === "after" && s.type === "insert")
          return (
            <ins key={i} className="rounded bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-900/50 dark:text-emerald-100">
              {s.text}
            </ins>
          );
        return null;
      })}
    </>
  );
}

function DiffView({ result }: { result: DiffResult }) {
  const [filter, setFilter] = useState<DiffKind | "all">("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const counts = countByKind(result.rows);
  const rows = filter === "all" ? result.rows : result.rows.filter((r) => r.kind === filter);
  const isXlsx = result.target === "xlsx";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-neutral-800 dark:text-neutral-100" data-testid="cmp-summary">
        {result.rows.length === 0 ? (
          <span className="font-semibold text-emerald-700 dark:text-emerald-300">違いはありませんでした（比べた範囲では、2つのファイルは同じ内容です）。</span>
        ) : (
          <>
            違いが <span className="font-semibold">{result.rows.length.toLocaleString("ja-JP")}件</span> 見つかりました。
          </>
        )}
      </p>
      {result.rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="差分の種類で絞り込む">
          <FilterChip active={filter === "all"} onClick={() => { setFilter("all"); setShown(PAGE_SIZE); }} label={`すべて（${result.rows.length}）`} />
          {(Object.keys(counts) as DiffKind[]).map((k) => (
            <FilterChip key={k} active={filter === k} onClick={() => { setFilter(k); setShown(PAGE_SIZE); }} label={`${DIFF_KIND_LABEL[k]}（${counts[k]}）`} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div className="max-h-[36rem] overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[40rem] border-collapse text-xs" data-testid="cmp-diff-table">
            <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">{isXlsx ? "シート" : "見出し"}</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">{isXlsx ? "セル・行" : "場所"}</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">比較元（A）</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">比較先（B）</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">差分</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r, i) => (
                <DiffTableRow key={i} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown && (
        <button type="button" className={`${smallButton} w-fit`} onClick={() => setShown((s) => s + PAGE_SIZE)} data-testid="cmp-more">
          さらに表示（{shown.toLocaleString("ja-JP")}件 / {rows.length.toLocaleString("ja-JP")}件を表示中）
        </button>
      )}
      <Notes notes={result.notes} />
    </div>
  );
}

function DiffTableRow({ row }: { row: DiffRow }) {
  const textChange = row.kind === "text-changed" || row.kind === "space-changed";
  return (
    <tr className="border-t border-neutral-200 align-top dark:border-neutral-800" data-testid="cmp-diff-row" data-kind={row.kind}>
      <td className="max-w-40 px-2 py-1.5 [overflow-wrap:anywhere]">{row.group || "—"}</td>
      <td className="whitespace-nowrap px-2 py-1.5 font-mono">{row.location}</td>
      <td className="max-w-80 whitespace-pre-wrap px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="cmp-before">
        {textChange ? <Highlighted before={row.before} after={row.after} side="before" /> : row.before || "—"}
      </td>
      <td className="max-w-80 whitespace-pre-wrap px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="cmp-after">
        {textChange ? <Highlighted before={row.before} after={row.after} side="after" /> : row.after || "—"}
      </td>
      <td className="px-2 py-1.5">
        <span className="whitespace-nowrap font-medium">{DIFF_KIND_LABEL[row.kind]}</span>
        {row.note && <span className="block text-neutral-500 dark:text-neutral-400">{row.note}</span>}
      </td>
    </tr>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`ms-focus-ring rounded-full px-2.5 py-1 text-xs font-medium ${
        active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
      }`}
    >
      {label}
    </button>
  );
}

function MatchView({
  rows,
  itemsA,
  itemsB,
  manualPairs,
  onManualPair,
  excluded,
  onToggleExcluded,
}: {
  rows: MatchRow[];
  itemsA: ExtractedItem[];
  itemsB: ExtractedItem[];
  manualPairs: Record<string, string>;
  onManualPair: (aKey: string, bKey: string | null) => void;
  excluded: Set<string>;
  onToggleExcluded: (id: string) => void;
}) {
  const [filter, setFilter] = useState<MatchStatus | "all">("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const active = rows.filter((r) => !excluded.has(r.id));
  const counts = countByStatus(active);
  const visible = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  // 手動の対応づけ：Aだけにある項目に、Bだけにある項目（またはいま組にしている項目）を選べるようにする
  const aOnly = rows.filter((r) => r.id.startsWith("a:") && (r.status === "missing" || manualPairs[r.id.slice(2)]));
  const bOnlyKeys = rows.filter((r) => r.id.startsWith("b:")).map((r) => ({ key: r.id.slice(2), label: r.labelB, value: r.valueB }));
  const bLabels = new Map<string, string>();
  for (const it of itemsB) if (!bLabels.has(it.key)) bLabels.set(it.key, it.label);

  if (itemsA.length === 0 || itemsB.length === 0) {
    return (
      <div className="flex flex-col gap-2" data-testid="cmp-summary">
        <p className="text-sm text-neutral-800 dark:text-neutral-100">
          {itemsA.length === 0 && itemsB.length === 0 ? "どちらのファイルからも" : itemsA.length === 0 ? "ファイルAから" : "ファイルBから"}
          、照合できる「項目と値」を取り出せませんでした。
        </p>
        <p className="text-xs text-neutral-600 dark:text-neutral-300">「項目：値」の形の文、または表に「項目 | 値」と並んだ形で書かれた項目を照合します。下の「照合のルール」をご覧ください。</p>
        <Notes notes={MATCH_RULES} title="照合のルール" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-neutral-800 dark:text-neutral-100" data-testid="cmp-summary">
        {active.length.toLocaleString("ja-JP")}項目を照合しました：一致 {counts.match}件・不一致 {counts.mismatch}件・片方に記載なし {counts.missing}件・要確認 {counts.review}件
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ファイルAから{itemsA.length}件、ファイルBから{itemsB.length}件の項目を取り出しました。「比べる」のチェックを外した項目は、件数と保存するファイルに含めません。
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="判定で絞り込む">
        <FilterChip active={filter === "all"} onClick={() => { setFilter("all"); setShown(PAGE_SIZE); }} label={`すべて（${rows.length}）`} />
        {(["mismatch", "review", "missing", "match"] as MatchStatus[]).map((s) => (
          <FilterChip key={s} active={filter === s} onClick={() => { setFilter(s); setShown(PAGE_SIZE); }} label={`${MATCH_STATUS_LABEL[s]}（${rows.filter((r) => r.status === s).length}）`} />
        ))}
      </div>
      <div className="max-h-[36rem] overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[44rem] border-collapse text-xs" data-testid="cmp-match-table">
          <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">比べる</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">項目</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">ファイルA</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">ファイルB</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">判定</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, shown).map((r) => {
              const off = excluded.has(r.id);
              return (
                <tr key={r.id} className={`border-t border-neutral-200 align-top dark:border-neutral-800 ${off ? "opacity-50" : ""}`} data-testid="cmp-match-row" data-status={r.status} data-label={r.labelA || r.labelB}>
                  <td className="px-2 py-1.5">
                    <input type="checkbox" className="ms-focus-ring" checked={!off} onChange={() => onToggleExcluded(r.id)} aria-label={`「${r.labelA || r.labelB}」を比べる`} data-testid="cmp-include" />
                  </td>
                  <td className="max-w-48 px-2 py-1.5 [overflow-wrap:anywhere]">
                    {r.labelA && r.labelB && r.labelA !== r.labelB ? `${r.labelA} ⇔ ${r.labelB}` : r.labelA || r.labelB}
                  </td>
                  <td className="max-w-64 px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="cmp-value-a">
                    {r.valueA}
                    {r.locationA && <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{r.locationA}</span>}
                  </td>
                  <td className="max-w-64 px-2 py-1.5 [overflow-wrap:anywhere]" data-testid="cmp-value-b">
                    {r.valueB}
                    {r.locationB && <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{r.locationB}</span>}
                  </td>
                  <td className="max-w-72 px-2 py-1.5">
                    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-semibold ${STATUS_STYLE[r.status]}`} data-testid="cmp-status">
                      {MATCH_STATUS_LABEL[r.status]}
                    </span>
                    <span className="mt-0.5 block text-neutral-600 dark:text-neutral-300" data-testid="cmp-reason">
                      {r.reason}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visible.length > shown && (
        <button type="button" className={`${smallButton} w-fit`} onClick={() => setShown((s) => s + PAGE_SIZE)}>
          さらに表示（{shown}件 / {visible.length}件を表示中）
        </button>
      )}

      {aOnly.length > 0 && (bOnlyKeys.length > 0 || Object.keys(manualPairs).length > 0) && (
        <details className="rounded-lg border border-neutral-200 p-3 text-xs dark:border-neutral-800" data-testid="cmp-manual" open={Object.keys(manualPairs).length > 0}>
          <summary className="cursor-pointer text-sm font-medium text-neutral-800 dark:text-neutral-100">対応づける項目を選ぶ（項目名が違うとき）</summary>
          <p className="mt-2 text-neutral-600 dark:text-neutral-300">ファイルAだけにある項目に、ファイルBの同じ意味の項目を選ぶと、2つを照合します（例：「合計金額」と「お見積金額」）。</p>
          <ul className="mt-2 flex flex-col gap-2">
            {aOnly.map((r) => {
              const aKey = r.id.slice(2);
              const current = manualPairs[aKey] ?? "";
              const options = [...bOnlyKeys, ...(current && !bOnlyKeys.some((b) => b.key === current) ? [{ key: current, label: bLabels.get(current) ?? current, value: "" }] : [])];
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-32 font-medium text-neutral-800 dark:text-neutral-100">{r.labelA}</span>
                  <span aria-hidden="true">⇔</span>
                  <select
                    value={current}
                    onChange={(e) => onManualPair(aKey, e.target.value || null)}
                    aria-label={`「${r.labelA}」に対応するファイルBの項目`}
                    data-testid="cmp-manual-select"
                    className="ms-focus-ring max-w-full rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">（対応づけない）</option>
                    {options.map((b) => (
                      <option key={b.key} value={b.key}>
                        {b.label}
                        {b.value ? `（${b.value.length > 20 ? `${b.value.slice(0, 20)}…` : b.value}）` : ""}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <Notes notes={MATCH_RULES} title="照合のルール" />
    </div>
  );
}
