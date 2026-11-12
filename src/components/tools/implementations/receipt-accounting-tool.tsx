"use client";

import { useCsvExport } from "@/components/common/csv-export-encoding";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { useUnsavedChangesWarning } from "@/components/tools/implementations/shared/use-unsaved-changes-warning";
import { neutralizeFormula, type CsvRecord } from "@/lib/accounting/csv-generic";
import { FREEE_CSV_HEADER, FREEE_TEXT_MAX_LENGTH, type FreeeRecord } from "@/lib/accounting/csv-freee";
import {
  EMPTY_RECEIPT_JOURNAL_DEFAULTS,
  FREEE_TAX_CATEGORY_OPTIONS,
  FREEE_TAX_CATEGORY_OTHER,
  buildReceiptFreeeCsvBlob,
  buildReceiptFreeeRows,
  buildReceiptFreeeXlsxBlob,
  toFreeeRecord,
  validateJournalFields,
  type ReceiptJournalDefaults,
  type ReceiptJournalFields,
} from "@/lib/accounting/freee-receipt";
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
import { duplicateKeys, parseAmountInput, validateRow } from "@/lib/accounting/receipt-validate";
import { checkReceiptDetails, extractReceiptDetails, taxRateLabel, type ReceiptDetailValues } from "@/lib/accounting/receipt-details";
import { downloadBlob } from "@/lib/utils/format";
import { OCR_MAX_PAGES } from "@/lib/pdf/page-limits";
import { terminateOcrWorker } from "@/lib/ocr/tesseract-client";
import { ReceiptReadError, readReceiptFile, type ReadDocument } from "@/lib/processors/browser/receipt-ocr";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { StepHeading } from "@/components/ui/step-heading";

/**
 * 領収書・レシートから会計CSV作成（工程8。新工程1で、freee会計向けに作り直した）。
 *
 * 画面の流れ：1. 初期値（借方勘定科目・貸方勘定科目・課税区分）→ 2. 読み込み → 3. 明細ごとの確認・訂正 →
 * 画面の下の「仕訳プレビュー」で確かめて、freee会計向けCSV・Excel（.xlsx）で出力する。
 * - 対応する会計ソフトは freee会計だけ（取引インポート用CSV。src/lib/accounting/freee-receipt.ts）。汎用CSV・明細CSVの選択は外した。
 * - 初期値は、読み取った明細に最初から入れる値。明細ごとに、日付・取引先・摘要・金額・借方・貸方・課税区分を変えられる。
 *   「支払状況」の選択はなくした（貸方勘定科目＝決済口座を入れれば決済済み、空欄なら未決済）。
 * - 読み取った値は、利用者が確かめて「確認済み」にするまで確定扱いにしない。値を変えると未確認に戻る。
 *   出力するのは確認済みの明細だけ。未確認の明細があるときは、出力の前にはっきり知らせる。
 * - 仕訳プレビューは画面の下に固定して出し、入力を変えるとすぐ反映する。プレビュー・CSV・Excel は同じ行から作る。
 * - ファイル・読み取った内容・入力は、ブラウザの中だけで扱い、送信も保存もしない。
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
  /** 読み取った税率・税額・登録番号・品目（課税区分を選ぶときの参考。工程4） */
  details: ReceiptDetailValues;
  autoDetails: ReceiptDetailValues;
  /** 明細ごとの仕訳（借方勘定科目・貸方勘定科目・課税区分・摘要） */
  journal: ReceiptJournalFields;
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

const FIELD_LABEL: Record<ReceiptFieldKey, string> = { date: "日付", vendor: "取引先", total: "金額（税込）" };

const inputClass =
  "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const labelClass = "flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400";
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

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

const KNOWN_TAX = new Set(FREEE_TAX_CATEGORY_OPTIONS.map((o) => o.value));

/**
 * 課税区分の入力（プルダウン。一覧にない名前は「その他」で入力できる）
 */
