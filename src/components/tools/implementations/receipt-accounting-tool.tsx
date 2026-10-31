"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { useUnsavedChangesWarning } from "@/components/tools/implementations/shared/use-unsaved-changes-warning";
import { buildGenericCsvBlob, neutralizeFormula, type CsvRecord } from "@/lib/accounting/csv-generic";
import { extractReceipt, formatDateSlash } from "@/lib/accounting/receipt-extract";
import { checkReceiptFile, detectReceiptFileKind, type ReceiptFileKind } from "@/lib/accounting/receipt-file-kind";
import {
  RECEIPT_LIMITS,
  type FieldExtraction,
  type ReadMethod,
  type ReceiptEditableValues,
  type ReceiptExtraction,
  type ReceiptFieldKey,
  type TextLine,
} from "@/lib/accounting/receipt-types";
import { duplicateKeys, validateRow } from "@/lib/accounting/receipt-validate";
import { OCR_MAX_PAGES } from "@/lib/pdf/page-limits";
import { terminateOcrWorker } from "@/lib/ocr/tesseract-client";
import { ReceiptReadError, readReceiptFile, type ReadDocument } from "@/lib/processors/browser/receipt-ocr";
import { downloadBlob } from "@/lib/utils/format";

/**
 * 領収書・レシートから会計CSV作成（工程8）。
 * 画像・PDFを読み込み、日付・取引先・合計金額を抽出して、利用者が確認・修正した行だけを汎用CSVに出力する。
 * すべてブラウザの中で処理する。ファイル・読み取った内容は、サーバーへ送らず、端末にも保存しない。
 */

interface DocRow {
  id: string;
  /** 画面に出す名前（ファイル名。PDFはページ番号つき） */
  label: string;
  method: ReadMethod;
  previewUrl: string;
  lines: TextLine[];
  extraction: ReceiptExtraction;
  /** 自動で入れた値（入力欄の値と比べて「自動読み取り」か「修正済み」かを示す） */
  autoValues: ReceiptEditableValues;
  values: ReceiptEditableValues;
  confirmed: boolean;
  /** 確認済みにしようとして、検証に通らなかったときのエラー */
  attemptErrors: string[] | null;
}

type JobStatus = "queued" | "reading" | "done" | "error";

interface Job {
  id: string;
  /** 画面に出す名前（ファイル名） */
  fileName: string;
  status: JobStatus;
  message: string | null;
  progress: string | null;
  documents: number;
}

interface QueueItem {
  jobId: string;
  file: File;
  kind: ReceiptFileKind;
  generation: number;
}

const FIELD_LABEL: Record<ReceiptFieldKey, string> = { date: "日付", vendor: "取引先", total: "合計金額" };

const inputClass =
  "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const GENERIC_JOB_ERROR = "このファイルを読み取れませんでした。別のファイルでお試しください。";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function candidateLabel(key: ReceiptFieldKey, value: string): string {
  if (key === "date") return formatDateSlash(value);
  if (key === "total") return `${Number(value).toLocaleString("ja-JP")}円`;
  return value;
}

function initialValues(extraction: ReceiptExtraction): ReceiptEditableValues {
  return {
    date: extraction.date.value ?? "",
    vendor: extraction.vendor.value ?? "",
    total: extraction.total.value ?? "",
  };
}

function sourceLabel(row: DocRow, key: ReceiptFieldKey): string {
  const current = row.values[key];
  if (current.trim() === "") return "未入力";
  return current === row.autoValues[key] ? "自動読み取り" : "入力・修正済み";
}

