"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ErrorMessage } from "@/components/common/error-message";
import { loadPdfDocument, type PdfjsPage } from "@/lib/pdf/pdfjs-client";
import { pdfRectToScreenRect, screenRectToPdfRect, clamp } from "@/lib/pdf/coords";
import {
  createEmptyTemplate,
  createFieldId,
  fieldDisplayId,
  TEMPLATE_LIMITS,
  type Template,
  type TemplateField,
} from "@/lib/pdf-template/types";
import { captureFixedTextForTemplate, type PersonRecord } from "@/lib/pdf-template/person-extraction";
import { exportPersonsToExcel } from "@/lib/pdf-template/excel-export";
import { FilledPdfToExcelTemplateProcessor } from "@/lib/processors/browser/filled-pdf-to-excel-template";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, sanitizeFileName, stripExtension } from "@/lib/utils/format";
import { useFilledPdfToExcelUsage, UsageGatePanel, describeConsumeFailure } from "./filled-pdf-to-excel/usage-gate";

/**
 * 記入されたPDF→Excel「テンプレートモード」（Phase 18）。
 *
 * 1ページに複数人分の情報が入っている帳票を、あらかじめ登録したテンプレートの
 * 入力枠に基づいて、人ごと・項目ごとに正確にExcelへ出力する。
 * AI/LLMは一切使用せず、ユーザーが指定した矩形の位置と、既存のPDFテキスト
 * レイヤー抽出・OCR基盤（tesseract.js）だけで値を取り出す（開発指示書1章）。
 *
 * ウィザード形式: テンプレート登録 → 枠の指定 → テンプレート確認 →
 * 記入済みPDFのアップロード → 抽出 → プレビュー・修正 → Excelダウンロード。
 * テンプレート定義（枠の位置・ラベル名）はこのコンポーネントのReact stateだけに
 * 保持し、ページを離れると失われる（開発指示書29章：サーバー保存はしない。
 * ブラウザセッション中だけの一時的な保持で十分とする）。
 */

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];

const DEFAULT_FIELD_WIDTH = 130;
const DEFAULT_FIELD_HEIGHT = 22;
const MIN_FIELD_SIZE = 10;

type Step = "template" | "editor" | "confirm" | "upload" | "processing" | "preview";

interface TemplatePageMeta {
  pageIndex: number;
  width: number;
  height: number;
}

/** PDF.jsのpage.getViewport()が返すviewportの型（動的importのためPdfjsPageから導出する） */
type PdfViewport = ReturnType<PdfjsPage["getViewport"]>;

/** テンプレート編集キャンバスのズーム倍率（開発指示書A-3〜A-5）。100% = PDF実座標1pt = 画面1px */
const ZOOM_LEVELS = [80, 100, 150, 200] as const;

interface DragState {
  fieldId: string;
  mode: "move" | "resize";
  startClientX: number;
  startClientY: number;
  /** ドラッグ開始時点の、そのviewportにおける枠の画面座標矩形(CSS px) */
  origScreenRect: { left: number; top: number; width: number; height: number };
}

