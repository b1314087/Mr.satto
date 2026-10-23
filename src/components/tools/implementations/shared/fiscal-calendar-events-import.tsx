"use client";

import { useId, useRef, useState } from "react";
import { placeEvents, calendarDateRange } from "@/lib/calendar/events";
import {
  COLUMN_ROLES,
  COLUMN_ROLE_LABELS,
  columnLabels,
  detectLayout,
  parseEventRows,
  pickEventSheet,
  summarizeImport,
  type ColumnMapping,
  type ColumnRole,
  type EventCellValue,
  type ImportResult,
} from "@/lib/calendar/event-import";
import type { FiscalCalendar } from "@/lib/calendar/model";
import type { CalendarEvent } from "@/lib/calendar/events";
import { featureFlags } from "@/lib/config/features";
import { MAX_IMAGES } from "@/lib/ai/calendar-assist";
import { EVENT_FILE_ACCEPT, LEGACY_EXCEL_MESSAGE, UNSUPPORTED_FILE_MESSAGE, classifyEventFile, decodeCsvBytes, parseCsv } from "@/lib/calendar/event-file";
import type { PreparedImage } from "@/lib/calendar/event-image";
import { FiscalCalendarAiAssist } from "./fiscal-calendar-ai-assist";
import { FiscalCalendarImageAssist, type ImageDraft } from "./fiscal-calendar-image-assist";