export function ReceiptAccountingTool() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedSignature, setExportedSignature] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const docsRef = useRef<DocRow[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const generationRef = useRef(0);
  const idRef = useRef(0);
  const lastProgressRef = useRef<Record<string, string>>({});

  const nextId = useCallback((prefix: string) => {
    idRef.current += 1;
    return `${prefix}${idRef.current}`;
  }, []);

  /** 書類の一覧を更新する（最新の一覧を ref にも保ち、読み取りの途中でも件数を正しく数えられるようにする） */
  const commitDocs = useCallback((update: (prev: DocRow[]) => DocRow[]) => {
    const next = update(docsRef.current);
    docsRef.current = next;
    setDocs(next);
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  // 画面を離れるときに、読み取りを止め、画像のプレビュー用URLと、OCRのWorkerを手放す
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      queueRef.current = [];
      for (const d of docsRef.current) URL.revokeObjectURL(d.previewUrl);
      void terminateOcrWorker();
    };
  }, []);

  const addDocument = useCallback(
    (item: QueueItem, fileName: string, doc: ReadDocument) => {
      if (item.generation !== generationRef.current) return; // 「すべて消去」のあとに届いた結果は捨てる
      const extraction = extractReceipt(doc.lines);
      const values = initialValues(extraction);
      const label = doc.pageNumber !== null ? `${fileName}（${doc.pageNumber}/${doc.pageCount}ページ）` : fileName;
      const row: DocRow = {
        id: nextId("d"),
        label,
        method: doc.method,
        previewUrl: URL.createObjectURL(doc.preview),
        lines: doc.lines,
        extraction,
        autoValues: values,
        values,
        confirmed: false,
        attemptErrors: null,
      };
      commitDocs((prev) => [...prev, row]);
      setJobs((prev) => prev.map((j) => (j.id === item.jobId ? { ...j, documents: j.documents + 1 } : j)));
    },
    [commitDocs, nextId],
  );

  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setProcessing(true);
    try {
      while (queueRef.current.length > 0) {
        const item = queueRef.current.shift()!;
        if (item.generation !== generationRef.current) continue;
        const fileName = item.file.name;
        if (cancelRef.current) {
          updateJob(item.jobId, { status: "error", message: "読み取りを中止しました。", progress: null });
          continue;
        }
        if (RECEIPT_LIMITS.maxDocuments - docsRef.current.length <= 0) {
          updateJob(item.jobId, {
            status: "error",
            message: `画面に並べられる書類は${RECEIPT_LIMITS.maxDocuments}件までです。不要な行を削除してから、もう一度追加してください。`,
            progress: null,
          });
          continue;
        }
        updateJob(item.jobId, { status: "reading", progress: "読み取りを始めています…" });
        let stoppedBySlots = false;
        try {
          await readReceiptFile(item.file, item.kind, {
            onDocument: (doc) => addDocument(item, fileName, doc),
            onProgress: (p) => {
              const percent = Math.round(p.fraction * 100);
              const text =
                p.total > 1
                  ? `${p.current}/${p.total}ページを${p.method === "ocr" ? "文字認識（OCR）中" : "文字情報から読み取り中"}… ${percent}%`
                  : `文字認識（OCR）中… ${percent}%`;
              if (lastProgressRef.current[item.jobId] === text) return;
              lastProgressRef.current[item.jobId] = text;
              updateJob(item.jobId, { progress: text });
            },
            isCancelled: () => cancelRef.current || item.generation !== generationRef.current,
            remainingSlots: () => {
              const left = RECEIPT_LIMITS.maxDocuments - docsRef.current.length;
              if (left <= 0) stoppedBySlots = true;
              return left;
            },
          });
          if (item.generation === generationRef.current) {
            updateJob(item.jobId, {
              status: "done",
              progress: null,
              message: stoppedBySlots
                ? `書類は${RECEIPT_LIMITS.maxDocuments}件までのため、途中のページまでを読み込みました。`
                : cancelRef.current
                  ? "読み取りを中止しました（読み取り済みの分は一覧にあります）。"
                  : null,
            });
          }
        } catch (e) {
          if (item.generation === generationRef.current) {
            updateJob(item.jobId, {
              status: "error",
              progress: null,
              message: e instanceof ReceiptReadError ? e.message : GENERIC_JOB_ERROR,
            });
          }
        }
        delete lastProgressRef.current[item.jobId];
      }
    } finally {
      runningRef.current = false;
      cancelRef.current = false;
      setProcessing(false);
    }
  }, [addDocument, updateJob]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      setConfirmReset(false);
      const accepted = files.slice(0, RECEIPT_LIMITS.maxFilesPerAdd);
      if (files.length > accepted.length) {
        setNotice(`一度に追加できるのは${RECEIPT_LIMITS.maxFilesPerAdd}ファイルまでです。${files.length - accepted.length}ファイルは追加していません。`);
      }
      const generation = generationRef.current;
      for (const file of accepted) {
        const jobId = nextId("j");
        let kind: ReceiptFileKind | null = null;
        let problem: string | null;
        try {
          const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
          kind = detectReceiptFileKind(head);
          problem = checkReceiptFile(kind, file.size);
        } catch {
          problem = "ファイルを読み込めませんでした。";
        }
        const job: Job = {
          id: jobId,
          fileName: file.name,
          status: problem ? "error" : "queued",
          message: problem,
          progress: null,
          documents: 0,
        };
        if (generation !== generationRef.current) return;
        setJobs((prev) => [...prev, job]);
        if (!problem && kind) queueRef.current.push({ jobId, file, kind, generation });
      }
      void runQueue();
    },
    [nextId, runQueue],
  );

  function cancelReading() {
    cancelRef.current = true;
  }

  function resetAll() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    generationRef.current += 1;
    queueRef.current = [];
    for (const d of docsRef.current) URL.revokeObjectURL(d.previewUrl);
    commitDocs(() => []);
    setJobs([]);
    setNotice(null);
    setExportError(null);
    setExportedSignature(null);
    setExpandedId(null);
    setConfirmReset(false);
  }

  function deleteDoc(id: string) {
    const target = docsRef.current.find((d) => d.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    commitDocs((prev) => prev.filter((d) => d.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function editValue(id: string, key: ReceiptFieldKey, value: string) {
    // 値を変えたら、確認済みを外す（変更前の値で確認したことにしない）
    commitDocs((prev) => prev.map((d) => (d.id === id ? { ...d, values: { ...d.values, [key]: value }, confirmed: false, attemptErrors: null } : d)));
  }

  function toggleConfirm(id: string) {
    const today = todayIso();
    commitDocs((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        if (d.confirmed) return { ...d, confirmed: false, attemptErrors: null };
        const result = validateRow(d.values, { today });
        if (result.errors.length > 0) return { ...d, attemptErrors: result.errors };
        return { ...d, confirmed: true, attemptErrors: null };
      }),
    );
  }

  function clearConfirmations() {
    commitDocs((prev) => prev.map((d) => ({ ...d, confirmed: false })));
  }

  function dismissJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  const today = todayIso();
  const duplicates = useMemo(() => duplicateKeys(docs.map((d) => ({ id: d.id, values: d.values }))), [docs]);

  // 出力の対象：確認済みで、検証を通った行だけ
  const exportPlan = useMemo(() => {
    const records: CsvRecord[] = [];
    const problems: string[] = [];
    for (const d of docs) {
      if (!d.confirmed) continue;
      const result = validateRow(d.values, { today });
      if (result.normalized) records.push(result.normalized);
      else problems.push(`「${d.label}」：${result.errors.join(" ")}`);
    }
    return { records, problems };
  }, [docs, today]);

  const confirmedCount = docs.filter((d) => d.confirmed).length;
  const unconfirmedCount = docs.length - confirmedCount;
  const signature = JSON.stringify(exportPlan.records);
  const needsExport = docs.length > 0 && (unconfirmedCount > 0 || exportedSignature !== signature);
  useUnsavedChangesWarning(needsExport);

  const formulaGuarded = exportPlan.records.filter((r) => neutralizeFormula(r.vendor) !== r.vendor).length;
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "reading");
  const doneJobs = jobs.filter((j) => j.status === "done");

  function exportCsv() {
    setExportError(null);
    if (exportPlan.problems.length > 0) {
      setExportError("確認済みの行に、入力の不備があります。該当の行を直してください。");
      return;
    }
    const blob = buildGenericCsvBlob(exportPlan.records);
    if (!blob) {
      setExportError("確認済みのデータがありません。");
      return;
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    downloadBlob(blob, `receipts-${stamp}.csv`);
    setExportedSignature(signature);
  }

  return (
    <div className="flex flex-col gap-6" data-testid="receipt-tool">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        読み込んだ画像・PDFと、読み取った内容は、このブラウザの中だけで処理します。サーバーへの送信や、端末への保存はしません（画面を閉じると消えます）。
      </p>

      {/* 1. 読み込み */}
      <section className={sectionClass} aria-labelledby="receipt-step1">
        <h2 id="receipt-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          1. 領収書・レシートを読み込む
        </h2>
        <FileDropzone
          // accept は渡さない：共通部品は、対応外のファイルが1つでも混ざると全部を断ってしまうため。
          // 形式の確認は、ファイル1つずつ、先頭のバイトで行い、対応外・壊れたファイルだけを個別にエラーにする。
          multiple
          maxSizeMB={1024}
          label="領収書・レシートの画像・PDFをドラッグ&ドロップ"
          hint="またはタップして選択（複数選べます）"
          onFilesSelected={(files) => void handleFiles(files)}
          onError={setNotice}
        />
        <ul className="list-disc pl-5 text-xs text-neutral-500 dark:text-neutral-400">
          <li>対応形式：JPG・PNG・WebP・PDF（HEICなどには対応していません）。</li>
          <li>
            上限：画像は1枚{RECEIPT_LIMITS.maxImageMB}MB、PDFは1つ{RECEIPT_LIMITS.maxPdfMB}MB・{OCR_MAX_PAGES}ページまで。一度に{RECEIPT_LIMITS.maxFilesPerAdd}ファイルまで、画面に並べられるのは{RECEIPT_LIMITS.maxDocuments}件までです（PDFは1ページを1件として数えます）。
          </li>
          <li>文字情報のあるPDFはその文字を使い、画像やスキャンしたPDFは、ブラウザの中の文字認識（OCR）で読み取ります。1件ずつ順に処理するため、時間がかかることがあります。</li>
        </ul>
        {notice && (
          <div data-testid="receipt-notice">
            <ErrorMessage message={notice} />
          </div>
        )}

        {jobs.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="receipt-jobs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="receipt-job-summary" className="text-sm text-neutral-700 dark:text-neutral-200">
                {processing ? `読み取り中：残り${activeJobs.length}ファイル` : "読み取りは完了しています"}
                {doneJobs.length > 0 && `（読み込み済み ${doneJobs.length}ファイル）`}
              </p>
              {processing && (
                <button type="button" className={smallButton} onClick={cancelReading} data-testid="receipt-cancel">
                  読み取りを中止する
                </button>
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {jobs
                .filter((j) => j.status !== "done" || j.message)
                .map((job) => (
                  <li
                    key={job.id}
                    data-testid="receipt-job"
                    data-status={job.status}
                    className={`flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                      job.status === "error"
                        ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                        : "border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-300"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{job.fileName}</span>
                      <span className="block">
                        {job.status === "queued" && "順番待ちです"}
                        {job.status === "reading" && (job.progress ?? "読み取り中…")}
                        {job.status === "error" && (job.message ?? GENERIC_JOB_ERROR)}
                        {job.status === "done" && job.message}
                      </span>
                    </span>
                    {(job.status === "error" || job.status === "done") && (
                      <button type="button" className={smallButton} onClick={() => dismissJob(job.id)}>
                        閉じる
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </section>

      {/* 2. 確認・修正 */}
      <section className={sectionClass} aria-labelledby="receipt-step2">
        <h2 id="receipt-step2" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          2. 読み取り結果を確認・修正する
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          読み取り結果には誤りが含まれることがあります。元の書類と見比べて、日付・取引先・合計金額を確かめ、「確認済みにする」を押した行だけがCSVに出力されます。自動では確認済みになりません。値を直すと、確認済みは外れます。
        </p>

        {docs.length === 0 ? (
          <p data-testid="receipt-empty" className="text-sm text-neutral-500 dark:text-neutral-400">
            まだ書類が読み込まれていません。上の枠から、領収書・レシートの画像やPDFを選んでください。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="receipt-summary" className="text-sm text-neutral-700 dark:text-neutral-200">
                書類 {docs.length}件：確認済み {confirmedCount}件／未確認 {unconfirmedCount}件
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={smallButton} onClick={clearConfirmations} disabled={confirmedCount === 0}>
                  確認済みをすべて外す
                </button>
                <button type="button" className={smallButton} onClick={resetAll} data-testid="receipt-reset">
                  {confirmReset ? "本当にすべて消去する" : "すべて消去する"}
                </button>
              </div>
            </div>

            <ul className="flex flex-col gap-3" data-testid="tool-preview">
              {docs.map((row) => {
                const live = validateRow(row.values, { today });
                const isDuplicate = duplicates.has(row.id);
                const expanded = expandedId === row.id;
                return (
                  <li
                    key={row.id}
                    data-testid="receipt-row"
                    data-confirmed={row.confirmed ? "true" : "false"}
                    data-method={row.method}
                    className={`flex flex-col gap-3 rounded-xl border p-3 ${
                      row.confirmed
                        ? "border-green-400 bg-green-50/60 dark:border-green-800 dark:bg-green-950/20"
                        : "border-neutral-200 dark:border-neutral-800"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          data-testid="receipt-status"
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                            row.confirmed
                              ? "bg-green-600 text-white"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                          }`}
                        >
                          {row.confirmed ? "確認済み" : "未確認"}
                        </span>
                        <span data-testid="receipt-label" className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                          {row.label}
                        </span>
                      </div>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        {row.method === "ocr" ? "文字認識（OCR）で読み取り" : "PDFの文字情報から読み取り"}
                      </span>
                    </div>

                    <div className="flex flex-col gap-3 md:flex-row">
                      <div className="flex shrink-0 flex-col gap-1">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={row.previewUrl}
                          alt={`${row.label}の元の書類`}
                          data-testid="receipt-preview"
                          className={`rounded-md border border-neutral-200 object-contain dark:border-neutral-700 ${
                            expanded ? "max-h-[32rem] w-full max-w-md" : "h-24 w-24"
                          }`}
                        />
                        <button type="button" className={smallButton} onClick={() => setExpandedId(expanded ? null : row.id)} aria-expanded={expanded}>
                          {expanded ? "縮小する" : "拡大して確認"}
                        </button>
                      </div>

                      <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-3">
                        {(["date", "vendor", "total"] as const).map((key) => {
                          const field: FieldExtraction = row.extraction[key];
                          const current = row.values[key];
                          const candidates = field.candidates.filter((c) => c.value !== current);
                          return (
                            <div key={key} className="flex flex-col gap-1">
                              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                                {FIELD_LABEL[key]}
                                {key === "date" ? (
                                  <input
                                    type="date"
                                    data-testid="receipt-date"
                                    aria-label={`${row.label}の日付`}
                                    value={current}
                                    onChange={(e) => editValue(row.id, key, e.target.value)}
                                    className={inputClass}
                                  />
                                ) : (
                                  <input
                                    type="text"
                                    inputMode={key === "total" ? "numeric" : "text"}
                                    data-testid={key === "vendor" ? "receipt-vendor" : "receipt-total"}
                                    aria-label={`${row.label}の${FIELD_LABEL[key]}`}
                                    value={current}
                                    placeholder={key === "total" ? "例：1280" : "例：株式会社〇〇"}
                                    onChange={(e) => editValue(row.id, key, e.target.value)}
                                    className={inputClass}
                                  />
                                )}
                              </label>
                              <span data-testid={`receipt-source-${key}`} className="text-[11px] text-neutral-500 dark:text-neutral-400">
                                {sourceLabel(row, key)}
                              </span>
                              {field.note && current.trim() === "" && (
                                <span className="text-[11px] text-amber-700 dark:text-amber-300">{field.note}</span>
                              )}
                              {field.lowConfidence && current === row.autoValues[key] && current !== "" && (
                                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                                  文字の認識に自信が低い行から読み取った値です。元の書類と見比べてください。
                                </span>
                              )}
                              {candidates.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1" data-testid={`receipt-candidates-${key}`}>
                                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400">候補：</span>
                                  {candidates.slice(0, 5).map((c) => (
                                    <button
                                      key={c.value}
                                      type="button"
                                      title={c.reason}
                                      aria-label={`${FIELD_LABEL[key]}の候補「${candidateLabel(key, c.value)}」を使う。${c.reason}`}
                                      onClick={() => editValue(row.id, key, c.value)}
                                      className="max-w-full truncate rounded-md border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                                    >
                                      {candidateLabel(key, c.value)}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {row.method === "text-layer" && (
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        PDFに文字情報があっても、正しく読み取れているとは限りません。画像と見比べて確認してください。
                      </p>
                    )}
                    {live.warnings.map((w) => (
                      <p key={w} data-testid="receipt-warning" className="text-xs text-amber-700 dark:text-amber-300">
                        注意：{w}
                      </p>
                    ))}
                    {isDuplicate && (
                      <p data-testid="receipt-duplicate" className="text-xs text-amber-700 dark:text-amber-300">
                        注意：日付・取引先・合計金額が同じ行が、ほかにもあります（同じ書類を2回読み込んでいないか確認してください。自動では削除しません）。
                      </p>
                    )}
                    {row.attemptErrors && (
                      <div data-testid="receipt-row-errors" role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                        確認済みにできません。
                        <ul className="list-disc pl-5">
                          {row.attemptErrors.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <details className="text-xs text-neutral-600 dark:text-neutral-300">
                      <summary className="cursor-pointer">読み取った文字を見る（確認用）</summary>
                      <pre data-testid="receipt-raw-text" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 dark:bg-neutral-900">
                        {row.lines.length === 0 ? "（文字を読み取れませんでした）" : row.lines.map((l) => l.text).join("\n")}
                      </pre>
                    </details>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid="receipt-confirm"
                        aria-pressed={row.confirmed}
                        onClick={() => toggleConfirm(row.id)}
                        className={`rounded-lg px-4 py-2 text-sm font-medium ${
                          row.confirmed
                            ? "bg-neutral-200 text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100"
                            : "bg-green-600 text-white hover:bg-green-700"
                        }`}
                      >
                        {row.confirmed ? "確認済みを取り消す" : "確認済みにする"}
                      </button>
                      <button type="button" data-testid="receipt-delete" className={smallButton} onClick={() => deleteDoc(row.id)}>
                        この行を削除する
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* 3. 出力 */}
      <section className={sectionClass} aria-labelledby="receipt-step3">
        <h2 id="receipt-step3" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          3. CSVを出力する
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          確認済みにした行だけを、日付・取引先・合計金額のCSV（UTF-8・Excelで開けます）として保存します。書類に書かれた合計金額をそのまま出力し、税込・税抜は区別しません。勘定科目・税区分は含みません。
          特定の会計ソフト専用の形式ではなく、会計ソフトへの取り込みを保証するものではありません。会計・税務の助言ではなく、電子帳簿保存法に対応した保存の仕組みでもありません。
        </p>
        <p data-testid="receipt-export-count" className="text-sm text-neutral-700 dark:text-neutral-200">
          出力される書類：{exportPlan.records.length}件（確認済み {confirmedCount}件／未確認 {unconfirmedCount}件。未確認の行は出力されません）
        </p>

        {exportPlan.records.length === 0 ? (
          <p data-testid="receipt-export-empty" className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
            確認済みのデータがありません。上の一覧で、内容を確かめた行の「確認済みにする」を押すと、ここに出力内容が表示されます。
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="receipt-export-preview">
            <table className="w-full min-w-[20rem] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  <th className="px-2 py-1 font-medium">日付</th>
                  <th className="px-2 py-1 font-medium">取引先</th>
                  <th className="px-2 py-1 text-right font-medium">合計金額</th>
                </tr>
              </thead>
              <tbody>
                {exportPlan.records.map((r, i) => (
                  <tr key={i} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="px-2 py-1">{formatDateSlash(r.date)}</td>
                    <td className="px-2 py-1">{r.vendor}</td>
                    <td className="px-2 py-1 text-right">{r.total.toLocaleString("ja-JP")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {formulaGuarded > 0 && (
          <p data-testid="receipt-formula-note" className="text-xs text-neutral-500 dark:text-neutral-400">
            取引先が「=」「+」「-」「@」で始まる{formulaGuarded}件は、Excelで数式として実行されないよう、CSVでは先頭に「&apos;」を付けて出力します。
          </p>
        )}
        {exportPlan.problems.length > 0 && (
          <div data-testid="receipt-export-problems">
            <ErrorMessage message="確認済みの行に、入力の不備があります。該当の行を直してください。" />
            <ul className="mt-1 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
              {exportPlan.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {exportError && <ErrorMessage message={exportError} />}
        <div>
          <RewardedDownloadGate
            onDownload={exportCsv}
            label="CSVをダウンロード"
            disabled={exportPlan.records.length === 0 || exportPlan.problems.length > 0}
          />
        </div>
      </section>
    </div>
  );
}