export function FilledPdfToExcelTemplatePanel() {
  const [step, setStep] = useState<Step>("template");
  const [error, setError] = useState<string | null>(null);

  // --- テンプレート登録・枠指定 ---
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templatePdfBytes, setTemplatePdfBytes] = useState<ArrayBuffer | null>(null);
  const [templatePages, setTemplatePages] = useState<TemplatePageMeta[]>([]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [template, setTemplate] = useState<Template>(createEmptyTemplate());
  const [personIndexes, setPersonIndexes] = useState<number[]>([]);
  const [pendingFieldPerson, setPendingFieldPerson] = useState<number | null>(null);
  const [pendingFieldType, setPendingFieldType] = useState<"text" | "checkbox">("text");
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  // 現在表示中ページのPDF.js viewport（開発指示書A-6: 独自のx/zoom計算ではなく、
  // PDF.js自身のconvertToViewportPoint/convertToPdfPointで座標変換するために保持する）
  const [activeViewport, setActiveViewport] = useState<PdfViewport | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // --- テンプレート確認 ---
  const [capturingFixedText, setCapturingFixedText] = useState(false);

  // --- 記入済みPDFアップロード・抽出 ---
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [filledFiles, setFilledFiles] = useState<File[]>([]);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageCountError, setPageCountError] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const { usage, usageLoading, adPhase, isAdBusy, needsAdBeforeRun, handleWatchAd, refreshUsage, consumeUsage } =
    useFilledPdfToExcelUsage();

  // --- プレビュー・出力 ---
  const [records, setRecords] = useState<PersonRecord[] | null>(null);
  const [resultMeta, setResultMeta] = useState<{ pageCount: number; usedOcr: boolean; excludedPersonCount: number } | null>(null);

  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  function resetAll() {
    setStep("template");
    setError(null);
    setTemplateFile(null);
    setTemplatePdfBytes(null);
    setTemplatePages([]);
    setCurrentPageIndex(0);
    setTemplate(createEmptyTemplate());
    setPersonIndexes([]);
    setPendingFieldPerson(null);
    setPendingFieldType("text");
    setActiveFieldId(null);
    setPageImageUrl(null);
    setZoomPercent(100);
    setActiveViewport(null);
    setFilledFiles([]);
    setTotalPages(null);
    setPageCountError(null);
    setProgressLabel("");
    setRecords(null);
    setResultMeta(null);
  }

  // -----------------------------------------------------------------------
  // 1. テンプレート登録
  // -----------------------------------------------------------------------
  /**
   * テンプレートページを指定のズーム倍率で描画する（開発指示書A-3〜A-7）。
   *
   * 「100% = PDF実座標1ptを画面1pxとして表示」という固定の基準を採用し、
   * コンテナ幅（containerWidth）など、ズームと無関係にウィンドウサイズ等で
   * 変わりうる値をscaleの計算に混ぜない。これにより、80%→150%→80%→200%→100%と
   * 何度切り替えても、同じズーム%は常に同じscale・同じviewportになる
   * （A-5の「zoom往復で位置が変わらない」ための前提）。
   *
   * 生成したviewport（PDF.js自身が持つ座標変換の実体）をactiveViewportとして
   * 保持し、以後の枠の作成・表示・ドラッグはすべてこのviewportの
   * convertToViewportPoint/convertToPdfPointを経由する（独自のx*scaleのような
   * 計算をコンポーネント側で行わない。A-6）。
   */
  async function renderTemplatePage(
    pdf: Awaited<ReturnType<typeof loadPdfDocument>>,
    pageIndex: number,
    pageInfo: TemplatePageMeta,
    zoomPct: number
  ) {
    const page = await pdf.getPage(pageIndex + 1);
    const scale = zoomPct / 100;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("プレビューの生成に失敗しました");
    await page.render({ canvasContext: ctx, viewport }).promise;
    setActiveViewport(viewport);
    setPageImageUrl(canvas.toDataURL("image/png"));
  }

  async function handleTemplateSelect(files: File[]) {
    const f = files[0];
    if (!f) return;
    setError(null);
    try {
      const bytes = await f.arrayBuffer();
      const pdf = await loadPdfDocument(new File([bytes], f.name, { type: "application/pdf" }));
      if (pdf.numPages === 0) throw new Error("このPDFにはページがありません");
      const pageInfos: TemplatePageMeta[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        pageInfos.push({ pageIndex: i - 1, width: viewport.width, height: viewport.height });
      }
      setTemplateFile(f);
      setTemplatePdfBytes(bytes);
      setTemplatePages(pageInfos);
      setCurrentPageIndex(0);
      setZoomPercent(100);
      setTemplate({ pages: pageInfos, fields: [], excludeEmptyPersons: true });
      setPersonIndexes([1]);
      await renderTemplatePage(pdf, 0, pageInfos[0], 100);
      setStep("editor");
    } catch (e) {
      setError(e instanceof Error ? e.message : "テンプレートPDFの読み込みに失敗しました");
    }
  }

  async function goToTemplatePage(pageIndex: number) {
    if (!templateFile || !templatePdfBytes) return;
    const info = templatePages.find((p) => p.pageIndex === pageIndex);
    if (!info) return;
    const pdf = await loadPdfDocument(new File([templatePdfBytes.slice(0)], templateFile.name, { type: "application/pdf" }));
    setCurrentPageIndex(pageIndex);
    await renderTemplatePage(pdf, pageIndex, info, zoomPercent);
  }

  /** ズーム変更（開発指示書A-3〜A-5のテスト対象操作そのもの）。現在のページを新しい倍率で再描画する */
  async function handleZoomChange(nextZoomPercent: number) {
    if (!templateFile || !templatePdfBytes) return;
    const info = templatePages[currentPageIndex];
    if (!info) return;
    setZoomPercent(nextZoomPercent);
    const pdf = await loadPdfDocument(new File([templatePdfBytes.slice(0)], templateFile.name, { type: "application/pdf" }));
    await renderTemplatePage(pdf, currentPageIndex, info, nextZoomPercent);
  }

  // -----------------------------------------------------------------------
  // 2. 人物・項目（枠）の管理
  // -----------------------------------------------------------------------
  function addPerson() {
    setError(null);
    setPersonIndexes((prev) => {
      if (prev.length >= TEMPLATE_LIMITS.maxPersonsPerPage) {
        setError(`1ページに登録できる人物の数は${TEMPLATE_LIMITS.maxPersonsPerPage}人までです。`);
        return prev;
      }
      const next = prev.length === 0 ? 1 : Math.max(...prev) + 1;
      return [...prev, next];
    });
  }

  function removePerson(personIndex: number) {
    setPersonIndexes((prev) => prev.filter((p) => p !== personIndex));
    setTemplate((prev) => ({ ...prev, fields: prev.fields.filter((f) => f.personIndex !== personIndex) }));
    if (pendingFieldPerson === personIndex) setPendingFieldPerson(null);
  }

  function updateField(id: string, patch: Partial<TemplateField>) {
    setTemplate((prev) => ({ ...prev, fields: prev.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
  }

  function deleteField(id: string) {
    setTemplate((prev) => ({ ...prev, fields: prev.fields.filter((f) => f.id !== id) }));
    setActiveFieldId((cur) => (cur === id ? null : cur));
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (pendingFieldPerson === null) return;
    const pageInfo = templatePages[currentPageIndex];
    if (!pageInfo || !activeViewport) return;
    if (template.fields.length >= TEMPLATE_LIMITS.maxFieldsTotal) {
      setError(`登録できる入力枠の総数は${TEMPLATE_LIMITS.maxFieldsTotal}個までです。`);
      setPendingFieldPerson(null);
      return;
    }
    const sameOwner = template.fields.filter((f) => f.personIndex === pendingFieldPerson && f.pageIndex === currentPageIndex);
    if (sameOwner.length >= TEMPLATE_LIMITS.maxFieldsPerPerson) {
      setError(`1人あたりに登録できる項目数は${TEMPLATE_LIMITS.maxFieldsPerPerson}個までです。`);
      setPendingFieldPerson(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const width = Math.min(DEFAULT_FIELD_WIDTH, pageInfo.width * 0.6);
    const height = Math.min(DEFAULT_FIELD_HEIGHT, pageInfo.height * 0.1) || DEFAULT_FIELD_HEIGHT;

    // マウス座標 → 現在のPDF.js viewport → PDF実座標（開発指示書A-6）。
    // クリック位置は新しい枠の画面上の左上角として扱う。
    const clickPdf = screenRectToPdfRect({ left: clickX, top: clickY, width: 0, height: 0 }, activeViewport);
    const rawX = clickPdf.x;
    const rawY = clickPdf.y - height;
    const x = clamp(rawX, 0, Math.max(0, pageInfo.width - width));
    const y = clamp(rawY, 0, Math.max(0, pageInfo.height - height));

    const fieldIndex = sameOwner.length === 0 ? 1 : Math.max(...sameOwner.map((f) => f.fieldIndex)) + 1;
    const newField: TemplateField = {
      id: createFieldId(),
      personIndex: pendingFieldPerson,
      fieldIndex,
      label: `項目${fieldIndex}`,
      pageIndex: currentPageIndex,
      x,
      y,
      width,
      height,
      type: pendingFieldType,
    };
    setTemplate((prev) => ({ ...prev, fields: [...prev.fields, newField] }));
    setActiveFieldId(newField.id);
    setPendingFieldPerson(null);
  }

  function handleFieldPointerDown(e: React.PointerEvent<HTMLDivElement>, field: TemplateField, mode: "move" | "resize") {
    e.stopPropagation();
    if (!activeViewport) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setActiveFieldId(field.id);
    const origScreenRect = pdfRectToScreenRect({ x: field.x, y: field.y, width: field.width, height: field.height }, activeViewport);
    dragRef.current = {
      fieldId: field.id,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origScreenRect,
    };
  }

  /**
   * 枠のドラッグ移動・リサイズ（開発指示書A-6〜A-8）。
   *
   * ドラッグ開始時点の枠の「画面座標矩形」を基準に、ポインターの移動量
   * （画面px）をその矩形へ加算した新しい画面矩形を作り、それを
   * screenRectToPdfRect() で現在のviewportに基づきPDF実座標へ変換する。
   * 独自の「dx / scale」のような式を最終座標の計算に使わず、必ず
   * viewportの変換メソッドを経由することで、ズーム倍率や（対応していれば）
   * 回転が変わっても位置がずれない（A-5・A-8）。
   */
  function handleFieldPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || !activeViewport) return;
    const pageInfo = templatePages[currentPageIndex];
    if (!pageInfo) return;
    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;

    setTemplate((prev) => ({
      ...prev,
      fields: prev.fields.map((f) => {
        if (f.id !== drag.fieldId) return f;

        if (drag.mode === "move") {
          const newScreenRect = {
            left: drag.origScreenRect.left + dxScreen,
            top: drag.origScreenRect.top + dyScreen,
            width: drag.origScreenRect.width,
            height: drag.origScreenRect.height,
          };
          const pdfRect = screenRectToPdfRect(newScreenRect, activeViewport);
          const x = clamp(pdfRect.x, 0, Math.max(0, pageInfo.width - f.width));
          const y = clamp(pdfRect.y, 0, Math.max(0, pageInfo.height - f.height));
          return { ...f, x, y };
        }

        // resize: 右下ハンドルをドラッグ。左上(画面上)の角を固定したまま幅・高さを変える
        const newScreenWidth = Math.max(MIN_FIELD_SIZE, drag.origScreenRect.width + dxScreen);
        const newScreenHeight = Math.max(MIN_FIELD_SIZE, drag.origScreenRect.height + dyScreen);
        const newScreenRect = {
          left: drag.origScreenRect.left,
          top: drag.origScreenRect.top,
          width: newScreenWidth,
          height: newScreenHeight,
        };
        const pdfRect = screenRectToPdfRect(newScreenRect, activeViewport);
        const width = clamp(pdfRect.width, MIN_FIELD_SIZE, pageInfo.width - pdfRect.x);
        const height = clamp(pdfRect.height, MIN_FIELD_SIZE, pdfRect.y + pdfRect.height);
        // 右下ハンドルのドラッグでは左上(画面上)の角=PDF上端を固定する。
        // pdfRect.y はリサイズ後の矩形の下端なので、元の上端(origトップ相当)を
        // 保つよう、上端 = pdfRect.y + pdfRect.height を固定してyを再計算する。
        const topEdge = pdfRect.y + pdfRect.height;
        const y = clamp(topEdge - height, 0, Math.max(0, pageInfo.height - height));
        return { ...f, width, height, y };
      }),
    }));
  }

  function handleFieldPointerUp() {
    dragRef.current = null;
  }

  const fieldsOnCurrentPage = template.fields.filter((f) => f.pageIndex === currentPageIndex);
  const currentPageInfo = templatePages[currentPageIndex];

  function canProceedToConfirm() {
    return personIndexes.length > 0 && template.fields.length > 0;
  }

  // -----------------------------------------------------------------------
  // 3. テンプレート確認 → 固定文字の取得
  // -----------------------------------------------------------------------
  async function handleConfirmTemplate() {
    if (!templateFile) return;
    if (!canProceedToConfirm()) {
      setError("少なくとも1人・1項目の入力枠を登録してください。");
      return;
    }
    setError(null);
    setCapturingFixedText(true);
    try {
      const updated = await captureFixedTextForTemplate(templateFile, template, language);
      setTemplate(updated);
      setStep("upload");
    } catch (e) {
      setError(e instanceof Error ? e.message : "テンプレートの解析に失敗しました");
    } finally {
      setCapturingFixedText(false);
    }
  }

  // -----------------------------------------------------------------------
  // 4. 記入済みPDFのアップロード・抽出
  // -----------------------------------------------------------------------
  function handleFilledSelect(selected: File[]) {
    setFilledFiles(selected);
    setError(null);
    setTotalPages(null);
    setPageCountError(null);

    if (selected.length === 0) return;
    (async () => {
      let sum = 0;
      try {
        for (const file of selected) {
          const pdf = await loadPdfDocument(file);
          sum += pdf.numPages;
        }
        setTotalPages(sum);
      } catch (e) {
        setPageCountError(e instanceof Error ? e.message : "PDFのページ数を確認できませんでした");
      }
    })();
  }

  function handleFilledRemove(index: number) {
    handleFilledSelect(filledFiles.filter((_, i) => i !== index));
  }

  const overPageLimit = totalPages !== null && usage?.maxPagesPerUse != null && totalPages > usage.maxPagesPerUse;
  const [isSubmittingExtraction, setIsSubmittingExtraction] = useState(false);
  const canRunExtraction =
    filledFiles.length > 0 && totalPages !== null && !pageCountError && !overPageLimit && !needsAdBeforeRun && !isSubmittingExtraction;

  async function handleRunExtraction() {
    // canRunExtractionのisSubmittingExtraction判定だけでは、クリックからstate更新の
    // 再描画が反映されるまでの間にもう一度呼ばれる余地が残るため、この関数自身の
    // 冒頭で同期的にフラグを立てて即座にガードする（開発指示書41章：処理ボタンの
    // 二重実行防止）。consumeUsage()（Server Action呼び出し）の応答を待つ間も
    // ボタンは無効化された状態を保つ。
    if (!canRunExtraction || totalPages === null || isSubmittingExtraction) return;
    setIsSubmittingExtraction(true);
    setError(null);

    try {
      const consumeResult = await consumeUsage(totalPages);
      if (!consumeResult.allowed) {
        setError(describeConsumeFailure(consumeResult));
        return;
      }

      setStep("processing");
      setProgressLabel("解析中...");
      const output = await new FilledPdfToExcelTemplateProcessor().process({
        template,
        files: filledFiles,
        language,
        maxTotalPages: consumeResult.maxPages ?? undefined,
        onPageProgress: (info) => {
          const label =
            info.fileCount > 1
              ? `${info.fileName}（${info.fileIndex + 1}/${info.fileCount}ファイル目） ${info.currentPage} / ${info.totalPagesInFile}ページ`
              : `ページを解析中 ${info.currentPage} / ${info.totalPagesInFile}`;
          setProgressLabel(info.method === "ocr" ? `OCR処理中: ${label}` : label);
        },
      });
      setRecords(output.records);
      setResultMeta({ pageCount: output.pageCount, usedOcr: output.usedOcr, excludedPersonCount: output.excludedPersonCount });
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStep("upload");
    } finally {
      setProgressLabel("");
      setIsSubmittingExtraction(false);
      await refreshUsage();
    }
  }

  // -----------------------------------------------------------------------
  // 5. プレビュー・修正・ダウンロード
  // -----------------------------------------------------------------------
  function updateRecordFieldValue(recordId: string, fieldIndex: number, value: string) {
    setRecords((prev) =>
      prev
        ? prev.map((r) => (r.id === recordId ? { ...r, fields: r.fields.map((f) => (f.fieldIndex === fieldIndex ? { ...f, value } : f)) } : r))
        : prev
    );
  }

  async function handleDownloadExcel() {
    if (!records) return;
    const included = records.filter((r) => !r.excluded);
    if (included.length === 0) {
      setError("出力できる人物の情報がありません（すべて空欄と判定されました）。");
      return;
    }
    try {
      const blob = await exportPersonsToExcel(included);
      const baseName = templateFile ? stripExtension(templateFile.name) : "記入済みPDF";
      downloadBlob(blob, `${sanitizeFileName(baseName)}_抽出結果.xlsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Excelファイルの生成に失敗しました");
    }
  }

  const includedRecords = records?.filter((r) => !r.excluded) ?? [];
  const excludedRecords = records?.filter((r) => r.excluded) ?? [];

  // -----------------------------------------------------------------------
  // 描画
  // -----------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          1ページに複数人分の情報が入っている帳票を、あらかじめ登録した空のテンプレートPDF上で
          入力枠の位置を指定し、その位置だけから値を取り出してExcelへ整理します。
          テンプレートの設定はこのページを離れると保持されません（サーバーへは保存されません）。
        </p>
      </div>

      {error && <ErrorMessage message={error} />}

      {step === "template" && (
        <FileDropzone
          accept="application/pdf,.pdf"
          maxSizeMB={50}
          label="空のテンプレートPDFをドラッグ&ドロップ"
          hint="またはタップして選択（1ファイル）"
          onFilesSelected={(f) => void handleTemplateSelect(f)}
          onError={setError}
        />
      )}

      {step === "editor" && currentPageInfo && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600 dark:text-neutral-300">
            {templatePages.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={currentPageIndex === 0}
                  onClick={() => void goToTemplatePage(currentPageIndex - 1)}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                >
                  前のページ
                </button>
                <span>
                  {currentPageIndex + 1} / {templatePages.length} ページ目
                </span>
                <button
                  type="button"
                  disabled={currentPageIndex >= templatePages.length - 1}
                  onClick={() => void goToTemplatePage(currentPageIndex + 1)}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                >
                  次のページ
                </button>
              </>
            )}

            <div className="flex items-center gap-1" role="group" aria-label="表示倍率">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">表示倍率:</span>
              {ZOOM_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-testid={`zoom-${level}`}
                  aria-pressed={zoomPercent === level}
                  onClick={() => void handleZoomChange(level)}
                  className={`rounded border px-2 py-1 text-xs ${
                    zoomPercent === level
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  {level}%
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            枠の位置はPDF実座標で保存されるため、表示倍率を変更しても指定した枠はPDF上の同じ位置に留まります。
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div ref={canvasWrapRef} className="relative w-full overflow-auto rounded-lg border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900">
              {pageImageUrl && (
                <div
                  data-testid="template-canvas"
                  className="relative inline-block cursor-crosshair select-none"
                  onClick={handleCanvasClick}
                  onPointerMove={handleFieldPointerMove}
                  onPointerUp={handleFieldPointerUp}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pageImageUrl} alt={`テンプレート ${currentPageIndex + 1}ページ目`} draggable={false} />
                  {activeViewport &&
                    fieldsOnCurrentPage.map((field) => {
                      const screenRect = pdfRectToScreenRect(
                        { x: field.x, y: field.y, width: field.width, height: field.height },
                        activeViewport
                      );
                      const active = activeFieldId === field.id;
                      const isCheckbox = field.type === "checkbox";
                      return (
                        <div
                          key={field.id}
                          data-testid={`template-field-${fieldDisplayId(field.personIndex, field.fieldIndex)}`}
                          onPointerDown={(e) => handleFieldPointerDown(e, field, "move")}
                          className={`absolute flex items-start justify-start border-2 text-[10px] font-semibold ${
                            active
                              ? "border-blue-600 bg-blue-500/10"
                              : isCheckbox
                                ? "border-amber-600 bg-amber-500/10"
                                : "border-emerald-600 bg-emerald-500/10"
                          }`}
                          style={{
                            left: screenRect.left,
                            top: screenRect.top,
                            width: Math.max(screenRect.width, 4),
                            height: Math.max(screenRect.height, 4),
                          }}
                        >
                          <span className="rounded-br bg-white/90 px-1 text-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100">
                            {fieldDisplayId(field.personIndex, field.fieldIndex)}
                            {isCheckbox ? "☑" : ""}
                          </span>
                          <div
                            onPointerDown={(e) => handleFieldPointerDown(e, field, "resize")}
                            className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-full border border-white bg-blue-600"
                          />
                        </div>
                      );
                    })}
                </div>
              )}
              {pendingFieldPerson !== null && (
                <p className="p-2 text-xs text-blue-700 dark:text-blue-300">
                  {pendingFieldPerson}人目の項目を配置する位置をクリックしてください。
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={addPerson}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-blue-400 dark:border-neutral-700"
              >
                + 人物を追加
              </button>

              <fieldset className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                <legend className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  次に追加する項目の種類
                </legend>
                {(
                  [
                    { value: "text" as const, label: "テキスト" },
                    { value: "checkbox" as const, label: "チェックボックス" },
                  ]
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`cursor-pointer rounded border px-2 py-1 ${
                      pendingFieldType === opt.value
                        ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                        : "border-neutral-300 dark:border-neutral-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="pending-field-type"
                      value={opt.value}
                      checked={pendingFieldType === opt.value}
                      onChange={() => setPendingFieldType(opt.value)}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                ))}
              </fieldset>

              {personIndexes.map((personIndex) => {
                const fields = template.fields.filter((f) => f.personIndex === personIndex).sort((a, b) => a.fieldIndex - b.fieldIndex);
                return (
                  <div key={personIndex} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{personIndex}人目</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setPendingFieldPerson(personIndex)}
                          className={`rounded border px-2 py-1 text-xs ${
                            pendingFieldPerson === personIndex
                              ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                              : "border-neutral-300 dark:border-neutral-700"
                          }`}
                        >
                          項目を追加
                        </button>
                        <button
                          type="button"
                          onClick={() => removePerson(personIndex)}
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 dark:border-red-800 dark:text-red-400"
                        >
                          この人物を削除
                        </button>
                      </div>
                    </div>

                    {fields.length === 0 && <p className="text-xs text-neutral-400">まだ項目がありません</p>}

                    {fields.map((field) => {
                      const badge = fieldDisplayId(field.personIndex, field.fieldIndex);
                      return (
                        <div
                          key={field.id}
                          onClick={() => setActiveFieldId(field.id)}
                          className={`flex flex-col gap-1 rounded border p-2 text-xs ${
                            activeFieldId === field.id ? "border-blue-400 bg-blue-50/50 dark:bg-blue-950/20" : "border-neutral-200 dark:border-neutral-800"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{badge}</span>
                            <input
                              aria-label={`項目名 (${badge})`}
                              value={field.label}
                              onChange={(e) => updateField(field.id, { label: e.target.value })}
                              className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
                            />
                            <select
                              aria-label={`種類 (${badge})`}
                              value={field.type}
                              onChange={(e) => updateField(field.id, { type: e.target.value === "checkbox" ? "checkbox" : "text" })}
                              className="rounded border border-neutral-300 px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
                            >
                              <option value="text">テキスト</option>
                              <option value="checkbox">チェックボックス</option>
                            </select>
                            <button type="button" onClick={() => deleteField(field.id)} className="text-red-600 dark:text-red-400">
                              削除
                            </button>
                          </div>
                          <div className="grid grid-cols-4 gap-1">
                            <label className="flex flex-col">
                              X
                              <input
                                aria-label={`X (${badge})`}
                                type="number"
                                value={Math.round(field.x)}
                                onChange={(e) => updateField(field.id, { x: Number(e.target.value) })}
                                className="w-full rounded border border-neutral-300 px-1 dark:border-neutral-700 dark:bg-neutral-950"
                              />
                            </label>
                            <label className="flex flex-col">
                              Y
                              <input
                                aria-label={`Y (${badge})`}
                                type="number"
                                value={Math.round(field.y)}
                                onChange={(e) => updateField(field.id, { y: Number(e.target.value) })}
                                className="w-full rounded border border-neutral-300 px-1 dark:border-neutral-700 dark:bg-neutral-950"
                              />
                            </label>
                            <label className="flex flex-col">
                              幅
                              <input
                                aria-label={`幅 (${badge})`}
                                type="number"
                                value={Math.round(field.width)}
                                onChange={(e) => updateField(field.id, { width: Math.max(MIN_FIELD_SIZE, Number(e.target.value)) })}
                                className="w-full rounded border border-neutral-300 px-1 dark:border-neutral-700 dark:bg-neutral-950"
                              />
                            </label>
                            <label className="flex flex-col">
                              高さ
                              <input
                                aria-label={`高さ (${badge})`}
                                type="number"
                                value={Math.round(field.height)}
                                onChange={(e) => updateField(field.id, { height: Math.max(MIN_FIELD_SIZE, Number(e.target.value)) })}
                                className="w-full rounded border border-neutral-300 px-1 dark:border-neutral-700 dark:bg-neutral-950"
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => setStep("confirm")}
                disabled={!canProceedToConfirm()}
                className="mt-2 w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                テンプレート確認へ
              </button>
            </div>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
            {pageImageUrl && (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pageImageUrl} alt="テンプレートの確認" draggable={false} />
                {activeViewport &&
                  fieldsOnCurrentPage.map((field) => {
                    const screenRect = pdfRectToScreenRect(
                      { x: field.x, y: field.y, width: field.width, height: field.height },
                      activeViewport
                    );
                    return (
                      <div
                        key={field.id}
                        className={`absolute border-2 text-[10px] font-semibold ${
                          field.type === "checkbox" ? "border-amber-600 bg-amber-500/10" : "border-emerald-600 bg-emerald-500/10"
                        }`}
                        style={{
                          left: screenRect.left,
                          top: screenRect.top,
                          width: Math.max(screenRect.width, 4),
                          height: Math.max(screenRect.height, 4),
                        }}
                      >
                        <span className="bg-white/90 px-1 text-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-100">
                          {fieldDisplayId(field.personIndex, field.fieldIndex)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {personIndexes.map((personIndex) => {
              const fields = template.fields.filter((f) => f.personIndex === personIndex).sort((a, b) => a.fieldIndex - b.fieldIndex);
              if (fields.length === 0) return null;
              return (
                <div key={personIndex} className="text-sm text-neutral-700 dark:text-neutral-200">
                  <p className="font-semibold">{personIndex}人目</p>
                  <ul className="ml-4 list-disc text-xs text-neutral-600 dark:text-neutral-300">
                    {fields.map((f) => (
                      <li key={f.id}>
                        {fieldDisplayId(f.personIndex, f.fieldIndex)} {f.label}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={template.excludeEmptyPersons}
              onChange={(e) => setTemplate((prev) => ({ ...prev, excludeEmptyPersons: e.target.checked }))}
            />
            空欄の人物を除外する（項目の多くが空欄のままの人物ブロックを出力から除く）
          </label>

          {capturingFixedText && <p className="text-sm text-neutral-500 dark:text-neutral-400">テンプレートを解析しています...</p>}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep("editor")}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              戻って編集する
            </button>
            <button
              type="button"
              disabled={capturingFixedText}
              onClick={() => void handleConfirmTemplate()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              テンプレートを確定して記入済みPDFへ進む
            </button>
          </div>
        </div>
      )}

      {step === "upload" && (
        <div className="flex flex-col gap-4">
          <FileDropzone
            accept="application/pdf,.pdf"
            multiple
            maxSizeMB={50}
            label="記入済みのPDFをドラッグ&ドロップ"
            hint="またはタップして選択（複数ファイル可、上限50MB/ファイル）"
            onFilesSelected={handleFilledSelect}
            onError={setError}
          />
          {filledFiles.length > 0 && <FileList files={filledFiles} onRemove={handleFilledRemove} />}
          {pageCountError && <ErrorMessage message={pageCountError} />}

          <UsageGatePanel
            usage={usage}
            usageLoading={usageLoading}
            totalPages={totalPages}
            adPhase={adPhase}
            isAdBusy={isAdBusy}
            onWatchAd={() => void handleWatchAd()}
          />

          {filledFiles.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">言語（OCR実行時のみ使用）</legend>
              <div className="flex flex-wrap gap-2">
                {LANGUAGE_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      language === opt.value
                        ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                        : "border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="filled-pdf-to-excel-template-language"
                      value={opt.value}
                      checked={language === opt.value}
                      onChange={() => setLanguage(opt.value)}
                      className="sr-only"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="flex gap-3">
            <button type="button" onClick={() => setStep("confirm")} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              テンプレートに戻る
            </button>
            <button
              type="button"
              disabled={!canRunExtraction}
              onClick={() => void handleRunExtraction()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              抽出する
            </button>
          </div>
        </div>
      )}

      {step === "processing" && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{progressLabel || "処理中..."}</p>
      )}

      {step === "preview" && records && (
        <div className="flex flex-col gap-4">
          {resultMeta && (
            <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
              <span>合計ページ数: {resultMeta.pageCount}</span>
              <span>出力人数: {includedRecords.length}</span>
              {resultMeta.excludedPersonCount > 0 && <span>空欄のため除外: {resultMeta.excludedPersonCount}人</span>}
              {resultMeta.usedOcr && <span>OCRを使用しました</span>}
            </div>
          )}

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            抽出結果に誤りがあれば、下の欄を直接編集できます。編集内容はブラウザ内だけで保持され、サーバーへは送信されません。
          </p>

          <div className="flex flex-col gap-3">
            {includedRecords.map((record, idx) => (
              <div key={record.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <p className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                  {idx + 1}人目（{record.sourceFileName} {record.sourcePageNumber}ページ目）
                </p>
                <div className="flex flex-col gap-1.5">
                  {record.fields.map((f) => (
                    <label key={f.fieldIndex} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 text-neutral-500 dark:text-neutral-400">{f.label}</span>
                      <input
                        aria-label={`${idx + 1}人目 ${f.label}`}
                        value={f.value}
                        placeholder={f.method === "empty" ? "抽出できませんでした" : undefined}
                        onChange={(e) => updateRecordFieldValue(record.id, f.fieldIndex, e.target.value)}
                        className={`min-w-0 flex-1 rounded border px-2 py-1 dark:bg-neutral-950 ${
                          f.method === "empty" ? "border-amber-400 text-amber-700 placeholder:text-amber-500 dark:text-amber-300" : "border-neutral-300 dark:border-neutral-700"
                        }`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {excludedRecords.length > 0 && (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              {excludedRecords.length}人分の人物ブロックは、ほとんどの項目が空欄だったため出力から除外されました（{excludedRecords
                .map((r) => `${r.sourceFileName} ${r.sourcePageNumber}ページ目`)
                .join("、")}）。
            </div>
          )}

          <div className="flex gap-3">
            <button type="button" onClick={resetAll} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              最初からやり直す
            </button>
            <button
              type="button"
              onClick={() => void handleDownloadExcel()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Excelをダウンロード
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
