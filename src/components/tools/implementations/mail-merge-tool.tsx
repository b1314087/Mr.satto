"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PDFFont } from "pdf-lib";
import { FileDropzone } from "@/components/common/file-dropzone";
import { usePageFileDrop } from "@/components/common/page-file-drop";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { closePdfDocument, loadPdfDocument, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";
import {
  autoMap,
  blankPageSizePt,
  clampPaperMm,
  DEFAULT_PAPER,
  fieldText,
  FIELD_LIMITS,
  FONT_OPTIONS,
  layoutField,
  newField,
  PAPER_PRESETS,
  ptToMm,
  round1,
  tableToData,
  type FieldLayout,
  type FieldSource,
  type FontId,
  type MergeData,
  type MergeField,
  type PaperSetting,
} from "@/lib/mail-merge/layout";
import { loadMeasureFont, makeMeasure, PREVIEW_FONT_FAMILY } from "@/lib/mail-merge/fonts";
import {
  cleanLayoutName,
  deleteLayout,
  duplicateLayout,
  LAYOUT_JSON_MAX_BYTES,
  layoutToJson,
  listLayouts,
  loadTemplate,
  MAX_FIELDS,
  overwriteLayout,
  parseLayoutJson,
  renameLayout,
  saveNewLayout,
  type LayoutBody,
  type SavedLayout,
} from "@/lib/mail-merge/storage";
import {
  classifyMergeFile,
  loadMergeFile,
  MERGE_FILE_ACCEPT,
  MERGE_LEGACY_EXCEL_MESSAGE,
  MERGE_UNSUPPORTED_MESSAGE,
  type LoadedMergeFile,
} from "@/lib/processors/browser/excel-merge";
import { MAIL_MERGE_MAX_RECORDS, MailMergeCanceled, MailMergeProcessor } from "@/lib/processors/browser/mail-merge";
import { downloadBlob, formatBytes, sanitizeFileName } from "@/lib/utils/format";

/** プレビューの内部の解像度（長い辺のピクセル数）。表示の大きさは画面の幅に合わせる */
const PREVIEW_LONG_SIDE = 1400;
const PREVIEW_ROWS = 5;

const inputCls = "w-full rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const subBtn = "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700";

function StepCard({ step, title, hint, testId, children }: { step: number; title: string; hint: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-4 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800 sm:p-5">
      <header className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
          {step}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">
            <span className="sr-only">手順{step}：</span>
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/** 数値の入力欄（入力中は文字のまま持ち、確定した値だけを範囲に収めて反映する） */
function NumInput({
  label,
  value,
  min,
  max,
  step = 0.5,
  unit,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(value);
  function commit(raw: string) {
    const n = Number(raw.replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    if (raw.trim() !== "" && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, round1(n))));
  }
  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
      <span>
        {label}
        {unit ? `（${unit}）` : ""}
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={shown}
        onFocus={() => {
          setText(String(value));
          setEditing(true);
        }}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => setEditing(false)}
        className={inputCls}
        data-testid={testId}
      />
    </label>
  );
}

let fieldSeq = 0;
const nextFieldId = () => `f${Date.now().toString(36)}${(fieldSeq++).toString(36)}`;

type Msg = { kind: "ok" | "error"; text: string } | null;

export function MailMergeTool() {
  // ---- 1. 用紙・背景 ----
  const [paper, setPaper] = useState<PaperSetting>(DEFAULT_PAPER);
  const [template, setTemplate] = useState<{ blob: Blob; name: string } | null>(null);
  const [templatePage, setTemplatePage] = useState(1);
  const [templateErrorMsg, setTemplateError] = useState<string | null>(null);

  // ---- 2. 項目 ----
  const [fields, setFields] = useState<MergeField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = fields.find((f) => f.id === selectedId) ?? null;

  // ---- 3. データ ----
  const [loaded, setLoaded] = useState<LoadedMergeFile | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(1);
  const [dataError, setDataError] = useState<string | null>(null);

  // ---- 4. 紐付け ----
  const [sources, setSources] = useState<Record<string, FieldSource>>({});

  // ---- 5. プレビュー ----
  const [recordIndex, setRecordIndex] = useState(0);
  const [jumpText, setJumpText] = useState("");
  const [overflowScan, setOverflowScan] = useState<{ records: number[]; checked: number } | null>(null);

  // ---- 6. 出力 ----
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; pageCount: number } | null>(null);
  const cancelRef = useRef<{ canceled: boolean } | null>(null);

  // ---- 保存 ----
  const [saved, setSaved] = useState<SavedLayout[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null);
  const [layoutName, setLayoutName] = useState("");
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [storageMsg, setStorageMsg] = useState<Msg>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  // ---- フォント（文字の幅の測定・プレビュー用） ----
  const [fonts, setFonts] = useState<Partial<Record<FontId, PDFFont>>>({});
  const [fontError, setFontError] = useState<string | null>(null);
  const needMincho = fields.some((f) => f.font === "mincho");
  useEffect(() => {
    let alive = true;
    const want: FontId[] = needMincho ? ["gothic", "mincho"] : ["gothic"];
    for (const id of want) {
      if (fonts[id]) continue;
      loadMeasureFont(id).then(
        (f) => alive && setFonts((prev) => ({ ...prev, [id]: f })),
        () => alive && setFontError("日本語フォントを読み込めませんでした。通信の状態を確かめて、ページを読み込み直してください。")
      );
    }
    return () => {
      alive = false;
    };
  }, [needMincho, fonts]);
  const measure = useMemo(() => makeMeasure(fonts), [fonts]);
  const fontsReady = !!fonts.gothic && (!needMincho || !!fonts.mincho);

  // ---- 背景のPDFを画面用に描く（読み込みが終わった結果だけを、どの背景・ページの結果かと一緒に持つ） ----
  const [rendered, setRendered] = useState<{
    template: { blob: Blob; name: string };
    page: number;
    info: { pages: number; widthPt: number; heightPt: number; canvas: HTMLCanvasElement } | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!template) return;
    let alive = true;
    (async () => {
      const file = template.blob instanceof File ? template.blob : new File([template.blob], template.name, { type: "application/pdf" });
      const pdf = await loadPdfDocument(file);
      try {
        const pages = pdf.numPages;
        const pageNo = Math.min(Math.max(1, templatePage), pages);
        const page = await pdf.getPage(pageNo);
        const vp = page.getViewport({ scale: 1 });
        const { canvas } = await renderPageToCanvas(page, PREVIEW_LONG_SIDE / Math.max(vp.width, vp.height), PREVIEW_LONG_SIDE);
        if (alive) setRendered({ template, page: templatePage, info: { pages, widthPt: vp.width, heightPt: vp.height, canvas }, error: null });
      } finally {
        await closePdfDocument(pdf);
      }
    })().catch((e) => {
      if (alive) setRendered({ template, page: templatePage, info: null, error: e instanceof Error ? e.message : "PDFを読み込めませんでした。" });
    });
    return () => {
      alive = false;
    };
  }, [template, templatePage]);
  const renderedCurrent = !!template && rendered?.template === template && rendered.page === templatePage;
  const templateInfo = renderedCurrent ? rendered!.info : null;
  const templateLoading = !!template && !renderedCurrent;
  const templateError = templateErrorMsg ?? (renderedCurrent ? rendered!.error : null);

  const pageSize = useMemo(() => {
    if (paper.mode === "pdf") return templateInfo ? { width: templateInfo.widthPt, height: templateInfo.heightPt } : null;
    return blankPageSizePt(paper);
  }, [paper, templateInfo]);
  const pageMm = pageSize ? { w: ptToMm(pageSize.width), h: ptToMm(pageSize.height) } : null;

  // ---- データ ----
  const data: MergeData | null = useMemo(() => {
    if (!loaded) return null;
    const sheet = loaded.sheets[Math.min(sheetIndex, loaded.sheets.length - 1)];
    return sheet ? tableToData(sheet.rows, headerRow) : null;
  }, [loaded, sheetIndex, headerRow]);
  const recordCount = data?.records.length ?? 0;
  const currentRecord = Math.min(recordIndex, Math.max(0, recordCount - 1));

  // 項目ごとの差し込む文字の決め方。利用者が選んでいない項目（または選んだ列がデータにない項目）は、
  // 同じ名前・同じ意味の列があれば自動で紐付ける（迷うものは紐付けない）
  const effectiveSources: Record<string, FieldSource> = useMemo(() => {
    const out: Record<string, FieldSource> = {};
    for (const f of fields) {
      const s = sources[f.id];
      const missing = s?.kind === "column" && data && !data.columns.includes(s.column);
      if (s && !missing) {
        out[f.id] = s;
        continue;
      }
      const col = data ? autoMap(f.name, data.columns) : null;
      out[f.id] = col ? { kind: "column", column: col } : (s ?? { kind: "none" });
    }
    return out;
  }, [fields, sources, data]);

  function clearResult() {
    setResult(null);
    setStatus("idle");
    setRunError(null);
    setSummaryOpen(false);
    setOverflowScan(null);
  }

  // ---- 1件分の配置（プレビュー） ----
  const layouts: { field: MergeField; layout: FieldLayout; empty: boolean; text: string }[] = useMemo(() => {
    if (!pageSize || !fonts.gothic) return [];
    return fields.map((field) => {
      const text = fieldText(field, effectiveSources[field.id], data, currentRecord);
      const empty = text === "";
      // 値がない項目は、位置が分かるよう［項目名］を薄く出す（PDFには何も出さない）
      const layout = layoutField(field, empty ? `［${field.name || "項目"}］` : text, pageSize, measure);
      return { field, layout, empty, text };
    });
  }, [fields, effectiveSources, data, currentRecord, pageSize, measure, fonts.gothic]);

  // ---- プレビューを描く ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasSize = pageSize
    ? pageSize.width >= pageSize.height
      ? { w: PREVIEW_LONG_SIDE, h: Math.round((PREVIEW_LONG_SIDE * pageSize.height) / pageSize.width) }
      : { w: Math.round((PREVIEW_LONG_SIDE * pageSize.width) / pageSize.height), h: PREVIEW_LONG_SIDE }
    : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageSize || !canvasSize) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const k = canvas.width / pageSize.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (paper.mode === "pdf" && templateInfo) ctx.drawImage(templateInfo.canvas, 0, 0, canvas.width, canvas.height);
    ctx.textBaseline = "alphabetic";
    try {
      (ctx as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning = "none";
    } catch {
      /* 古いブラウザ */
    }
    for (const { layout, empty } of layouts) {
      for (const run of layout.runs) {
        ctx.font = `${run.sizePt * k}px "${PREVIEW_FONT_FAMILY[run.font]}", sans-serif`;
        ctx.fillStyle = empty ? "rgba(100,116,139,0.55)" : run.color;
        ctx.fillText(run.text, run.x * k, run.baseline * k);
      }
    }
  }, [layouts, pageSize, canvasSize?.w, canvasSize?.h, templateInfo, paper.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 項目の操作 ----
  function updateField(id: string, patch: Partial<MergeField>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    clearResult();
  }

  function addFieldAt(xMm: number, yMm: number) {
    if (fields.length >= MAX_FIELDS) return;
    // データを読み込んでいれば、まだ使っていない列の名前を項目名にして、その列に紐付ける
    const usedCols = new Set(Object.values(effectiveSources).flatMap((s) => (s.kind === "column" ? [s.column] : [])));
    const col = data?.columns.find((c) => !usedCols.has(c));
    const id = nextFieldId();
    const name = (col ?? `項目${fields.length + 1}`).slice(0, FIELD_LIMITS.name);
    setFields((prev) => [...prev, newField(id, name, xMm, yMm)]);
    if (col) setSources((prev) => ({ ...prev, [id]: { kind: "column", column: col } }));
    setSelectedId(id);
    clearResult();
  }

  function removeField(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setSources((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedId === id) setSelectedId(null);
    clearResult();
  }

  function duplicateField(f: MergeField) {
    if (fields.length >= MAX_FIELDS) return;
    const id = nextFieldId();
    setFields((prev) => [...prev, { ...f, id, name: `${f.name}`.slice(0, FIELD_LIMITS.name), xMm: round1(f.xMm + 5), yMm: round1(f.yMm + 5) }]);
    const s = effectiveSources[f.id];
    if (s) setSources((prev) => ({ ...prev, [id]: s }));
    setSelectedId(id);
    clearResult();
  }

  /** データの列ごとに項目をまとめて作る（上から順に並べる。あとから動かして使う） */
  function addFieldsFromColumns() {
    if (!data || !pageMm) return;
    const usedCols = new Set(Object.values(effectiveSources).flatMap((s) => (s.kind === "column" ? [s.column] : [])));
    const cols = data.columns.filter((c) => !usedCols.has(c)).slice(0, MAX_FIELDS - fields.length);
    const newFields: MergeField[] = [];
    const newSources: Record<string, FieldSource> = {};
    cols.forEach((c, i) => {
      const id = nextFieldId();
      newFields.push(newField(id, c.slice(0, FIELD_LIMITS.name), 15, Math.min(pageMm.h - 10, 15 + i * 9)));
      newSources[id] = { kind: "column", column: c };
    });
    setFields((prev) => [...prev, ...newFields]);
    setSources((prev) => ({ ...prev, ...newSources }));
    if (newFields[0]) setSelectedId(newFields[0].id);
    clearResult();
  }

  // ---- プレビューの上での操作（クリックで追加・ドラッグで移動） ----
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; fx: number; fy: number; moved: boolean } | null>(null);

  function pointToMm(clientX: number, clientY: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !pageMm || rect.width === 0) return null;
    return { x: ((clientX - rect.left) / rect.width) * pageMm.w, y: ((clientY - rect.top) / rect.height) * pageMm.h };
  }

  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.stageBg) return;
    const p = pointToMm(e.clientX, e.clientY);
    if (!p) return;
    addFieldAt(p.x, p.y);
  }

  function onBoxPointerDown(e: React.PointerEvent<HTMLDivElement>, f: MergeField) {
    e.stopPropagation();
    setSelectedId(f.id);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { id: f.id, startX: e.clientX, startY: e.clientY, fx: f.xMm, fy: f.yMm, moved: false };
  }

  function onBoxPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!d || !rect || !pageMm || rect.width === 0) return;
    const dx = ((e.clientX - d.startX) / rect.width) * pageMm.w;
    const dy = ((e.clientY - d.startY) / rect.height) * pageMm.h;
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 3) return;
    d.moved = true;
    const clamp = (v: number) => Math.min(FIELD_LIMITS.mm[1], Math.max(FIELD_LIMITS.mm[0], round1(v)));
    updateField(d.id, { xMm: clamp(d.fx + dx), yMm: clamp(d.fy + dy) });
  }

  function onBoxPointerUp() {
    dragRef.current = null;
  }

  function onBoxKeyDown(e: React.KeyboardEvent<HTMLDivElement>, f: MergeField) {
    const step = e.shiftKey ? 5 : 0.5;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      updateField(f.id, { xMm: round1(f.xMm + m[0]), yMm: round1(f.yMm + m[1]) });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeField(f.id);
    }
  }

  // ---- ファイルの読み込み ----
  function acceptTemplateFile(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      setTemplateError("背景には、PDFファイルを選んでください。");
      return;
    }
    setTemplate({ blob: file, name: file.name });
    setTemplatePage(1);
    setPaper((p) => ({ ...p, mode: "pdf" }));
    clearResult();
  }

  async function acceptDataFile(file: File) {
    setDataError(null);
    const kind = classifyMergeFile(file);
    if (kind === "legacy-excel") return setDataError(MERGE_LEGACY_EXCEL_MESSAGE);
    if (kind === "unsupported") return setDataError(MERGE_UNSUPPORTED_MESSAGE);
    try {
      const l = await loadMergeFile(file);
      if (l.sheets.length === 0) throw new Error("シートが見つかりませんでした。");
      setLoaded(l);
      setSheetIndex(0);
      setHeaderRow(1);
      setRecordIndex(0);
      clearResult();
    } catch (e) {
      setLoaded(null);
      setDataError(e instanceof Error ? e.message : "ファイルを読み込めませんでした。");
    }
  }

  // ページのどこにファイルを落としても、PDFは背景に、Excel・CSVはデータとして読み込む
  const pageDropOverlay = usePageFileDrop({
    enabled: status !== "processing",
    onFiles: (files) => {
      for (const f of files) {
        if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") acceptTemplateFile(f);
        else void acceptDataFile(f);
      }
    },
    onReject: setDataError,
    hint: "背景のPDF・Excel・CSV",
  });

  // ---- 保存 ----
  const body: LayoutBody = {
    paper,
    fields,
    sources: effectiveSources,
    templateName: paper.mode === "pdf" ? (template?.name ?? null) : null,
    templatePage,
  };

  async function refreshSaved() {
    try {
      setSaved(await listLayouts());
    } catch (e) {
      setStorageMsg({ kind: "error", text: e instanceof Error ? e.message : "保存したレイアウトを読み込めませんでした。" });
    }
  }
  useEffect(() => {
    listLayouts().then(setSaved, (e) => setStorageMsg({ kind: "error", text: e instanceof Error ? e.message : "保存したレイアウトを読み込めませんでした。" }));
  }, []);

  async function withStorage(fn: () => Promise<string>) {
    setStorageBusy(true);
    setStorageMsg(null);
    try {
      const text = await fn();
      setStorageMsg({ kind: "ok", text });
    } catch (e) {
      setStorageMsg({ kind: "error", text: e instanceof Error ? e.message : "保存できませんでした。" });
    } finally {
      setStorageBusy(false);
      await refreshSaved();
    }
  }

  const templateToSave = saveTemplate && paper.mode === "pdf" && template ? template.blob : null;

  function saveNew() {
    void withStorage(async () => {
      const l = await saveNewLayout(layoutName || "レイアウト", body, templateToSave);
      setCurrentLayoutId(l.id);
      setLayoutName(l.name);
      return `「${l.name}」を保存しました${l.hasTemplate ? "（背景のPDFも保存）" : ""}。`;
    });
  }

  function overwrite(id: string) {
    void withStorage(async () => {
      const l = await overwriteLayout(id, body, templateToSave);
      setCurrentLayoutId(l.id);
      return `「${l.name}」に上書き保存しました${l.hasTemplate ? "（背景のPDFも保存）" : ""}。`;
    });
  }

  function applyBody(b: LayoutBody) {
    setPaper(b.paper);
    setFields(b.fields);
    setSources(b.sources);
    setTemplatePage(b.templatePage);
    setSelectedId(null);
    clearResult();
  }

  function loadSaved(l: SavedLayout) {
    void withStorage(async () => {
      let tmpl: Blob | null = null;
      if (l.hasTemplate) tmpl = await loadTemplate(l.id);
      applyBody(l);
      setCurrentLayoutId(l.id);
      setLayoutName(l.name);
      if (tmpl) {
        setTemplate({ blob: tmpl, name: l.templateName ?? "背景.pdf" });
        setSaveTemplate(true);
        return `「${l.name}」を読み込みました（背景のPDFも読み込みました）。`;
      }
      setSaveTemplate(false);
      if (l.paper.mode === "pdf" && !template) return `「${l.name}」を読み込みました。背景のPDF${l.templateName ? `（${l.templateName}）` : ""}は保存していないため、もう一度選んでください。`;
      return `「${l.name}」を読み込みました。`;
    });
  }

  function exportJson() {
    const name = cleanLayoutName(layoutName) || "レイアウト";
    downloadBlob(new Blob([layoutToJson(name, body)], { type: "application/json" }), `${sanitizeFileName(name)}.json`);
    setStorageMsg({ kind: "ok", text: "レイアウトをJSONに書き出しました（背景のPDFは含みません）。" });
  }

  async function importJson(file: File) {
    setStorageMsg(null);
    if (file.size > LAYOUT_JSON_MAX_BYTES) return setStorageMsg({ kind: "error", text: "ファイルが大きすぎます。このツールで書き出したレイアウトのJSONを選んでください。" });
    try {
      const { name, body: b } = parseLayoutJson(await file.text());
      applyBody(b);
      setLayoutName(name);
      setCurrentLayoutId(null);
      const needPdf = b.paper.mode === "pdf" && !template;
      setStorageMsg({
        kind: "ok",
        text: `「${name}」を読み込みました（まだ保存はしていません）。${needPdf ? `背景のPDF${b.templateName ? `（${b.templateName}）` : ""}を選んでください。` : ""}`,
      });
    } catch (e) {
      setStorageMsg({ kind: "error", text: e instanceof Error ? e.message : "JSONを読み込めませんでした。" });
    }
  }

  // ---- はみ出しの確認 ----
  const currentOverflow = layouts.filter((l) => !l.empty && (l.layout.overflowBox || l.layout.overflowPage));
  function scanOverflow(): number[] {
    if (!data || !pageSize) return [];
    const bad: number[] = [];
    for (let i = 0; i < data.records.length; i++) {
      for (const f of fields) {
        const t = fieldText(f, effectiveSources[f.id], data, i);
        if (!t) continue;
        const l = layoutField(f, t, pageSize, measure);
        if (l.overflowBox || l.overflowPage) {
          bad.push(i);
          break;
        }
      }
    }
    setOverflowScan({ records: bad, checked: data.records.length });
    return bad;
  }

  // ---- 出力 ----
  const unmapped = fields.filter((f) => effectiveSources[f.id].kind === "none");
  const blockers: string[] = [];
  if (!pageSize) blockers.push(paper.mode === "pdf" ? "背景のPDFを選んでください。" : "用紙の大きさを決めてください。");
  if (fields.length === 0) blockers.push("プレビューをクリックして、差し込む項目を追加してください。");
  if (!data) blockers.push("Excel・CSVのデータを読み込んでください。");
  else if (recordCount === 0) blockers.push("データの行がありません。見出しの行の番号を確かめてください。");
  else if (recordCount > MAIL_MERGE_MAX_RECORDS) blockers.push(`1回に作れるのは${MAIL_MERGE_MAX_RECORDS}件までです（${recordCount}件あります）。データを分けてください。`);
  if (fields.length > 0 && unmapped.length === fields.length) blockers.push("項目とデータの列を紐付けてください。");
  if (!fontsReady) blockers.push("フォントを読み込んでいます…");

  async function run() {
    if (!data || blockers.length > 0) return;
    const signal = { canceled: false };
    cancelRef.current = signal;
    setStatus("processing");
    setRunError(null);
    setResult(null);
    setProgress({ done: 0, total: data.records.length });
    try {
      const out = await new MailMergeProcessor().process({
        paper,
        template: paper.mode === "pdf" ? (template?.blob ?? null) : null,
        templatePageIndex: templatePage - 1,
        fields,
        sources: effectiveSources,
        data,
        signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(out);
      setStatus("success");
    } catch (e) {
      if (e instanceof MailMergeCanceled) {
        setStatus("idle");
        setRunError("作成を中止しました。");
      } else {
        setStatus("error");
        setRunError(e instanceof Error ? e.message : "PDFを作成できませんでした。");
      }
    } finally {
      setProgress(null);
      cancelRef.current = null;
    }
  }

  const presetLabel = PAPER_PRESETS.find((p) => p.id === paper.presetId)?.label ?? "";
  const templateLabel =
    paper.mode === "pdf"
      ? `${template?.name ?? "（未選択）"}${templateInfo && templateInfo.pages > 1 ? ` の${templatePage}ページ目` : ""}`
      : `白紙：${presetLabel}・${paper.orientation === "landscape" ? "横向き" : "縦向き"}`;

  // ========================================================================
  return (
    <div className="flex flex-col gap-6" data-testid="mail-merge-tool">
      {pageDropOverlay}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        {/* ------------------- 左：プレビュー ------------------- */}
        <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:self-start" data-testid="tool-preview">
          <PreviewFullscreenFrame>
            {pageSize && canvasSize ? (
              // 縦長の用紙でも、画面の高さに収まる幅にする（項目を動かしながら全体を見られるように）
              <div className="mx-auto w-full max-w-[44rem]" style={{ width: `min(100%, max(18rem, calc((100vh - 15rem) * ${(pageSize.width / pageSize.height).toFixed(4)})))` }}>
                <div
                  ref={stageRef}
                  className="relative w-full cursor-crosshair select-none border border-neutral-300 shadow-sm dark:border-neutral-700"
                  style={{ aspectRatio: `${pageSize.width} / ${pageSize.height}` }}
                  onClick={onStageClick}
                  data-testid="mail-merge-stage"
                  data-page-w-mm={pageMm ? round1(pageMm.w) : undefined}
                  data-page-h-mm={pageMm ? round1(pageMm.h) : undefined}
                >
                  <canvas
                    ref={canvasRef}
                    width={canvasSize.w}
                    height={canvasSize.h}
                    data-stage-bg="1"
                    className="absolute inset-0 h-full w-full"
                    data-testid="mail-merge-canvas"
                    aria-label="差し込みのプレビュー"
                  />
                  {layouts.map(({ field, layout }) => {
                    const over = layout.overflowBox || layout.overflowPage;
                    const isSel = field.id === selectedId;
                    return (
                      <div
                        key={field.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`項目「${field.name}」（矢印キーで移動）`}
                        aria-pressed={isSel}
                        onPointerDown={(e) => onBoxPointerDown(e, field)}
                        onPointerMove={onBoxPointerMove}
                        onPointerUp={onBoxPointerUp}
                        onPointerCancel={onBoxPointerUp}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => onBoxKeyDown(e, field)}
                        onFocus={() => setSelectedId(field.id)}
                        className={`absolute cursor-move touch-none outline-none ${
                          over ? "border-2 border-red-500 bg-red-500/10" : isSel ? "border-2 border-blue-600 bg-blue-500/10" : "border border-dashed border-blue-400/70 hover:bg-blue-500/5"
                        }`}
                        style={{
                          left: `${(layout.box.x / pageSize.width) * 100}%`,
                          top: `${(layout.box.y / pageSize.height) * 100}%`,
                          width: `${(layout.box.w / pageSize.width) * 100}%`,
                          height: `${(layout.box.h / pageSize.height) * 100}%`,
                        }}
                        data-testid="mail-merge-box"
                        data-field-id={field.id}
                        data-field-name={field.name}
                        data-overflow={over ? "true" : undefined}
                      >
                        <span className={`pointer-events-none absolute -top-4 left-0 whitespace-nowrap rounded px-1 text-[10px] leading-4 text-white ${over ? "bg-red-500" : isSel ? "bg-blue-600" : "bg-blue-400/80"}`}>
                          {field.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex aspect-[210/297] w-full max-w-[44rem] items-center justify-center rounded-lg border border-dashed border-neutral-300 text-sm text-neutral-500 dark:border-neutral-700">
                {templateLoading ? "背景のPDFを読み込んでいます…" : "背景のPDFを選ぶか、白紙を選んでください"}
              </div>
            )}
          </PreviewFullscreenFrame>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            プレビューの空いているところをクリックすると、そこに項目を追加します。項目はドラッグか矢印キー（Shiftで5mmずつ）で動かせます。
            {!fontsReady && !fontError && " フォントを読み込んでいます…"}
          </p>
          {fontError && <ErrorMessage message={fontError} />}

          {/* 件数の移動（手順5） */}
          {data && recordCount > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-testid="mail-merge-nav">
              <button type="button" className={subBtn} onClick={() => setRecordIndex(0)} disabled={currentRecord === 0} data-testid="mail-merge-first">
                « 最初
              </button>
              <button type="button" className={subBtn} onClick={() => setRecordIndex(Math.max(0, currentRecord - 1))} disabled={currentRecord === 0} data-testid="mail-merge-prev">
                ‹ 前へ
              </button>
              <span className="min-w-[7rem] text-center text-sm font-medium tabular-nums" data-testid="mail-merge-position" aria-live="polite">
                {currentRecord + 1}件目 / 全{recordCount}件
              </span>
              <button type="button" className={subBtn} onClick={() => setRecordIndex(Math.min(recordCount - 1, currentRecord + 1))} disabled={currentRecord >= recordCount - 1} data-testid="mail-merge-next">
                次へ ›
              </button>
              <button type="button" className={subBtn} onClick={() => setRecordIndex(recordCount - 1)} disabled={currentRecord >= recordCount - 1} data-testid="mail-merge-last">
                最後 »
              </button>
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Math.floor(Number(jumpText));
                  if (Number.isFinite(n) && n >= 1) setRecordIndex(Math.min(recordCount, n) - 1);
                  setJumpText("");
                }}
              >
                <input type="number" min={1} max={recordCount} value={jumpText} onChange={(e) => setJumpText(e.target.value)} placeholder="番号" aria-label="移動する件数の番号" className="w-20 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" data-testid="mail-merge-jump" />
                <button type="submit" className={subBtn} data-testid="mail-merge-jump-go">
                  件目へ
                </button>
              </form>
            </div>
          )}
          {currentOverflow.length > 0 && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300" role="status" data-testid="mail-merge-overflow-current">
              この件では、{currentOverflow.map((l) => `「${l.field.name}」`).join("")}が枠{currentOverflow.some((l) => l.layout.overflowPage) ? "・用紙" : ""}からはみ出しています。文字サイズは自動では変えません。位置・最大幅・文字サイズを調整するか、項目の「枠に入らないときだけ小さくする」をオンにしてください。
            </p>
          )}
          {data && recordCount > 0 && fields.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={subBtn} onClick={() => scanOverflow()} disabled={!fontsReady} data-testid="mail-merge-scan">
                全件のはみ出しを確かめる
              </button>
              {overflowScan && (
                <span className="text-xs" data-testid="mail-merge-scan-result" role="status">
                  {overflowScan.records.length === 0 ? (
                    <span className="text-emerald-700 dark:text-emerald-400">全{overflowScan.checked}件、はみ出しはありません。</span>
                  ) : (
                    <span className="text-red-700 dark:text-red-300">
                      {overflowScan.records.length}件ではみ出しています：
                      {overflowScan.records.slice(0, 20).map((i) => (
                        <button key={i} type="button" className="mx-0.5 underline" onClick={() => setRecordIndex(i)}>
                          {i + 1}
                        </button>
                      ))}
                      {overflowScan.records.length > 20 && "…"}件目
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ------------------- 右：手順 ------------------- */}
        <div className="flex min-w-0 flex-col gap-4">
          <StepCard step={1} title="背景（テンプレート）を決める" hint="PDFを背景にするか、白紙の用紙を選びます。" testId="mail-merge-step-template">
            <div className="flex gap-2" role="radiogroup" aria-label="背景の種類">
              {(
                [
                  ["pdf", "PDFを背景にする"],
                  ["blank", "白紙から作る"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={paper.mode === mode}
                  onClick={() => {
                    setPaper((p) => ({ ...p, mode }));
                    clearResult();
                  }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${paper.mode === mode ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" : "border-neutral-300 dark:border-neutral-700"}`}
                  data-testid={`mail-merge-mode-${mode}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {paper.mode === "pdf" ? (
              <div className="flex flex-col gap-2">
                <FileDropzone accept=".pdf,application/pdf" maxSizeMB={100} label="背景にするPDFを選ぶ" hint="ドラッグ&ドロップ、またはタップして選択" onFilesSelected={(files) => files[0] && acceptTemplateFile(files[0])} onError={setTemplateError} pageDrop={false} />
                {template && (
                  <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="mail-merge-template-name">
                    背景：{template.name}（{formatBytes(template.blob.size)}）
                    {templateInfo && pageMm && ` ・ ${round1(pageMm.w)}×${round1(pageMm.h)}mm`}
                  </p>
                )}
                {templateInfo && templateInfo.pages > 1 && (
                  <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                    背景に使うページ
                    <select value={templatePage} onChange={(e) => setTemplatePage(Number(e.target.value))} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" data-testid="mail-merge-template-page">
                      {Array.from({ length: Math.min(templateInfo.pages, 500) }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1}ページ目
                        </option>
                      ))}
                    </select>
                    （全{templateInfo.pages}ページ）
                  </label>
                )}
                {templateError && <ErrorMessage message={templateError} testId="mail-merge-template-error" />}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                  用紙の大きさ
                  <select
                    value={paper.presetId}
                    onChange={(e) => {
                      const id = e.target.value as PaperSetting["presetId"];
                      setPaper((p) => ({ ...p, presetId: id }));
                      clearResult();
                    }}
                    className={inputCls}
                    data-testid="mail-merge-preset"
                  >
                    {PAPER_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                {paper.presetId === "custom" && (
                  <>
                    <NumInput label="幅" unit="mm" value={paper.widthMm} min={20} max={1200} step={1} onChange={(v) => setPaper((p) => ({ ...p, widthMm: clampPaperMm(v) }))} testId="mail-merge-paper-w" />
                    <NumInput label="高さ" unit="mm" value={paper.heightMm} min={20} max={1200} step={1} onChange={(v) => setPaper((p) => ({ ...p, heightMm: clampPaperMm(v) }))} testId="mail-merge-paper-h" />
                  </>
                )}
                <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                  向き
                  <select value={paper.orientation} onChange={(e) => setPaper((p) => ({ ...p, orientation: e.target.value as PaperSetting["orientation"] }))} className={inputCls} data-testid="mail-merge-orientation">
                    <option value="portrait">縦向き</option>
                    <option value="landscape">横向き</option>
                  </select>
                </label>
              </div>
            )}
          </StepCard>

          <StepCard step={2} title="差し込む項目を置く" hint="プレビューをクリックして項目を追加し、ドラッグで動かします。細かい位置は数値で調整できます。" testId="mail-merge-step-fields">
            {fields.length === 0 ? (
              <p className="text-xs text-neutral-500">まだ項目がありません。プレビューをクリックしてください。</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5" aria-label="項目の一覧">
                {fields.map((f) => (
                  <li key={f.id}>
                    <button type="button" onClick={() => setSelectedId(f.id)} className={`rounded-full border px-2.5 py-1 text-xs ${f.id === selectedId ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-300 dark:border-neutral-700"}`} data-testid="mail-merge-field-chip">
                      {f.name || "（名前なし）"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={subBtn} onClick={() => pageMm && addFieldAt(pageMm.w * 0.1, pageMm.h * 0.1 + fields.length * 2)} disabled={!pageMm || fields.length >= MAX_FIELDS} data-testid="mail-merge-add-field">
                ＋ 項目を追加
              </button>
              {data && (
                <button type="button" className={subBtn} onClick={addFieldsFromColumns} disabled={!pageMm || fields.length >= MAX_FIELDS} data-testid="mail-merge-add-from-columns">
                  データの列から項目をまとめて作る
                </button>
              )}
            </div>
            {selected && (
              <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-900 dark:bg-blue-950/20" data-testid="mail-merge-field-panel">
                <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                  項目名
                  <input value={selected.name} maxLength={FIELD_LIMITS.name} onChange={(e) => updateField(selected.id, { name: e.target.value })} className={inputCls} data-testid="mail-merge-field-name" />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <NumInput label="X（左から）" unit="mm" value={selected.xMm} min={FIELD_LIMITS.mm[0]} max={FIELD_LIMITS.mm[1]} onChange={(v) => updateField(selected.id, { xMm: v })} testId="mail-merge-field-x" />
                  <NumInput label="Y（上から）" unit="mm" value={selected.yMm} min={FIELD_LIMITS.mm[0]} max={FIELD_LIMITS.mm[1]} onChange={(v) => updateField(selected.id, { yMm: v })} testId="mail-merge-field-y" />
                  <NumInput label="文字サイズ" unit="pt" value={selected.sizePt} min={FIELD_LIMITS.sizePt[0]} max={FIELD_LIMITS.sizePt[1]} onChange={(v) => updateField(selected.id, { sizePt: v })} testId="mail-merge-field-size" />
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    文字色
                    <input type="color" value={selected.color} onChange={(e) => updateField(selected.id, { color: e.target.value.toLowerCase() })} className="h-[34px] w-full cursor-pointer rounded-lg border border-neutral-300 bg-white dark:border-neutral-700" data-testid="mail-merge-field-color" />
                  </label>
                  <NumInput label="最大幅（0＝指定なし）" unit="mm" value={selected.maxWidthMm} min={0} max={FIELD_LIMITS.boxMm[1]} onChange={(v) => updateField(selected.id, { maxWidthMm: v })} testId="mail-merge-field-maxw" />
                  <NumInput label="最大高さ（0＝指定なし）" unit="mm" value={selected.maxHeightMm} min={0} max={FIELD_LIMITS.boxMm[1]} onChange={(v) => updateField(selected.id, { maxHeightMm: v })} testId="mail-merge-field-maxh" />
                </div>
                <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                  フォント
                  <select value={selected.font} onChange={(e) => updateField(selected.id, { font: e.target.value as FontId })} className={inputCls} data-testid="mail-merge-field-font">
                    {FONT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    横位置
                    <select value={selected.align} onChange={(e) => updateField(selected.id, { align: e.target.value as MergeField["align"] })} className={inputCls} data-testid="mail-merge-field-align">
                      <option value="left">左揃え</option>
                      <option value="center">中央</option>
                      <option value="right">右揃え</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    縦位置
                    <select value={selected.vAlign} onChange={(e) => updateField(selected.id, { vAlign: e.target.value as MergeField["vAlign"] })} className={inputCls} data-testid="mail-merge-field-valign">
                      <option value="top">上</option>
                      <option value="middle">中央</option>
                      <option value="bottom">下</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    書字方向
                    <select value={selected.direction} onChange={(e) => updateField(selected.id, { direction: e.target.value as MergeField["direction"] })} className={inputCls} data-testid="mail-merge-field-direction">
                      <option value="horizontal">横書き</option>
                      <option value="vertical">縦書き</option>
                    </select>
                  </label>
                </div>
                <p className="text-[11px] text-neutral-500">横位置・縦位置は、最大幅・最大高さの枠の中での位置です（枠を指定しないときは、左上の位置から書きます）。</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    前に付ける文字
                    <input value={selected.prefix} maxLength={FIELD_LIMITS.affix} placeholder="例：〒" onChange={(e) => updateField(selected.id, { prefix: e.target.value })} className={inputCls} data-testid="mail-merge-field-prefix" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    後ろに付ける文字
                    <input value={selected.suffix} maxLength={FIELD_LIMITS.affix} placeholder="例： 様" onChange={(e) => updateField(selected.id, { suffix: e.target.value })} className={inputCls} data-testid="mail-merge-field-suffix" />
                  </label>
                </div>
                <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-200">
                  <input type="checkbox" className="mt-0.5" checked={selected.shrinkToFit} onChange={(e) => updateField(selected.id, { shrinkToFit: e.target.checked })} data-testid="mail-merge-field-shrink" />
                  <span>最大幅・最大高さの枠に入らないときだけ、文字を小さくして収める（オフのときは、設定した文字サイズのまま）</span>
                </label>
                <div className="flex gap-2">
                  <button type="button" className={subBtn} onClick={() => duplicateField(selected)} disabled={fields.length >= MAX_FIELDS} data-testid="mail-merge-field-duplicate">
                    複製
                  </button>
                  <button type="button" className={`${subBtn} text-red-600 dark:text-red-400`} onClick={() => removeField(selected.id)} data-testid="mail-merge-field-delete">
                    この項目を削除
                  </button>
                </div>
              </div>
            )}
          </StepCard>

          <StepCard step={3} title="Excel・CSVを読み込む" hint="1行目が見出し（列名）、2行目からが1件ずつのデータです。" testId="mail-merge-step-data">
            <FileDropzone accept={MERGE_FILE_ACCEPT} maxSizeMB={50} label="Excel・CSVを選ぶ" hint="ドラッグ&ドロップ、またはタップして選択" onFilesSelected={(files) => files[0] && void acceptDataFile(files[0])} onError={setDataError} acceptHandoff={false} pageDrop={false} />
            {dataError && <ErrorMessage message={dataError} testId="mail-merge-data-error" />}
            {loaded && data && (
              <div className="flex flex-col gap-2 text-xs" data-testid="mail-merge-data-info">
                <p className="text-neutral-700 dark:text-neutral-200">
                  {loaded.fileName}：<span data-testid="mail-merge-record-count">{recordCount}</span>件・{data.columns.length}列
                </p>
                <div className="flex flex-wrap gap-3">
                  {loaded.sheets.length > 1 && (
                    <label className="flex items-center gap-1">
                      シート
                      <select value={sheetIndex} onChange={(e) => { setSheetIndex(Number(e.target.value)); setRecordIndex(0); clearResult(); }} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" data-testid="mail-merge-sheet">
                        {loaded.sheets.map((s, i) => (
                          <option key={i} value={i}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-1">
                    見出しの行
                    <input type="number" min={1} max={100} value={headerRow} onChange={(e) => { const n = Math.floor(Number(e.target.value)); if (n >= 1 && n <= 100) { setHeaderRow(n); setRecordIndex(0); clearResult(); } }} className="w-16 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" data-testid="mail-merge-header-row" />
                    行目
                  </label>
                </div>
                {recordCount === 0 ? (
                  <p className="text-red-600 dark:text-red-400" role="status">データの行がありません。見出しの行の番号を確かめてください。</p>
                ) : (
                  <>
                    {recordCount > MAIL_MERGE_MAX_RECORDS && <p className="text-red-600 dark:text-red-400">1回に作れるのは{MAIL_MERGE_MAX_RECORDS}件までです。データを分けてください。</p>}
                    <div className="max-h-56 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                      <table className="w-full border-collapse text-[11px]" data-testid="mail-merge-data-table">
                        <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
                          <tr>
                            <th className="px-1.5 py-1 text-left font-medium">#</th>
                            {data.columns.map((c, i) => (
                              <th key={i} className="whitespace-nowrap px-1.5 py-1 text-left font-medium">
                                {c}
                                {data.blanks[i] > 0 && <span className="ml-1 font-normal text-amber-600" title="空欄の数">（空欄{data.blanks[i]}）</span>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.records.slice(0, PREVIEW_ROWS).map((r, ri) => (
                            <tr key={ri} className="border-t border-neutral-200 dark:border-neutral-800">
                              <td className="px-1.5 py-1 text-neutral-400">{ri + 1}</td>
                              {r.map((v, ci) => (
                                <td key={ci} className={`max-w-[10rem] truncate px-1.5 py-1 ${v.trim() === "" ? "bg-amber-50 dark:bg-amber-950/30" : ""}`} title={v}>
                                  {v}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {recordCount > PREVIEW_ROWS && <p className="text-neutral-500">先頭の{PREVIEW_ROWS}件を表示しています。</p>}
                  </>
                )}
              </div>
            )}
          </StepCard>

          <StepCard step={4} title="項目とデータの列を紐付ける" hint="同じ名前の列は自動で紐付けます。違うときは選び直してください。1つの列を複数の項目に使えます。" testId="mail-merge-step-map">
            {fields.length === 0 ? (
              <p className="text-xs text-neutral-500">先に項目を追加してください。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {fields.map((f) => {
                  const s = effectiveSources[f.id];
                  const value = s.kind === "none" ? "" : s.kind === "fixed" ? "__fixed__" : `col:${s.column}`;
                  const chosen = sources[f.id];
                  // 保存していた列が、読み込んだデータにない（自動でも紐付けられなかった）
                  const missing = chosen?.kind === "column" && s.kind === "column" && data && !data.columns.includes(s.column) ? chosen : null;
                  return (
                    <div key={f.id} className="flex flex-col gap-1" data-testid="mail-merge-map-row" data-field-name={f.name}>
                      <label className="flex items-center gap-2 text-xs">
                        <span className="w-24 shrink-0 truncate font-medium" title={f.name}>
                          {f.name || "（名前なし）"}
                        </span>
                        <select
                          value={missing ? "" : value}
                          onChange={(e) => {
                            const v = e.target.value;
                            const next: FieldSource = v === "" ? { kind: "none" } : v === "__fixed__" ? { kind: "fixed", text: s.kind === "fixed" ? s.text : "" } : { kind: "column", column: v.slice(4) };
                            setSources((prev) => ({ ...prev, [f.id]: next }));
                            clearResult();
                          }}
                          className={inputCls}
                          aria-label={`「${f.name}」に差し込む列`}
                          data-testid="mail-merge-map-select"
                        >
                          <option value="">（差し込まない）</option>
                          {(data?.columns ?? []).map((c) => (
                            <option key={c} value={`col:${c}`}>
                              列：{c}
                            </option>
                          ))}
                          <option value="__fixed__">固定の文字（全件同じ）</option>
                        </select>
                      </label>
                      {s.kind === "fixed" && (
                        <input value={s.text} maxLength={2000} placeholder="全件に同じ文字を入れます" onChange={(e) => { setSources((prev) => ({ ...prev, [f.id]: { kind: "fixed", text: e.target.value } })); clearResult(); }} className={inputCls} aria-label={`「${f.name}」の固定の文字`} data-testid="mail-merge-map-fixed" />
                      )}
                      {missing && <p className="text-[11px] text-amber-600">保存していた列「{missing.column}」が、このデータにありません。選び直してください。</p>}
                    </div>
                  );
                })}
                {!data && <p className="text-xs text-neutral-500">Excel・CSVを読み込むと、列を選べます。</p>}
              </div>
            )}
          </StepCard>

          <StepCard step={5} title="内容を確かめて、PDFを作る" hint="件数・ページ数などを確かめてから作成します。1件が1ページになります。" testId="mail-merge-step-output">
            {blockers.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-300" data-testid="mail-merge-blockers">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : !summaryOpen ? (
              <button type="button" onClick={() => { setSummaryOpen(true); scanOverflow(); }} className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700" data-testid="mail-merge-summary-open">
                作成する内容を確認する
              </button>
            ) : (
              <div className="flex flex-col gap-3" data-testid="mail-merge-summary">
                <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-sm">
                  <dt className="text-neutral-500">件数</dt>
                  <dd data-testid="mail-merge-summary-records">{recordCount}件</dd>
                  <dt className="text-neutral-500">ページ数</dt>
                  <dd data-testid="mail-merge-summary-pages">{recordCount}ページ（1件1ページ）</dd>
                  <dt className="text-neutral-500">背景</dt>
                  <dd className="break-all">{templateLabel}{pageMm && `（${round1(pageMm.w)}×${round1(pageMm.h)}mm）`}</dd>
                  <dt className="text-neutral-500">項目</dt>
                  <dd>
                    {fields.length}個
                    {unmapped.length > 0 && <span className="text-amber-600">（差し込まない項目：{unmapped.map((f) => f.name).join("、")}）</span>}
                  </dd>
                  <dt className="text-neutral-500">形式</dt>
                  <dd>PDF（1つのファイル）</dd>
                  <dt className="text-neutral-500">はみ出し</dt>
                  <dd>{overflowScan && overflowScan.records.length > 0 ? <span className="text-red-600">{overflowScan.records.length}件ではみ出しがあります（そのまま作成もできます）</span> : "ありません"}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void run()} disabled={status === "processing"} aria-busy={status === "processing" || undefined} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="mail-merge-run">
                    {status === "processing" ? "作成中…" : `PDFを作成（${recordCount}ページ）`}
                  </button>
                  <button type="button" onClick={() => setSummaryOpen(false)} className={subBtn}>
                    戻る
                  </button>
                </div>
              </div>
            )}
            <ProcessingStatus
              state={status}
              processingLabel={progress ? `PDFを作成しています… ${progress.done}/${progress.total}件` : "PDFを作成しています…"}
              successLabel="PDFを作成しました"
              onCancel={() => {
                if (cancelRef.current) cancelRef.current.canceled = true;
              }}
              cancelLabel="作成を中止"
            />
            {runError && <ErrorMessage message={runError} testId="mail-merge-run-error" />}
            {result && (
              <ResultPopup>
                <p className="text-sm" data-testid="mail-merge-result">
                  {result.pageCount}ページのPDFができました（{formatBytes(result.blob.size)}）。
                </p>
                <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, `差し込み印刷_${result.pageCount}件.pdf`)} label="PDFをダウンロード" />
              </ResultPopup>
            )}
          </StepCard>

          {/* ------------------- レイアウトの保存 ------------------- */}
          <section className="flex flex-col gap-3 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800 sm:p-5" data-testid="mail-merge-storage">
            <header>
              <h2 className="text-base font-semibold">レイアウトの保存</h2>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">用紙・項目・列の紐付けを、このブラウザの中に保存します（サーバーには送りません）。ブラウザのデータを消すと、保存したレイアウトも消えます。</p>
            </header>
            <div className="flex gap-2">
              <input value={layoutName} maxLength={50} onChange={(e) => setLayoutName(e.target.value)} placeholder="レイアウトの名前（例：案内状）" aria-label="レイアウトの名前" className={inputCls} data-testid="mail-merge-layout-name" />
              <button type="button" onClick={saveNew} disabled={storageBusy || fields.length === 0} className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="mail-merge-save-new">
                新しく保存
              </button>
            </div>
            {paper.mode === "pdf" && template && (
              <label className="flex items-start gap-2 text-xs text-neutral-700 dark:text-neutral-200">
                <input type="checkbox" className="mt-0.5" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} data-testid="mail-merge-save-template" />
                <span>背景のPDF（{formatBytes(template.blob.size)}）も一緒に保存する（ブラウザの保存容量を使います）</span>
              </label>
            )}
            {storageMsg && (
              <p role={storageMsg.kind === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-xs ${storageMsg.kind === "error" ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"}`} data-testid="mail-merge-storage-msg" data-kind={storageMsg.kind}>
                {storageMsg.text}
              </p>
            )}
            {saved.length > 0 ? (
              <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" data-testid="mail-merge-saved-list">
                {saved.map((l) => (
                  <li key={l.id} className="flex flex-col gap-1.5 px-3 py-2" data-testid="mail-merge-saved-item" data-layout-name={l.name}>
                    {renamingId === l.id ? (
                      <form
                        className="flex gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          setRenamingId(null);
                          void withStorage(async () => {
                            await renameLayout(l.id, renameText);
                            if (currentLayoutId === l.id) setLayoutName(cleanLayoutName(renameText));
                            return `名前を「${cleanLayoutName(renameText)}」に変更しました。`;
                          });
                        }}
                      >
                        <input value={renameText} maxLength={50} autoFocus onChange={(e) => setRenameText(e.target.value)} aria-label="新しい名前" className={inputCls} data-testid="mail-merge-rename-input" />
                        <button type="submit" className={subBtn} data-testid="mail-merge-rename-ok">
                          決定
                        </button>
                        <button type="button" className={subBtn} onClick={() => setRenamingId(null)}>
                          やめる
                        </button>
                      </form>
                    ) : (
                      <p className="text-sm">
                        <span className="font-medium">{l.name}</span>
                        {currentLayoutId === l.id && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">編集中</span>}
                        <span className="ml-2 text-[11px] text-neutral-500">
                          項目{l.fields.length}個{l.hasTemplate ? `・背景PDFあり${l.templateBytes ? `（${formatBytes(l.templateBytes)}）` : ""}` : ""}・{new Date(l.updatedAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}
                        </span>
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className={subBtn} disabled={storageBusy} onClick={() => loadSaved(l)} data-testid="mail-merge-saved-load">
                        読み込む
                      </button>
                      <button type="button" className={subBtn} disabled={storageBusy} onClick={() => { setRenamingId(l.id); setRenameText(l.name); }} data-testid="mail-merge-saved-rename">
                        名前変更
                      </button>
                      <button type="button" className={subBtn} disabled={storageBusy || fields.length === 0} onClick={() => overwrite(l.id)} title="今のレイアウトで上書きします" data-testid="mail-merge-saved-overwrite">
                        上書き
                      </button>
                      <button type="button" className={subBtn} disabled={storageBusy} onClick={() => void withStorage(async () => `「${(await duplicateLayout(l.id)).name}」を作りました。`)} data-testid="mail-merge-saved-duplicate">
                        複製
                      </button>
                      {confirmDeleteId === l.id ? (
                        <>
                          <button
                            type="button"
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              void withStorage(async () => {
                                await deleteLayout(l.id);
                                if (currentLayoutId === l.id) setCurrentLayoutId(null);
                                return `「${l.name}」を削除しました。`;
                              });
                            }}
                            data-testid="mail-merge-saved-delete-confirm"
                          >
                            本当に削除
                          </button>
                          <button type="button" className={subBtn} onClick={() => setConfirmDeleteId(null)}>
                            やめる
                          </button>
                        </>
                      ) : (
                        <button type="button" className={`${subBtn} text-red-600 dark:text-red-400`} disabled={storageBusy} onClick={() => setConfirmDeleteId(l.id)} data-testid="mail-merge-saved-delete">
                          削除
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-neutral-500" data-testid="mail-merge-saved-empty">保存したレイアウトはまだありません。</p>
            )}
            <div className="flex flex-wrap gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <button type="button" className={subBtn} onClick={exportJson} disabled={fields.length === 0} data-testid="mail-merge-export-json">
                JSONに書き出す
              </button>
              <button type="button" className={subBtn} onClick={() => jsonInputRef.current?.click()} data-testid="mail-merge-import-json">
                JSONを読み込む
              </button>
              <input
                ref={jsonInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importJson(f);
                }}
                data-testid="mail-merge-import-input"
              />
              <p className="w-full text-[11px] text-neutral-500">JSONには背景のPDFは入りません。ほかの端末で使うときは、PDFも一緒に用意してください。</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
