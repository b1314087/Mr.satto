"use client";

import { useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { autoMapColumns } from "@/lib/forms/column-mapping";
import { buildPhotoLookup, type PhotoLookupEntry } from "@/lib/forms/photo-matching";
import { renderPersonPdf } from "@/lib/forms/template-renderer";
import { createEmptyField, type ColumnMapping, type FieldDefinition, type ParsedTable, type TemplatePageInfo } from "@/lib/forms/types";
import { FormToIndividualPdfsProcessor, type FilenameStrategy } from "@/lib/processors/browser/form-to-individual-pdfs";
import { readCsvFile } from "@/lib/utils/csv";
import { downloadBlob, sanitizeFileName } from "@/lib/utils/format";

/**
 * フォーム回答から個別PDFを一括作成（Phase 11 ツール②）。
 *
 * Template / Field / Mapping / Render という共通の帳票エンジン
 * （src/lib/forms/）を使い、次の手順で個別PDFをまとめて生成する:
 *   1. 帳票の元になるPDFテンプレートをアップロード
 *   2. PDFのプレビュー上でフィールド（氏名・住所・写真など）を配置
 *   3. Googleフォーム/Microsoft Formsから書き出したCSV/Excelをアップロード
 *   4. CSV/Excelの列とフィールドの対応（マッピング）を確認
 *   5. 写真を使う場合は画像ファイルをまとめてアップロード（ファイル名で対応付け）
 *   6. 1人分だけプレビューして確認
 *   7. 全員分をまとめてPDF化し、ZIPでダウンロード
 *
 * すべてブラウザ内で完結し、テンプレート・CSV/Excel・写真・生成したPDFは
 * Mr.Sattoのサーバーへアップロード・保存されません。
 *
 * ドラッグ&ドロップライブラリは追加せず、素のPointer Eventsでフィールドの
 * 配置・移動を実装している（開発指示書59章：新規依存は最小限にする方針）。
 * 大きさの変更は数値入力で行う（見た目のドラッグでの拡大縮小は今回未対応。
 * 詳細は最終報告に記載）。
 */

type WizardStep = "template" | "fields" | "data" | "mapping" | "photos" | "preview" | "generate";

const PREVIEW_MAX_WIDTH = 640;

function pdfToScreenX(pdfX: number, scale: number): number {
  return pdfX * scale;
}
function pdfToScreenY(pdfY: number, fieldHeight: number, pageHeight: number, scale: number): number {
  // PDF座標系（原点左下）→ 画面座標系（原点左上）への変換。fieldの上端を基準にする。
  return (pageHeight - pdfY - fieldHeight) * scale;
}

export function FormToIndividualPdfsTool() {
  const [step, setStep] = useState<WizardStep>("template");
  const [error, setError] = useState<string | null>(null);

  // --- テンプレート ---
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateBytes, setTemplateBytes] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<TemplatePageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState(1);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageRenderScale, setPageRenderScale] = useState(1);
  const [templateLoading, setTemplateLoading] = useState(false);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  // --- フィールド ---
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [placingFieldId, setPlacingFieldId] = useState<string | null>(null);
  const dragState = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number } | null>(
    null
  );

  // --- データ(CSV/Excel) ---
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [photoColumnMapping, setPhotoColumnMapping] = useState<Record<string, string | null>>({});

  // --- 写真 ---
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const photoLookup: PhotoLookupEntry[] = useMemo(() => buildPhotoLookup(photoFiles), [photoFiles]);

  // --- ファイル名戦略 ---
  const [filenameStrategy, setFilenameStrategy] = useState<FilenameStrategy>("sequential");
  const [filenameColumn, setFilenameColumn] = useState<string | null>(null);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);

  // --- プレビュー ---
  const [previewRowIndex, setPreviewRowIndex] = useState(0);
  const [previewImageUrls, setPreviewImageUrls] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  // --- 一括生成 ---
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progressLabel, setProgressLabel] = useState("");
  const [generatedZip, setGeneratedZip] = useState<{ blob: Blob; personCount: number; missingPhotoCount: number } | null>(
    null
  );

  const textFields = fields.filter((f) => f.dataType === "text");
  const photoFields = fields.filter((f) => f.dataType === "photo");
  const currentPageInfo = pages.find((p) => p.pageNumber === selectedPage) ?? null;

  // ---------------------------------------------------------------------
  // 1. テンプレートPDFのアップロード
  // ---------------------------------------------------------------------
  async function handleTemplateSelect(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);
    setTemplateLoading(true);
    setTemplateFile(file);
    setFields([]);
    setPageImageUrl(null);

    try {
      const bytes = await file.arrayBuffer();
      setTemplateBytes(bytes);
      const pdf = await loadPdfDocument(new File([bytes], file.name, { type: "application/pdf" }));
      const pageInfos: TemplatePageInfo[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        pageInfos.push({ pageNumber: i, width: viewport.width, height: viewport.height });
      }
      setPages(pageInfos);
      setSelectedPage(1);
      await renderPagePreview(pdf, 1, pageInfos[0]);
      setStep("fields");
    } catch (e) {
      setError(e instanceof Error ? e.message : "テンプレートPDFの読み込みに失敗しました");
      setTemplateFile(null);
      setTemplateBytes(null);
    } finally {
      setTemplateLoading(false);
    }
  }

  async function renderPagePreview(
    pdf: Awaited<ReturnType<typeof loadPdfDocument>>,
    pageNumber: number,
    pageInfo: TemplatePageInfo
  ) {
    const page = await pdf.getPage(pageNumber);
    const containerWidth = canvasWrapRef.current?.clientWidth || PREVIEW_MAX_WIDTH;
    const targetWidth = Math.min(containerWidth, PREVIEW_MAX_WIDTH);
    const scale = targetWidth / pageInfo.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("プレビューの生成に失敗しました");
    await page.render({ canvasContext: ctx, viewport }).promise;
    setPageRenderScale(scale);
    setPageImageUrl(canvas.toDataURL("image/png"));
  }

  async function handlePageChange(pageNumber: number) {
    if (!templateFile || !templateBytes) return;
    setSelectedPage(pageNumber);
    const pdf = await loadPdfDocument(new File([templateBytes.slice(0)], templateFile.name, { type: "application/pdf" }));
    const pageInfo = pages.find((p) => p.pageNumber === pageNumber);
    if (pageInfo) await renderPagePreview(pdf, pageNumber, pageInfo);
  }

  // ---------------------------------------------------------------------
  // 2. フィールド配置
  // ---------------------------------------------------------------------
  function handleAddField() {
    const id = `field-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const field = createEmptyField({ id, page: selectedPage, label: `項目${fields.length + 1}` });
    setFields((prev) => [...prev, field]);
    setActiveFieldId(id);
    setPlacingFieldId(id);
  }

  function updateField(id: string, patch: Partial<FieldDefinition>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function removeField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (activeFieldId === id) setActiveFieldId(null);
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!placingFieldId || !currentPageInfo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const field = fields.find((f) => f.id === placingFieldId);
    if (!field) return;
    const pdfX = clickX / pageRenderScale;
    const pdfY = currentPageInfo.height - clickY / pageRenderScale - field.height;
    updateField(placingFieldId, { x: Math.max(0, pdfX), y: Math.max(0, pdfY) });
    setPlacingFieldId(null);
  }

  function handleFieldPointerDown(e: React.PointerEvent<HTMLDivElement>, field: FieldDefinition) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { id: field.id, startX: e.clientX, startY: e.clientY, originX: field.x, originY: field.y };
    setActiveFieldId(field.id);
  }

  function handleFieldPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (!drag || !currentPageInfo) return;
    const dxScreen = e.clientX - drag.startX;
    const dyScreen = e.clientY - drag.startY;
    const dxPdf = dxScreen / pageRenderScale;
    const dyPdf = -dyScreen / pageRenderScale; // 画面下方向(+) = PDF座標では上方向(-)
    updateField(drag.id, {
      x: Math.max(0, drag.originX + dxPdf),
      y: Math.max(0, drag.originY + dyPdf),
    });
  }

  function handleFieldPointerUp() {
    dragState.current = null;
  }

  // ---------------------------------------------------------------------
  // 3. CSV/Excelアップロード
  // ---------------------------------------------------------------------
  async function handleDataFileSelect(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);

    try {
      let headers: string[];
      let rows: string[][];
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".csv")) {
        const parsed = await readCsvFile(file);
        if (parsed.length === 0) throw new Error("CSVにデータがありません");
        [headers, ...rows] = parsed;
      } else {
        const { default: readXlsxFile } = await import("read-excel-file/universal");
        let sheetsData: { sheet: string; data: unknown[][] }[];
        try {
          sheetsData = await readXlsxFile(file);
        } catch {
          throw new Error("Excelファイルの読み込みに失敗しました。破損しているか、対応していない形式(.xls等)の可能性があります。");
        }
        const firstSheetRows = sheetsData[0]?.data ?? [];
        if (firstSheetRows.length === 0) throw new Error("Excelファイルにデータがありません");
        const stringRows = firstSheetRows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
        [headers, ...rows] = stringRows;
      }

      const cleanedRows = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
      if (cleanedRows.length === 0) throw new Error("有効なデータ行が見つかりませんでした");

      const parsedTable: ParsedTable = { headers, rows: cleanedRows };
      setTable(parsedTable);
      setMapping(autoMapColumns(textFields, headers));
      setPhotoColumnMapping(autoMapColumns(photoFields, headers));
      setMappingConfirmed(false);
      setPreviewRowIndex(0);
      setStep("mapping");
    } catch (e) {
      setError(e instanceof Error ? e.message : "CSV・Excelファイルの読み込みに失敗しました");
    }
  }

  // ---------------------------------------------------------------------
  // 6. 1人分プレビュー
  // ---------------------------------------------------------------------
  async function handlePreviewOne() {
    if (!templateBytes || !table) return;
    setError(null);
    setPreviewLoading(true);
    setPreviewImageUrls([]);

    try {
      const row = table.rows[previewRowIndex];
      const textValues: Record<string, string> = {};
      for (const field of textFields) {
        const idx = mapping[field.id] ? table.headers.indexOf(mapping[field.id] as string) : -1;
        textValues[field.id] = idx >= 0 ? row[idx] ?? "" : "";
      }
      const photoValues: Record<string, File | null> = {};
      for (const field of photoFields) {
        const col = photoColumnMapping[field.id];
        const idx = col ? table.headers.indexOf(col) : -1;
        const identifier = idx >= 0 ? row[idx] ?? "" : "";
        photoValues[field.id] = identifier
          ? photoLookup.find((p) => p.fileName.toLowerCase() === identifier.trim().toLowerCase() || p.normalizedStem === identifier.trim().toLowerCase())?.file ?? null
          : null;
      }

      const bytes = await renderPersonPdf({ templateBytes, fields, textValues, photoValues });
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      const pdf = await loadPdfDocument(new File([blob], "preview.pdf", { type: "application/pdf" }));
      const urls: string[] = [];
      const pagesWithFields = new Set(fields.map((f) => f.page));
      for (let i = 1; i <= pdf.numPages; i++) {
        if (!pagesWithFields.has(i)) continue;
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: Math.min(PREVIEW_MAX_WIDTH / page.getViewport({ scale: 1 }).width, 2) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport }).promise;
        urls.push(canvas.toDataURL("image/png"));
      }
      setPreviewImageUrls(urls);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "プレビューの生成に失敗しました");
    } finally {
      setPreviewLoading(false);
    }
  }

  // ---------------------------------------------------------------------
  // 7. 一括生成
  // ---------------------------------------------------------------------
  async function handleGenerateAll() {
    if (!templateBytes || !table) return;
    setError(null);
    setStatus("processing");
    setGeneratedZip(null);
    setProgressLabel("準備中...");

    try {
      const output = await new FormToIndividualPdfsProcessor().process({
        templateBytes,
        fields,
        table,
        mapping,
        photoColumnMapping,
        photoLookup,
        filenameStrategy,
        filenameColumn,
        onProgress: (info) => setProgressLabel(`PDFを生成中 ${info.current} / ${info.total}人`),
      });
      setGeneratedZip({ blob: output.zipBlob, personCount: output.personCount, missingPhotoCount: output.missingPhotoCount });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
    }
  }

  function handleDownloadZip() {
    if (!generatedZip) return;
    downloadBlob(generatedZip.blob, `${sanitizeFileName(templateFile?.name ? `個別PDF_${templateFile.name.replace(/\.pdf$/i, "")}` : "個別PDF一括")}.zip`);
  }

  const mappingComplete = textFields.every((f) => Boolean(mapping[f.id]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          帳票のPDFテンプレートに、Googleフォーム・Microsoft Formsなどから書き出したCSV/Excelの回答データや写真を差し込み、
          1人ずつの個別PDFをまとめて作成します。処理はすべてブラウザ内で行われ、
          アップロードしたテンプレート・CSV/Excel・写真・生成したPDFはMr.Sattoのサーバーへ保存されません。
        </p>
        <p>
          Googleフォーム・Microsoft Formsとの直接連携は行っていません。各フォームの「回答をダウンロード」機能で
          書き出したCSV（Googleフォーム）またはExcel（Microsoft Forms）をアップロードしてご利用ください。
        </p>
      </div>

      {error && <ErrorMessage message={error} />}

      {/* --- 1. テンプレートアップロード --- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">1. 帳票テンプレートPDFをアップロード</h2>
        <FileDropzone
          accept="application/pdf,.pdf"
          maxSizeMB={30}
          label="帳票のPDFをドラッグ&ドロップ"
          hint="またはタップして選択（1ファイル、上限30MB）"
          onFilesSelected={handleTemplateSelect}
          onError={setError}
        />
        {templateLoading && <p className="text-xs text-neutral-500">読み込み中...</p>}
      </section>

      {/* --- 2. フィールド配置 --- */}
      {templateFile && pageImageUrl && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">2. フィールドを配置</h2>

          {pages.length > 1 && (
            <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <span>ページ:</span>
              {pages.map((p) => (
                <button
                  key={p.pageNumber}
                  type="button"
                  onClick={() => void handlePageChange(p.pageNumber)}
                  className={`rounded px-2 py-1 ${
                    selectedPage === p.pageNumber
                      ? "bg-blue-600 text-white"
                      : "border border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  {p.pageNumber}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={handleAddField}
            className="w-fit rounded-lg border border-blue-500 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
          >
            + フィールドを追加
          </button>
          {placingFieldId && (
            <p className="text-xs text-blue-600 dark:text-blue-400">
              プレビュー上の配置したい位置をクリックしてください（項目の左上になります）。
            </p>
          )}

          <div ref={canvasWrapRef} className="w-full">
            <div
              className="relative select-none border border-neutral-300 dark:border-neutral-700"
              style={{ width: "fit-content", cursor: placingFieldId ? "crosshair" : "default" }}
              onClick={handleCanvasClick}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pageImageUrl} alt={`テンプレート ${selectedPage}ページ目のプレビュー`} draggable={false} />
              {currentPageInfo &&
                fields
                  .filter((f) => f.page === selectedPage)
                  .map((field) => (
                    <div
                      key={field.id}
                      onPointerDown={(e) => handleFieldPointerDown(e, field)}
                      onPointerMove={handleFieldPointerMove}
                      onPointerUp={handleFieldPointerUp}
                      className={`absolute flex items-center justify-center border-2 text-[10px] ${
                        activeFieldId === field.id
                          ? "border-blue-600 bg-blue-500/20"
                          : "border-emerald-500 bg-emerald-500/10"
                      }`}
                      style={{
                        left: pdfToScreenX(field.x, pageRenderScale),
                        top: pdfToScreenY(field.y, field.height, currentPageInfo.height, pageRenderScale),
                        width: field.width * pageRenderScale,
                        height: field.height * pageRenderScale,
                        cursor: "move",
                        touchAction: "none",
                      }}
                    >
                      {field.label}
                    </div>
                  ))}
            </div>
          </div>

          {fields.length > 0 && (
            <ul className="flex flex-col gap-3">
              {fields.map((field) => (
                <li
                  key={field.id}
                  className={`rounded-lg border p-3 text-xs ${
                    activeFieldId === field.id
                      ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20"
                      : "border-neutral-200 dark:border-neutral-800"
                  }`}
                  onClick={() => setActiveFieldId(field.id)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={field.label}
                      onChange={(e) => updateField(field.id, { label: e.target.value })}
                      className="w-28 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      placeholder="項目名"
                    />
                    <select
                      value={field.dataType}
                      onChange={(e) => updateField(field.id, { dataType: e.target.value as "text" | "photo" })}
                      className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="text">テキスト</option>
                      <option value="photo">写真</option>
                    </select>
                    <label className="flex items-center gap-1">
                      ページ
                      <select
                        value={field.page}
                        onChange={(e) => updateField(field.id, { page: Number(e.target.value) })}
                        className="rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        {pages.map((p) => (
                          <option key={p.pageNumber} value={p.pageNumber}>
                            {p.pageNumber}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      幅
                      <input
                        type="number"
                        value={Math.round(field.width)}
                        onChange={(e) => updateField(field.id, { width: Math.max(1, Number(e.target.value)) })}
                        className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      高さ
                      <input
                        type="number"
                        value={Math.round(field.height)}
                        onChange={(e) => updateField(field.id, { height: Math.max(1, Number(e.target.value)) })}
                        className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                    </label>
                    {field.dataType === "text" && (
                      <>
                        <label className="flex items-center gap-1">
                          文字サイズ
                          <input
                            type="number"
                            value={field.fontSize}
                            onChange={(e) => updateField(field.id, { fontSize: Math.max(4, Number(e.target.value)) })}
                            className="w-14 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <select
                          value={field.align}
                          onChange={(e) => updateField(field.id, { align: e.target.value as FieldDefinition["align"] })}
                          className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                        >
                          <option value="left">左揃え</option>
                          <option value="center">中央揃え</option>
                          <option value="right">右揃え</option>
                        </select>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPage(field.page);
                        setPlacingFieldId(field.id);
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      配置し直す
                    </button>
                    <button
                      type="button"
                      onClick={() => removeField(field.id)}
                      className="rounded border border-red-300 px-2 py-1 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {fields.length > 0 && (
            <button
              type="button"
              onClick={() => setStep("data")}
              className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              次へ（CSV/Excelのアップロード）
            </button>
          )}
        </section>
      )}

      {/* --- 3. CSV/Excelアップロード --- */}
      {(step === "data" || step === "mapping" || step === "photos" || step === "preview" || step === "generate") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">3. 回答データ（CSV・Excel）をアップロード</h2>
          <FileDropzone
            accept=".csv,.xlsx"
            maxSizeMB={20}
            label="CSV・Excelファイルをドラッグ&ドロップ"
            hint="Googleフォームの回答CSV、またはMicrosoft Formsの回答Excelファイル"
            onFilesSelected={handleDataFileSelect}
            onError={setError}
          />
          {table && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {table.rows.length}件のデータ行を読み込みました（列: {table.headers.join(", ")}）
            </p>
          )}
        </section>
      )}

      {/* --- 4. マッピング確認 --- */}
      {table && (step === "mapping" || step === "photos" || step === "preview" || step === "generate") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">4. 列の対応（マッピング）を確認</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            列名が完全一致する場合のみ自動で対応付けています。誤った対応付けを防ぐため、内容を確認し、必要であれば手動で選び直してください。
          </p>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th className="py-1 pr-2">項目</th>
                <th className="py-1">対応する列</th>
              </tr>
            </thead>
            <tbody>
              {textFields.map((field) => (
                <tr key={field.id} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="py-1 pr-2">{field.label}</td>
                  <td className="py-1">
                    <select
                      value={mapping[field.id] ?? ""}
                      onChange={(e) => setMapping((prev) => ({ ...prev, [field.id]: e.target.value || null }))}
                      className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="">（未設定）</option>
                      {table.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {photoFields.map((field) => (
                <tr key={field.id} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="py-1 pr-2">{field.label}（写真ファイル名の列）</td>
                  <td className="py-1">
                    <select
                      value={photoColumnMapping[field.id] ?? ""}
                      onChange={(e) => setPhotoColumnMapping((prev) => ({ ...prev, [field.id]: e.target.value || null }))}
                      className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="">（未設定）</option>
                      {table.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!mappingComplete && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              未設定のテキスト項目は、生成されるPDFで空欄になります。
            </p>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">ファイル名の付け方</span>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={filenameStrategy === "sequential"}
                  onChange={() => setFilenameStrategy("sequential")}
                />
                連番（001.pdf, 002.pdf...）
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={filenameStrategy === "name"}
                  onChange={() => setFilenameStrategy("name")}
                />
                連番＋列の値（例: 001_山田太郎.pdf）
              </label>
              {filenameStrategy === "name" && (
                <select
                  value={filenameColumn ?? ""}
                  onChange={(e) => setFilenameColumn(e.target.value || null)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="">列を選択</option>
                  {table.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {filenameStrategy === "name" && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                氏名など個人情報をファイル名に含めると、ダウンロード後の端末上でファイル名がそのまま見える状態になります。
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={mappingConfirmed} onChange={(e) => setMappingConfirmed(e.target.checked)} />
            列の対応・ファイル名の設定内容を確認しました
          </label>

          {photoFields.length > 0 ? (
            <button
              type="button"
              onClick={() => setStep("photos")}
              disabled={!mappingConfirmed}
              className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              次へ（写真のアップロード）
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handlePreviewOne()}
              disabled={!mappingConfirmed || previewLoading}
              className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {previewLoading ? "生成中..." : "1人分プレビューする"}
            </button>
          )}
        </section>
      )}

      {/* --- 5. 写真アップロード --- */}
      {photoFields.length > 0 && (step === "photos" || step === "preview" || step === "generate") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">5. 写真をアップロード</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            CSV・Excelの列に記載されたファイル名（拡張子の有無は問いません）と一致する画像だけが対応付けられます。
            一致しない場合は、その人の写真欄は空欄になります（無関係な写真が代わりに使われることはありません）。JPEG・PNGに対応しています。
          </p>
          <FileDropzone
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            multiple
            maxSizeMB={15}
            label="写真をまとめてドラッグ&ドロップ"
            hint="複数ファイル可"
            onFilesSelected={setPhotoFiles}
            onError={setError}
          />
          {photoFiles.length > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{photoFiles.length}枚の画像をアップロードしました</p>
          )}
          <button
            type="button"
            onClick={() => void handlePreviewOne()}
            disabled={previewLoading}
            className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {previewLoading ? "生成中..." : "1人分プレビューする"}
          </button>
        </section>
      )}

      {/* --- 6. プレビュー --- */}
      {(step === "preview" || step === "generate") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">6. 1人分のプレビュー</h2>
          {table && (
            <label className="flex items-center gap-2 text-xs">
              確認する行:
              <select
                value={previewRowIndex}
                onChange={(e) => {
                  setPreviewRowIndex(Number(e.target.value));
                }}
                className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {table.rows.map((_, i) => (
                  <option key={i} value={i}>
                    {i + 1}行目
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handlePreviewOne()}
                disabled={previewLoading}
                className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
              >
                この行でプレビュー
              </button>
            </label>
          )}
          {previewImageUrls.length > 0 && (
            <div className="flex flex-col gap-3">
              {previewImageUrls.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={url}
                  alt={`プレビュー ${i + 1}ページ目`}
                  className="w-full max-w-xl rounded border border-neutral-300 dark:border-neutral-700"
                />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setStep("generate")}
            className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            内容に問題なければ、全員分を一括生成する
          </button>
        </section>
      )}

      {/* --- 7. 一括生成 --- */}
      {step === "generate" && table && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">7. 全員分を一括生成</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            対象: {table.rows.length}人分。生成後、ZIPファイルとしてまとめてダウンロードできます。
          </p>
          <button
            type="button"
            onClick={() => void handleGenerateAll()}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            一括生成してZIPを作成する
          </button>

          <ProcessingStatus state={status} processingLabel={progressLabel || "処理中..."} successLabel="全員分のPDF生成が完了しました" />

          {generatedZip && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {generatedZip.personCount}人分のPDFを生成しました。処理が完了しました。アップロードしたデータ・生成したPDFはMr.Sattoのサーバーへ保存されません。
              </p>
              {generatedZip.missingPhotoCount > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  写真の識別子が一致しなかった行が{generatedZip.missingPhotoCount}件あります（該当ページの写真欄は空欄です）。
                </p>
              )}
              <button
                type="button"
                onClick={handleDownloadZip}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                ZIPをダウンロード
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