/** 読み込んだExcelの予定表（シートごとの行）と、いま選んでいるシート・列の割り当て・読み取り結果 */
export interface EventImportState {
  fileName: string;
  sheets: { name: string; rows: EventCellValue[][] }[];
  sheetIndex: number;
  /** 見出し行の位置（0始まり）。見出しなしは -1 */
  headerRow: number;
  mapping: ColumnMapping;
  /** 列を自動で判定できたか（false のときは、列の選択を開いて知らせる） */
  detected: boolean;
  /** 日付・予定の列が決まっているときの読み取り結果 */
  result: ImportResult | null;
  /** 読み取りで起きたエラー（行数が多すぎるなど） */
  error: string | null;
  /** 読み込んだ元（Excel・CSV・PDFの文字・AIで読み取った画像）。画面の案内に使う */
  source?: "excel" | "csv" | "pdf" | "image";
  /** 読み込み方についての案内（PDFのページ数・AIで読み取った内容の確認のお願いなど） */
  sourceNote?: string | null;
  /** AIの提案から、利用者が確認して採用した予定（通常の読み取り結果とは別に保持する。シート・列の割り当てを変えると破棄する） */
  aiEvents?: CalendarEvent[];
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_ISSUE_ROWS_SHOWN = 30;

const EMPTY_MAPPING: ColumnMapping = { date: null, title: null, start: null, end: null };

/** 列の割り当てから読み取り結果を作る（日付・予定の列が決まっていないときは null） */
function compute(rows: EventCellValue[][], mapping: ColumnMapping, headerRow: number): { result: ImportResult | null; error: string | null } {
  if (mapping.date === null || mapping.title === null) return { result: null, error: null };
  try {
    return { result: parseEventRows(rows, mapping, headerRow), error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : "予定表の読み込みに失敗しました" };
  }
}

function stateForSheet(base: Pick<EventImportState, "fileName" | "sheets" | "source" | "sourceNote">, sheetIndex: number): EventImportState {
  const rows = base.sheets[sheetIndex].rows;
  const layout = detectLayout(rows);
  const mapping = layout?.mapping ?? EMPTY_MAPPING;
  const headerRow = layout?.headerRow ?? 0;
  return { ...base, sheetIndex, headerRow, mapping, detected: !!layout, ...compute(rows, mapping, headerRow), aiEvents: [] };
}

const selectClass = "rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Excelの予定表（日付・予定・開始時刻・終了時刻の一覧）を読み込む部品。
 * ファイルの内容は、この端末のブラウザの中だけで読み取り、外部へは送信しない。
 */
export function FiscalCalendarEventsImport({
  calendar,
  value,
  onChange,
}: {
  calendar: FiscalCalendar;
  value: EventImportState | null;
  onChange: (next: EventImportState | null) => void;
}) {
  const inputId = useId();
  /** 読み込み中の案内（空でなければ処理中。処理中は、新しいファイルを受け付けない＝二重実行の防止） */
  const [busy, setBusy] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** AIで読み取る前の画像（画像ファイル・スキャンPDF）。確認・同意のあとに読み取り、結果を確認してから反映する */
  const [pending, setPending] = useState<{ source: "image" | "scanned-pdf"; fileName: string; images: PreparedImage[]; note: string | null } | null>(null);
  /** 最後に読んだPDF（文字として読めた場合も、画像としてAIで読み直せるように保持。ブラウザの画面の中だけ） */
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  /** 取り消した・別のファイルに替えた読み込みの結果を捨てるための番号 */
  const loadSeq = useRef(0);
  const dragDepth = useRef(0);

  function resetAll() {
    loadSeq.current++;
    setBusy(null);
    setFileError(null);
    setPending(null);
    setPdfFile(null);
    onChange(null);
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0 || busy) return;
    setFileError(null);
    const kinds = files.map(classifyEventFile);
    if (kinds.includes("legacy-excel")) return setFileError(LEGACY_EXCEL_MESSAGE);
    if (kinds.includes("unsupported")) return setFileError(UNSUPPORTED_FILE_MESSAGE);
    const allImages = kinds.every((k) => k === "image");
    if (!allImages && files.length > 1) return setFileError(`一度に選べるのは、Excel・CSV・PDFは1つ、画像は${MAX_IMAGES}枚までです。`);
    if (allImages && files.length > MAX_IMAGES) return setFileError(`画像は一度に${MAX_IMAGES}枚までです。`);
    const kind = kinds[0];
    const file = files[0];
    if ((kind === "excel" || kind === "csv") && file.size > MAX_FILE_BYTES) {
      return setFileError("ファイルが大きすぎます（10MBまで）。予定の行だけを残したファイルにして選んでください。");
    }
    if (kind === "pdf" && file.size > MAX_PDF_BYTES) return setFileError("PDFが大きすぎます（30MBまで）。ページを減らしてから選んでください。");
    if (kind === "image" && !featureFlags.billing) {
      return setFileError("画像の読み取りはAI（Premium）の機能で、現在ご利用いただけません。Excel・CSV・文字のPDFは読み込めます。");
    }

    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    try {
      if (kind === "excel") {
        setBusy("Excelを読み込んでいます…");
        const { readXlsxSheets } = await import("@/lib/excel/xlsx-simple-io");
        const sheets = await readXlsxSheets(file);
        if (stale()) return;
        const base = { fileName: file.name, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows as EventCellValue[][] })), source: "excel" as const };
        setPending(null);
        setPdfFile(null);
        onChange(stateForSheet(base, pickEventSheet(base.sheets)));
      } else if (kind === "csv") {
        setBusy("CSVを読み込んでいます…");
        const rows = parseCsv(decodeCsvBytes(await file.arrayBuffer()));
        if (stale()) return;
        if (rows.every((r) => r.every((c) => String(c).trim() === ""))) throw new Error("CSVにデータがありません。");
        setPending(null);
        setPdfFile(null);
        onChange(stateForSheet({ fileName: file.name, sheets: [{ name: "CSV", rows }], source: "csv" }, 0));
      } else if (kind === "pdf") {
        await handlePdf(file, seq);
      } else {
        setBusy("画像を読み込んでいます…");
        const { prepareImageFile } = await import("@/lib/calendar/event-image");
        const images: PreparedImage[] = [];
        for (const f of files) {
          setBusy(`画像を読み込んでいます…（${images.length + 1}/${files.length}枚目）`);
          images.push(await prepareImageFile(f));
          if (stale()) return;
        }
        setPdfFile(null);
        setPending({ source: "image", fileName: files.map((f) => f.name).join("、"), images, note: null });
      }
    } catch (e) {
      if (!stale()) setFileError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
    } finally {
      if (!stale()) setBusy(null);
    }
  }

  /** PDF: まず文字情報から表を読み取る（ブラウザの中だけ）。文字情報がなければ、ページを画像にしてAIで読み取る準備をする */
  async function handlePdf(file: File, seq: number) {
    const stale = () => seq !== loadSeq.current;
    setBusy("PDFを読み込んでいます…");
    // 先に、「月ごとの列に、日・曜日・予定が縦に並ぶ」形式（学校の行事予定表など）かを調べる
    const { extractMonthColumnEntries, resolveMonthColumnEntries, MIN_DAY_ROWS } = await import("@/lib/calendar/pdf-month-columns");
    const monthly = await extractMonthColumnEntries(file, (cur, total) => {
      if (!stale()) setBusy(`PDFの文字を読み取っています…（${cur}/${total}ページ）`);
    });
    if (stale()) return;
    if (monthly.dayRowCount >= MIN_DAY_ROWS) {
      const resolved = resolveMonthColumnEntries(monthly.entries, calendarDateRange(calendar));
      if (resolved.rows.length === 0) throw new Error("PDFから予定を読み取れませんでした（日付と曜日は見つかりましたが、予定の文字がありませんでした）。");
      setPdfFile(file);
      const notes = ["月ごとに日・曜日・予定が並ぶ行事予定表として読み取りました。年は、書かれている曜日に合う年から判定しています。"];
      if (resolved.unresolved > 0) notes.push(`曜日が合う年がなく、年を決められなかった予定が${resolved.unresolved}件あります（下の「確認が必要な行」に出ます）。`);
      if (resolved.skippedHolidayLabels > 0) notes.push(`「元日」などの祝日の名前だけの行（${resolved.skippedHolidayLabels}件）は、カレンダーに祝日が出るため、読み取っていません。`);
      if (monthly.pageCount > monthly.pagesRead) notes.push(`先頭の${monthly.pagesRead}ページだけを読み取りました。`);
      notes.push("日付のない注記（下の欄外のメモなど）は読み取っていません。内容を確認してください。");
      setPending(null);
      onChange(
        stateForSheet({ fileName: file.name, sheets: [{ name: "PDF（月ごとの行事予定）", rows: [["日付", "予定"], ...resolved.rows] }], source: "pdf", sourceNote: notes.join("") }, 0),
      );
      return;
    }
    const { extractPdfTextRows } = await import("@/lib/processors/browser/pdf-to-excel");
    const text = await extractPdfTextRows(file, (cur, total) => {
      if (!stale()) setBusy(`PDFの文字を読み取っています…（${cur}/${total}ページ）`);
    });
    if (stale()) return;
    setPdfFile(file);
    if (text.textPageCount === 0) {
      // 文字情報のないPDF（スキャン）: 画像として読み取る
      await prepareScannedPdf(file, seq, `このPDFには文字情報がありませんでした（スキャンした画像のPDFです）。`);
      return;
    }
    if (text.rows.length === 0) {
      throw new Error("PDFから表として認識できる内容が見つかりませんでした。下の「画像としてAIで読み取る」をお試しください。");
    }
    const notes = [`PDFの文字情報から表を読み取りました（${text.textPageCount}ページ分）。`];
    if (text.pageCount > text.pagesRead) notes.push(`先頭の${text.pagesRead}ページだけを読み取りました。`);
    if (text.emptyPages.length > 0) notes.push(`文字情報のないページ（${text.emptyPages.slice(0, 10).join("・")}ページ）は読み取っていません。`);
    notes.push("PDFの表は、列や行がずれて読み取られることがあります。件数と内容を確認してください。");
    setPending(null);
    onChange(stateForSheet({ fileName: file.name, sheets: [{ name: `PDF（${text.pagesRead}ページ）`, rows: text.rows }], source: "pdf", sourceNote: notes.join("") }, 0));
  }

  async function prepareScannedPdf(file: File, seq: number, lead: string) {
    const stale = () => seq !== loadSeq.current;
    if (!featureFlags.billing) {
      throw new Error("文字情報のないPDF（スキャン）の読み取りはAI（Premium）の機能で、現在ご利用いただけません。");
    }
    const { preparePdfPages } = await import("@/lib/calendar/event-image");
    const prepared = await preparePdfPages(file, (m) => {
      if (!stale()) setBusy(m);
    });
    if (stale()) return;
    const note = `${lead}${prepared.truncated ? `先頭の${prepared.images.length}ページ（全${prepared.pageCount}ページ）だけを読み取ります。残りは、別のPDFにして読み取ってください。` : ""}`;
    setPending({ source: "scanned-pdf", fileName: file.name, images: prepared.images, note });
  }

  /** 文字として読めたPDFを、画像としてAIで読み直す（表の読み取りがうまくいかなかったとき） */
  async function rereadPdfAsImage() {
    if (!pdfFile || busy) return;
    setFileError(null);
    const seq = ++loadSeq.current;
    try {
      await prepareScannedPdf(pdfFile, seq, "このPDFを画像として読み取ります。");
    } catch (e) {
      if (seq === loadSeq.current) setFileError(e instanceof Error ? e.message : "PDFを画像にできませんでした");
    } finally {
      if (seq === loadSeq.current) setBusy(null);
    }
  }

  /** AIの読み取り結果（利用者が確認・修正したもの）を、Excelと同じ取り込みの流れに渡す */
  function applyImageDrafts(drafts: ImageDraft[]) {
    if (!pending) return;
    const rows: EventCellValue[][] = [
      ["日付", "予定", "開始時刻", "終了時刻", "曜日"],
      ...drafts.map((d) => [d.date, d.title, d.startTime, d.endTime, d.weekday ?? ""] as EventCellValue[]),
    ];
    onChange(
      stateForSheet(
        {
          fileName: `${pending.fileName}（AIの読み取り結果）`,
          sheets: [{ name: "AIの読み取り結果", rows }],
          source: "image",
          sourceNote: "AIが画像から読み取った内容を、確認・修正したものです。内容に誤りがないか、元の画像と見比べて確認してください。",
        },
        0,
      ),
    );
    setPending(null);
  }

  function update(patch: Partial<Pick<EventImportState, "mapping" | "headerRow">>) {
    if (!value) return;
    const mapping = patch.mapping ?? value.mapping;
    const headerRow = patch.headerRow ?? value.headerRow;
    // 列の割り当てが変わると行の意味が変わるため、AIの提案から採用した予定は破棄する
    onChange({ ...value, mapping, headerRow, ...compute(value.sheets[value.sheetIndex].rows, mapping, headerRow), aiEvents: [] });
  }

  const rows = value ? value.sheets[value.sheetIndex].rows : [];
  const labels = value ? columnLabels(rows, value.headerRow) : [];
  const placed = value?.result ? placeEvents(calendar, value.result.events) : null;
  const summary = value?.result && placed ? summarizeImport(value.result, placed.inRange.length) : null;
  const range = calendarDateRange(calendar);
  const rangeLabel = `${range.start.replace(/-/g, "/")}〜${range.end.replace(/-/g, "/")}`;
  const outOfRangeSample = placed ? [...new Set(placed.outOfRange.map((e) => e.date.replace(/-/g, "/")))].sort().slice(0, 5) : [];

  return (
    <fieldset data-testid="events-import" className="flex flex-col gap-2 text-sm">
      <legend className="mb-1 text-neutral-600 dark:text-neutral-300">予定データ</legend>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        日付・予定・開始時刻・終了時刻が並んだ予定表（Excel・CSV・PDF・画像）を選ぶと、カレンダーの該当する日に予定を入れます。Excel・CSV・文字のPDFは、この端末の中だけで処理され、サーバーには送信されません。画像とスキャンしたPDFは、AI（Premium）で読み取るため、内容を確認して同意したときだけ、縮小した画像をAIに送ります。
      </p>
      <div
        data-testid="events-dropzone"
        data-dragging={dragging}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          // ドロップを受け付ける（これがないと、ブラウザがファイルを開いてしまう）
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void handleFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
          dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
        }`}
      >
        <p data-testid="events-drop-label" className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {dragging ? "ここで手を離すと読み込みます" : "ここにファイルをドラッグ＆ドロップ"}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">またはボタンで選択（スマートフォンでは、ボタンから選べます）。Excel（.xlsx）・CSV・PDF・画像（PNG・JPG）に対応しています。</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <label
            htmlFor={inputId}
            className={`rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 ${
              busy ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800"
            }`}
          >
            {value || pending ? "別のファイルを選ぶ" : "ファイルを選ぶ"}
          </label>
          <input
            id={inputId}
            data-testid="events-file"
            type="file"
            multiple
            accept={EVENT_FILE_ACCEPT}
            disabled={!!busy}
            className="sr-only"
            onChange={(e) => {
              void handleFiles(Array.from(e.target.files ?? []));
              // 同じファイルをもう一度選べるようにする
              e.target.value = "";
            }}
          />
          {(value || pending || busy) && (
            <button
              type="button"
              data-testid="events-clear"
              onClick={resetAll}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {busy ? "読み込みを中止する" : "予定の読み込みを取り消す"}
            </button>
          )}
        </div>
        {busy && (
          <p role="status" data-testid="events-busy" className="text-xs text-neutral-600 dark:text-neutral-300">
            {busy}
          </p>
        )}
      </div>
      {fileError && (
        <p role="alert" data-testid="events-file-error" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          {fileError}
        </p>
      )}
      {pdfFile && featureFlags.billing && !pending && !busy && (
        <button
          type="button"
          data-testid="events-pdf-as-image"
          onClick={() => void rereadPdfAsImage()}
          className="self-start rounded-lg border border-violet-400 px-3 py-1.5 text-xs text-violet-900 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-100 dark:hover:bg-violet-950"
        >
          このPDFを、画像としてAIで読み取り直す（Premium）
        </button>
      )}

      {pending && (
        <div data-testid="events-pending" className="flex flex-col gap-2 rounded-lg border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="break-all text-xs text-neutral-600 dark:text-neutral-300">
            選択中のファイル: <span data-testid="events-pending-name">{pending.fileName}</span>
          </p>
          <FiscalCalendarImageAssist calendar={calendar} source={pending.source} images={pending.images} fileName={pending.fileName} note={pending.note} onApply={applyImageDrafts} />
        </div>
      )}

      {value && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="break-all text-xs text-neutral-600 dark:text-neutral-300">
            ファイル: <span data-testid="events-file-name">{value.fileName}</span>
          </p>

          {value.sourceNote && (
            <p data-testid="events-source-note" className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-100">
              {value.sourceNote}
            </p>
          )}

          {value.sheets.length > 1 && (
            <label className="flex flex-col gap-1 text-xs sm:w-2/3">
              <span className="text-neutral-600 dark:text-neutral-300">読み込むシート</span>
              <select
                data-testid="events-sheet"
                value={value.sheetIndex}
                onChange={(e) => onChange(stateForSheet({ fileName: value.fileName, sheets: value.sheets, source: value.source, sourceNote: value.sourceNote }, Number(e.target.value)))}
                className={selectClass}
              >
                {value.sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {value.error && (
            <p role="alert" data-testid="events-error" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
              {value.error}
            </p>
          )}

          {!value.detected && !value.result && !value.error && (
            <p data-testid="events-undetected" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              列の見出しから「日付」「予定」の列を自動では判定できませんでした。下で、日付と予定の列を選んでください。
            </p>
          )}

          {summary && placed && (
            <div data-testid="events-summary" className="flex flex-col gap-0.5 text-sm">
              <p data-testid="events-count-recognized" className="font-medium">
                {summary.recognized}件の予定を読み込みました
              </p>
              <p data-testid="events-count-rows" className="text-xs text-neutral-600 dark:text-neutral-300">
                読み込んだ行数: {summary.totalRows}行（空の行は数えません）
              </p>
              <p data-testid="events-count-inyear">対象年度内：{summary.inYear}件（{rangeLabel}）</p>
              <p data-testid="events-count-outyear" className={summary.outOfYear > 0 ? "text-amber-800 dark:text-amber-300" : ""}>
                対象年度外：{summary.outOfYear}件
                {summary.outOfYear > 0 && (
                  <span className="block text-xs">
                    対象年度外のためカレンダーには配置されません（{outOfRangeSample.join("、")}
                    {new Set(placed.outOfRange.map((e) => e.date)).size > outOfRangeSample.length ? " ほか" : ""}）
                  </span>
                )}
              </p>
              <p data-testid="events-count-baddate" className={summary.badDateRows > 0 ? "text-red-700 dark:text-red-300" : ""}>
                日付を認識できない行：{summary.badDateRows}件
              </p>
              <p data-testid="events-count-emptytitle" className={summary.emptyTitleRows > 0 ? "text-red-700 dark:text-red-300" : ""}>
                予定名が空の行：{summary.emptyTitleRows}件
              </p>
              {summary.badTimeRows > 0 && (
                <p data-testid="events-count-badtime" className="text-amber-800 dark:text-amber-300">
                  時刻を読み取れない行：{summary.badTimeRows}件（その時刻は使わずに配置します）
                </p>
              )}
              {summary.weekdayMismatchRows > 0 && (
                <p data-testid="events-count-weekday" className="text-amber-800 dark:text-amber-300">
                  日付と曜日が合わない行：{summary.weekdayMismatchRows}件（要確認）
                </p>
              )}
              {summary.duplicateDates > 0 && (
                <p data-testid="events-count-duplicate" className="text-amber-800 dark:text-amber-300">
                  同じ日付の予定が複数ある日：{summary.duplicateDates}日（要確認）
                </p>
              )}
            </div>
          )}

          {value.result && value.result.warnings.length > 0 && (
            <div data-testid="events-warnings" className="flex flex-col gap-1 text-xs">
              <p className="font-medium text-neutral-700 dark:text-neutral-200">ご確認ください（読み込みはそのまま行います）</p>
              <p className="text-neutral-500 dark:text-neutral-400">
                次の内容は、予定を削除・統合・修正せず、読み込んだままカレンダーに使います。意図したものであれば、そのままで大丈夫です。
              </p>
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950">
                {value.result.warnings.slice(0, MAX_ISSUE_ROWS_SHOWN).map((warning) => (
                  <li
                    key={`${warning.kind}-${warning.date}-${warning.rows[0]}`}
                    data-testid="events-warning"
                    data-kind={warning.kind}
                    className="break-all text-amber-900 dark:text-amber-100"
                  >
                    <span className="font-medium">{warning.kind === "weekday-mismatch" ? "曜日の不一致" : "同じ日付が複数"}</span>
                    ：{warning.message}
                    <span className="block font-mono text-amber-800 dark:text-amber-300">
                      対象: {warning.rows.slice(0, 10).join("・")}
                      行目{warning.rows.length > 10 ? ` ほか${warning.rows.length - 10}行` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {value.result.warnings.length > MAX_ISSUE_ROWS_SHOWN && (
                <p className="text-neutral-500 dark:text-neutral-400">ほか{value.result.warnings.length - MAX_ISSUE_ROWS_SHOWN}件</p>
              )}
            </div>
          )}

          {value.result && value.result.issues.length > 0 && (
            <div data-testid="events-issues" className="flex flex-col gap-1 text-xs">
              <p className="font-medium text-neutral-700 dark:text-neutral-200">確認が必要な行</p>
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-950">
                {value.result.issues.slice(0, MAX_ISSUE_ROWS_SHOWN).map((issue) => (
                  <li key={`${issue.row}-${issue.kind}`} data-testid="events-issue" data-kind={issue.kind} className="break-all">
                    <span className="font-mono">{issue.row}行目</span>：{issue.message}
                    {issue.raw && <span className="text-neutral-500 dark:text-neutral-400">（{issue.raw}）</span>}
                  </li>
                ))}
              </ul>
              {value.result.issues.length > MAX_ISSUE_ROWS_SHOWN && (
                <p className="text-neutral-500 dark:text-neutral-400">ほか{value.result.issues.length - MAX_ISSUE_ROWS_SHOWN}行</p>
              )}
            </div>
          )}

          {featureFlags.billing && value.result && (
            <FiscalCalendarAiAssist
              key={`${value.fileName}|${value.sheetIndex}|${value.headerRow}|${JSON.stringify(value.mapping)}`}
              calendar={calendar}
              rows={rows}
              headerRow={value.headerRow}
              mapping={value.mapping}
              result={value.result}
              adopted={value.aiEvents ?? []}
              onAdoptedChange={(aiEvents) => onChange({ ...value, aiEvents })}
            />
          )}

          <details open={!value.detected} data-testid="events-mapping" className="text-xs">
            <summary className="cursor-pointer text-neutral-700 dark:text-neutral-200">列の割り当てを確認・変更する</summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-neutral-600 dark:text-neutral-300">見出しの行</span>
                <select
                  data-testid="events-header-row"
                  value={value.headerRow}
                  onChange={(e) => update({ headerRow: Number(e.target.value) })}
                  className={selectClass}
                >
                  <option value={-1}>見出しなし（1行目から予定）</option>
                  {Array.from({ length: Math.min(10, rows.length) }, (_, i) => (
                    <option key={i} value={i}>
                      {i + 1}行目
                    </option>
                  ))}
                </select>
              </label>
              {COLUMN_ROLES.map((role: ColumnRole) => (
                <label key={role} className="flex flex-col gap-1">
                  <span className="text-neutral-600 dark:text-neutral-300">
                    {COLUMN_ROLE_LABELS[role]}の列{role === "date" || role === "title" ? "（必須）" : ""}
                  </span>
                  <select
                    data-testid={`events-col-${role}`}
                    value={value.mapping[role] ?? ""}
                    onChange={(e) => update({ mapping: { ...value.mapping, [role]: e.target.value === "" ? null : Number(e.target.value) } })}
                    className={selectClass}
                  >
                    <option value="">{role === "date" || role === "title" ? "（選んでください）" : "（使わない）"}</option>
                    {labels.map((label, c) => (
                      <option key={c} value={c}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
        </div>
      )}
    </fieldset>
  );
}