function TaxCategoryField({
  value,
  onChange,
  testId,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  testId: string;
  ariaLabel: string;
}) {
  const [otherMode, setOtherMode] = useState(value !== "" && !KNOWN_TAX.has(value));
  const selectValue = otherMode ? FREEE_TAX_CATEGORY_OTHER : value;
  return (
    <div className="flex flex-col gap-1">
      <select
        data-testid={testId}
        aria-label={ariaLabel}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === FREEE_TAX_CATEGORY_OTHER) {
            setOtherMode(true);
            onChange("");
          } else {
            setOtherMode(false);
            onChange(e.target.value);
          }
        }}
        className={inputClass}
      >
        <option value="">選択してください</option>
        {FREEE_TAX_CATEGORY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.note}>
            {o.value}
          </option>
        ))}
        <option value={FREEE_TAX_CATEGORY_OTHER}>その他（freeeの税区分の名前を入力）</option>
      </select>
      {otherMode && (
        <input
          type="text"
          data-testid={`${testId}-other`}
          aria-label={`${ariaLabel}（その他の名前）`}
          value={value}
          maxLength={FREEE_TEXT_MAX_LENGTH}
          placeholder="freeeの画面に表示されている税区分の名前"
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
    </div>
  );
}

export function ReceiptAccountingTool() {
  /** CSVの書き出しの文字コード（UTF-8 BOM付き・BOMなし・Shift_JIS）を選んでダウンロードする */
  const csvExport = useCsvExport();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedSignature, setExportedSignature] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // 読み取りの前に決める初期値（借方勘定科目・貸方勘定科目・課税区分）。保存はしない（画面を閉じると消える）
  const [defaults, setDefaults] = useState<ReceiptJournalDefaults>(EMPTY_RECEIPT_JOURNAL_DEFAULTS);
  // 読み取りの途中（コールバックの中）でも、最新の初期値を使うために ref にも持つ
  const defaultsRef = useRef<ReceiptJournalDefaults>(EMPTY_RECEIPT_JOURNAL_DEFAULTS);
  // 仕訳プレビューの表を開くか。null のあいだは自動（明細があれば開き、0件なら畳む）。ユーザーが開け閉めしたら、その選択に従う
  const [previewOpenChoice, setPreviewOpenChoice] = useState<boolean | null>(null);

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
      const details = extractReceiptDetails(doc.lines, values.total ? parseAmountInput(values.total) : null);
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
        details,
        autoDetails: details,
        // 初期値（借方・貸方・課税区分）を入れる。摘要には、読み取れた品目を入れる（空欄のこともある）
        journal: { ...defaultsRef.current, memo: details.items },
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

  function editJournal(id: string, key: keyof ReceiptJournalFields, value: string) {
    // 仕訳の項目を変えたときも、確認済みを外す
    commitDocs((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, journal: { ...d.journal, [key]: value.slice(0, FREEE_TEXT_MAX_LENGTH) }, confirmed: false, attemptErrors: null } : d,
      ),
    );
  }

  function setDefault(key: keyof ReceiptJournalDefaults, value: string) {
    const next = { ...defaults, [key]: value.slice(0, FREEE_TEXT_MAX_LENGTH) };
    defaultsRef.current = next;
    setDefaults(next);
  }

  /** 初期値を、まだ確認していない明細に入れ直す（確認済みの明細は変えない） */
  function applyDefaultsToUnconfirmed() {
    commitDocs((prev) => prev.map((d) => (d.confirmed ? d : { ...d, journal: { ...d.journal, ...defaults }, attemptErrors: null })));
  }

  function toggleConfirm(id: string) {
    const today = todayIso();
    commitDocs((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        if (d.confirmed) return { ...d, confirmed: false, attemptErrors: null };
        const result = validateRow(d.values, { today });
        const errors = [...result.errors, ...validateJournalFields(d.journal)];
        if (errors.length > 0) return { ...d, attemptErrors: errors };
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

  // 仕訳プレビュー：すべての明細を、出力と同じ行（buildReceiptFreeeRows）にする。出力するのは確認済みの明細だけ
  const plan = useMemo(() => {
    const exportRecords: FreeeRecord[] = [];
    const problems: string[] = [];
    const preview = docs.map((d) => {
      const result = validateRow(d.values, { today });
      const record: CsvRecord | null = result.normalized;
      const freee = record ? toFreeeRecord(record, d.journal) : null;
      const cells = freee ? buildReceiptFreeeRows([freee])[1] : null;
      if (d.confirmed) {
        if (freee) exportRecords.push(freee);
        else problems.push(`「${d.label}」：${[...result.errors, ...validateJournalFields(d.journal)].join(" ")}`);
      }
      return { id: d.id, label: d.label, confirmed: d.confirmed, cells, journal: d.journal, values: d.values };
    });
    return { preview, exportRecords, problems };
  }, [docs, today]);
  const hasJournalRows = plan.preview.length > 0;
  const previewOpen = previewOpenChoice ?? hasJournalRows;

  const confirmedCount = docs.filter((d) => d.confirmed).length;
  const unconfirmedCount = docs.length - confirmedCount;
  const allConfirmed = docs.length > 0 && unconfirmedCount === 0;
  const signature = JSON.stringify(plan.exportRecords);
  const needsExport = docs.length > 0 && (unconfirmedCount > 0 || exportedSignature !== signature);
  useUnsavedChangesWarning(needsExport);

  const formulaGuarded = plan.exportRecords.filter((r) => neutralizeFormula(r.vendor) !== r.vendor).length;
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "reading");
  const doneJobs = jobs.filter((j) => j.status === "done");
  const canExport = plan.exportRecords.length > 0 && plan.problems.length === 0;

  function exportCsv() {
    setExportError(null);
    if (!canExport) {
      setExportError("確認済みの明細がないか、確認済みの明細に不備があります。");
      return;
    }
    const blob = buildReceiptFreeeCsvBlob(plan.exportRecords);
    if (!blob) return;
    void csvExport.download(blob, `receipts-freee-${stamp()}.csv`);
    setExportedSignature(signature);
  }

  async function exportXlsx() {
    setExportError(null);
    if (!canExport) {
      setExportError("確認済みの明細がないか、確認済みの明細に不備があります。");
      return;
    }
    try {
      const blob = await buildReceiptFreeeXlsxBlob(plan.exportRecords);
      if (!blob) return;
      downloadBlob(blob, `receipts-freee-${stamp()}.xlsx`);
      setExportedSignature(signature);
    } catch {
      setExportError("Excelファイルの作成に失敗しました。");
    }
  }

  const COL = {
    date: FREEE_CSV_HEADER.indexOf("発生日"),
    vendor: FREEE_CSV_HEADER.indexOf("取引先"),
    account: FREEE_CSV_HEADER.indexOf("勘定科目"),
    tax: FREEE_CSV_HEADER.indexOf("税区分"),
    amount: FREEE_CSV_HEADER.indexOf("金額"),
    memo: FREEE_CSV_HEADER.indexOf("備考"),
    payAccount: FREEE_CSV_HEADER.indexOf("決済口座"),
  };

  return (
    // 画面の下に固定した仕訳プレビューの裏に、入力欄・ボタンが隠れないよう、移動するときは下に余白をとる
    <div className="flex flex-col gap-6 pb-4 [&_:is(button,input,select,textarea,summary)]:scroll-mb-[50vh]" data-testid="receipt-tool">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        freee会計に取り込むデータを作ります（画像・PDFはこのブラウザの中だけで扱い、送信も保存もしません）。
      </p>

      {/* 1. 初期値 */}
      <section className={sectionClass} aria-labelledby="receipt-step1" data-testid="receipt-defaults">
        <StepHeading n={1} as="h2" id="receipt-step1">初期値を決める</StepHeading>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">読み取った明細に、最初からこの値が入ります（あとで明細ごとに変えられます）。</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className={labelClass}>
            借方勘定科目
            <input
              type="text"
              data-testid="receipt-default-debit"
              value={defaults.debitAccount}
              maxLength={FREEE_TEXT_MAX_LENGTH}
              placeholder="例：消耗品費"
              onChange={(e) => setDefault("debitAccount", e.target.value)}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            貸方勘定科目
            <input
              type="text"
              data-testid="receipt-default-credit"
              value={defaults.creditAccount}
              maxLength={FREEE_TEXT_MAX_LENGTH}
              placeholder="例：現金（空欄なら未決済）"
              onChange={(e) => setDefault("creditAccount", e.target.value)}
              className={inputClass}
            />
          </label>
          <div className={labelClass}>
            課税区分
            <TaxCategoryField
              value={defaults.taxCategory}
              onChange={(v) => setDefault("taxCategory", v)}
              testId="receipt-default-tax"
              ariaLabel="課税区分の初期値"
            />
          </div>
        </div>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          勘定科目は、freeeに登録されている名前をそのまま入力してください。貸方勘定科目にはfreeeの口座（現金・普通預金など）を入れます。空欄にすると、未決済（未払金）として登録されます。
        </p>
        {docs.some((d) => !d.confirmed) && (
          <button type="button" className={`${smallButton} w-fit`} onClick={applyDefaultsToUnconfirmed} data-testid="receipt-apply-defaults">
            この初期値を、未確認の明細に入れ直す
          </button>
        )}
      </section>

      {/* 2. 読み込み */}
      <section className={sectionClass} aria-labelledby="receipt-step2">
        <StepHeading n={2} as="h2" id="receipt-step2">領収書・レシートを読み込む</StepHeading>
        <FileDropzone
          compact={docs.length > 0}
          compactAction="add"
          // accept は渡さない：共通部品は、対応外のファイルが1つでも混ざると全部を断ってしまうため。
          // 形式の確認は、ファイル1つずつ、先頭のバイトで行い、対応外・壊れたファイルだけを個別にエラーにする。
          multiple
          maxSizeMB={1024}
          label="領収書・レシートの画像・PDFをドラッグ&ドロップ"
          hint="またはタップして選択（複数選べます）"
          onFilesSelected={(files) => void handleFiles(files)}
          onError={setNotice}
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          JPG・PNG・WebP・PDF（画像は1枚{RECEIPT_LIMITS.maxImageMB}MB、PDFは{RECEIPT_LIMITS.maxPdfMB}MB・{OCR_MAX_PAGES}ページまで。並べられるのは{RECEIPT_LIMITS.maxDocuments}件まで）
        </p>
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

      {/* 3. 確認・訂正 */}
      <section className={sectionClass} aria-labelledby="receipt-step3">
        <StepHeading n={3} as="h2" id="receipt-step3">明細を確認・訂正する</StepHeading>
        {docs.length === 0 ? (
          <p data-testid="receipt-empty" className="text-sm text-neutral-500 dark:text-neutral-400">
            まだ明細がありません。2. で領収書・レシートを読み込んでください。
          </p>
        ) : (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">元の書類と見比べて訂正し、「確認済みにする」を押してください。確認済みの明細だけを出力します。</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p data-testid="receipt-summary" className="text-sm text-neutral-700 dark:text-neutral-200">
                明細 {docs.length}件：確認済み {confirmedCount}件／未確認 {unconfirmedCount}件
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
            {allConfirmed && (
              <p data-testid="receipt-all-confirmed" className="rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:bg-green-950/30 dark:text-green-200">
                すべての明細を確認済みにしました。下の仕訳プレビューを確かめて、出力してください。
              </p>
            )}

            <PreviewFullscreenFrame>
            <ul className="flex flex-col gap-3" data-testid="tool-preview">
              {docs.map((row) => {
                const live = validateRow(row.values, { today });
                const isDuplicate = duplicates.has(row.id);
                const expanded = expandedId === row.id;
                const readInfo = [
                  row.details.taxRate ? `税率 ${taxRateLabel(row.details.taxRate)}` : "",
                  row.details.taxAmount ? `消費税 ${Number(row.details.taxAmount).toLocaleString("ja-JP")}円` : "",
                  row.details.registrationNumber ? `登録番号 ${row.details.registrationNumber}` : "登録番号 読み取れず",
                ].filter(Boolean);
                return (
                  <li
                    key={row.id}
                    data-testid="receipt-row"
                    data-confirmed={row.confirmed ? "true" : "false"}
                    data-method={row.method}
                    className={`flex flex-col gap-3 rounded-xl border p-3 ${
                      row.confirmed
                        ? "border-green-400 bg-green-50/60 dark:border-green-800 dark:bg-green-950/20"
                        : "border-amber-300 dark:border-amber-800"
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
                        {row.method === "ocr" ? "文字認識（OCR）" : "PDFの文字情報"}
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
                              <label className={labelClass}>
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
                                <span data-testid={`receipt-lowconf-${key}`} className="text-[11px] text-amber-700 dark:text-amber-300">
                                  文字の認識に自信が低い値です。元の書類と見比べてください。
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
                        <label className={`${labelClass} md:col-span-3`}>
                          摘要
                          <input
                            type="text"
                            data-testid="receipt-memo"
                            aria-label={`${row.label}の摘要`}
                            value={row.journal.memo}
                            maxLength={FREEE_TEXT_MAX_LENGTH}
                            placeholder="例：事務用品の購入"
                            onChange={(e) => editJournal(row.id, "memo", e.target.value)}
                            className={inputClass}
                          />
                        </label>
                        <label className={labelClass}>
                          借方勘定科目
                          <input
                            type="text"
                            data-testid="receipt-debit"
                            aria-label={`${row.label}の借方勘定科目`}
                            value={row.journal.debitAccount}
                            maxLength={FREEE_TEXT_MAX_LENGTH}
                            placeholder="例：消耗品費"
                            onChange={(e) => editJournal(row.id, "debitAccount", e.target.value)}
                            className={inputClass}
                          />
                        </label>
                        <label className={labelClass}>
                          貸方勘定科目
                          <input
                            type="text"
                            data-testid="receipt-credit"
                            aria-label={`${row.label}の貸方勘定科目`}
                            value={row.journal.creditAccount}
                            maxLength={FREEE_TEXT_MAX_LENGTH}
                            placeholder="例：現金（空欄なら未決済）"
                            onChange={(e) => editJournal(row.id, "creditAccount", e.target.value)}
                            className={inputClass}
                          />
                        </label>
                        <div className={labelClass}>
                          課税区分
                          <TaxCategoryField
                            value={row.journal.taxCategory}
                            onChange={(v) => editJournal(row.id, "taxCategory", v)}
                            testId="receipt-tax"
                            ariaLabel={`${row.label}の課税区分`}
                          />
                        </div>
                      </div>
                    </div>

                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400" data-testid="receipt-read-info">
                      読み取った参考情報：{readInfo.join("・")}
                    </p>
                    {checkReceiptDetails({ ...row.details, taxCategory: row.journal.taxCategory }, live.normalized?.total ?? null).map((w) => (
                      <p key={w} data-testid="receipt-detail-warning" className="text-xs text-amber-700 dark:text-amber-300">
                        注意：{w}
                      </p>
                    ))}
                    {live.warnings.map((w) => (
                      <p key={w} data-testid="receipt-warning" className="text-xs text-amber-700 dark:text-amber-300">
                        注意：{w}
                      </p>
                    ))}
                    {isDuplicate && (
                      <p data-testid="receipt-duplicate" className="text-xs text-amber-700 dark:text-amber-300">
                        注意：日付・取引先・金額が同じ明細が、ほかにもあります（同じ書類を2回読み込んでいないか確認してください）。
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
                      <summary className="cursor-pointer">読み取った文字を見る</summary>
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
                        この明細を削除する
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            </PreviewFullscreenFrame>
          </>
        )}
      </section>

      {/* 仕訳プレビューと出力。明細があるときだけ、画面の下に固定する（スマホ幅では固定しない）。
          明細が0件のときや、スマホ幅で固定すると、読み込みの案内や明細を大きく覆ってしまうため */}
      <section
        aria-labelledby="receipt-preview-title"
        data-testid="receipt-journal-preview"
        data-sticky={hasJournalRows ? "true" : undefined}
        className={`${hasJournalRows ? "sm:sticky sm:bottom-0 sm:rounded-b-none" : ""} z-20 flex flex-col gap-2 rounded-xl border border-neutral-300 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-950/95`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="receipt-preview-title" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            仕訳プレビュー（freee会計の取引インポート）
          </h2>
          <button
            type="button"
            className={smallButton}
            onClick={() => setPreviewOpenChoice(!previewOpen)}
            aria-expanded={previewOpen}
            data-testid="receipt-preview-toggle"
          >
            {previewOpen ? "表を閉じる" : "表を開く"}
          </button>
        </div>
        <p data-testid="receipt-export-count" className="text-xs text-neutral-700 dark:text-neutral-200">
          出力：確認済み {plan.exportRecords.length}件
          {unconfirmedCount > 0 && (
            <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300" data-testid="receipt-unconfirmed-warning">
              ／未確認 {unconfirmedCount}件は出力されません。確認してから出力してください。
            </span>
          )}
        </p>
        {previewOpen && (
          <div className="max-h-[25vh] sm:max-h-[35vh] overflow-auto" data-testid="receipt-export-preview">
            {plan.preview.length === 0 ? (
              <p data-testid="receipt-export-empty" className="text-xs text-neutral-500 dark:text-neutral-400">
                確認済みのデータがありません。明細を読み込んで確認すると、ここに仕訳が表示されます。
              </p>
            ) : (
              <table className="w-full min-w-[44rem] border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-white dark:bg-neutral-950">
                  <tr className="border-b border-neutral-200 dark:border-neutral-800">
                    {["状態", "発生日", "取引先", "摘要（備考）", "借方勘定科目（勘定科目）", "貸方勘定科目（決済口座）", "課税区分（税区分）", "金額"].map((h) => (
                      <th key={h} className="px-2 py-1 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plan.preview.map((p) => (
                    <tr
                      key={p.id}
                      data-testid="receipt-preview-row"
                      data-confirmed={p.confirmed ? "true" : "false"}
                      className={`border-b border-neutral-100 dark:border-neutral-900 ${p.confirmed ? "" : "text-neutral-400 dark:text-neutral-500"}`}
                    >
                      <td className="px-2 py-1 whitespace-nowrap">{p.confirmed ? "確認済み" : "未確認（出力しない）"}</td>
                      {p.cells ? (
                        <>
                          <td className="px-2 py-1 whitespace-nowrap">{p.cells[COL.date]}</td>
                          <td className="px-2 py-1">{p.cells[COL.vendor]}</td>
                          <td className="px-2 py-1">{p.cells[COL.memo]}</td>
                          <td className="px-2 py-1">{p.cells[COL.account]}</td>
                          <td className="px-2 py-1">{p.cells[COL.payAccount] || "（未決済）"}</td>
                          <td className="px-2 py-1">{p.cells[COL.tax]}</td>
                          <td className="px-2 py-1 text-right">{Number(p.cells[COL.amount]).toLocaleString("ja-JP")}</td>
                        </>
                      ) : (
                        <td className="px-2 py-1 text-amber-700 dark:text-amber-300" colSpan={7}>
                          入力が足りないため、まだ仕訳にできません（{p.label}）
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {formulaGuarded > 0 && (
          <p data-testid="receipt-formula-note" className="text-[11px] text-neutral-500 dark:text-neutral-400">
            取引先の先頭が「=」「+」「-」「@」の{formulaGuarded}件は、Excelで数式として動かないよう、先頭に「&apos;」を付けて出力します。
          </p>
        )}
        {plan.problems.length > 0 && (
          <div data-testid="receipt-export-problems" className="text-xs text-red-700 dark:text-red-300">
            {plan.problems.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        )}
        {exportError && <ErrorMessage message={exportError} />}
        {csvExport.picker}
        {csvExport.confirm}
        <div className="flex flex-wrap items-center gap-3">
          <RewardedDownloadGate onDownload={exportCsv} label="freee用CSVをダウンロード" disabled={!canExport} />
          <RewardedDownloadGate onDownload={() => void exportXlsx()} label="Excelをダウンロード" disabled={!canExport} />
        </div>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          freee会計の［取引入力］→［収入・支出形式］→［…］→「取引データのインポート」で取り込みます。取り込みの成功は保証できません。取り込む前にfreeeの確認画面で確かめてください。
        </p>
      </section>
    </div>
  );
}
