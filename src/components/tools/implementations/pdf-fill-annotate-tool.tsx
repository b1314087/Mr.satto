"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { PdfFillAnnotateProcessor } from "@/lib/processors/browser/pdf-fill-annotate";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import {
  createAnnotationId,
  DUPLICATE_OFFSET_PT,
  PDF_FILL_ANNOTATE_LIMITS,
  type AnnotationColor,
  type AnnotationObject,
  type CheckboxAnnotationObject,
  type CheckboxMarkStyle,
  type ImageAnnotationObject,
  type InkAnnotationObject,
  type InkPoint,
  type LineShapeObject,
  type RectangleShapeObject,
  type CircleShapeObject,
  type ShapeAnnotationObject,
  type ShapeKind,
  type TextAlign,
  type TextAnnotationObject,
} from "@/lib/pdf-annotate/types";
import { rotatePointAround } from "@/lib/pdf-annotate/geometry";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/**
 * PDF記入・注釈（Phase 15）。
 *
 * 「PDFに文字を書き込んで、その場でダウンロードする」ためのツール。
 * 電子契約サービス・書類管理サービスへの転換ではなく、Mr.Sattoの既存方針
 * （面倒な作業を、サッと。ブラウザ内完結・軽量・履歴を残さない）に沿った、
 * その場限りの記入・注釈専用機能として実装している。
 *
 * アーキテクチャはform-to-individual-pdfs-tool.tsx（PDFページのcanvas描画→
 * Pointer Eventsによる配置・ドラッグ移動→pdf-libでの書き出し）を踏襲し、
 * ドラッグ&ドロップ用の新規ライブラリは追加していない。
 *
 * 「保存」という言葉は、このツールのUI上では常に「編集したPDFを端末へ
 * ダウンロードすること」だけを意味する。サーバー側にPDF・入力内容・
 * 生成物を保存することは一切行わない。
 */

type ToolMode = "select" | "text" | "checkbox" | "ink" | "image" | "stamp" | "shape";
type ColorChoice = "black" | "red" | "blue";

interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

interface PendingImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  previewUrl: string;
  aspectRatio: number;
  /** 電子印鑑生成からの取り込みなど「印影」として配置するかのラベル用フラグ */
  isStamp: boolean;
}

const PREVIEW_MAX_WIDTH = 640;
// Phase 17: 座標変換の検証対象倍率(100/125/150/200%)を含む形へ拡張
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const;
const ROTATE_STEP_DEG = 15;
const MARK_STYLE_LABELS: Record<CheckboxMarkStyle, string> = { check: "レ点", cross: "×", circle: "○" };
const ALIGN_LABELS: Record<TextAlign, string> = { left: "左揃え", center: "中央揃え", right: "右揃え" };
const SHAPE_KIND_LABELS: Record<ShapeKind, string> = { rectangle: "矩形", circle: "円・楕円", line: "直線" };

const COLOR_CHOICES: Record<ColorChoice, AnnotationColor> = {
  black: { r: 0.1, g: 0.1, b: 0.12 },
  red: { r: 0.82, g: 0.15, b: 0.15 },
  blue: { r: 0.1, g: 0.35, b: 0.85 },
};
const COLOR_LABELS: Record<ColorChoice, string> = { black: "黒", red: "赤", blue: "青" };

function cssColor(c: AnnotationColor): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

function pdfToScreenX(pdfX: number, scale: number): number {
  return pdfX * scale;
}
function pdfToScreenY(pdfY: number, height: number, pageHeight: number, scale: number): number {
  return (pageHeight - pdfY - height) * scale;
}
function screenToPdfX(screenX: number, scale: number): number {
  return screenX / scale;
}
function screenToPdfY(screenY: number, height: number, pageHeight: number, scale: number): number {
  return pageHeight - screenY / scale - height;
}
function pointDistance(a: InkPoint, b: InkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function inkBounds(obj: InkAnnotationObject) {
  const xs = obj.points.map((p) => p.x);
  const ys = obj.points.map((p) => p.y);
  const pad = Math.max(obj.strokeWidth, 1);
  return {
    minX: Math.min(...xs) - pad,
    maxX: Math.max(...xs) + pad,
    minY: Math.min(...ys) - pad,
    maxY: Math.max(...ys) + pad,
  };
}
function lineBounds(obj: LineShapeObject) {
  const pad = Math.max(obj.strokeWidth, 1);
  return {
    minX: Math.min(obj.x1, obj.x2) - pad,
    maxX: Math.max(obj.x1, obj.x2) + pad,
    minY: Math.min(obj.y1, obj.y2) - pad,
    maxY: Math.max(obj.y1, obj.y2) + pad,
  };
}
function normalizeRotation(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}
function formatDate(iso: string, style: "slash" | "kanji"): string {
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return "";
  return style === "kanji" ? `${y}年${m}月${d}日` : `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}

export function PdfFillAnnotateTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState(1);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageImagePixelSize, setPageImagePixelSize] = useState({ width: 0, height: 0 });
  const [pageRenderScale, setPageRenderScale] = useState(1);
  const [zoom, setZoom] = useState<number>(100);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const [objects, setObjects] = useState<AnnotationObject[]>([]);
  const pastRef = useRef<AnnotationObject[][]>([]);
  const futureRef = useRef<AnnotationObject[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [mode, setMode] = useState<ToolMode>("select");
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  const [repositioningId, setRepositioningId] = useState<string | null>(null);

  const dragState = useRef<{
    id: string;
    startX: number;
    startY: number;
    original: AnnotationObject;
    snapshot: AnnotationObject[];
  } | null>(null);
  const textEditStartRef = useRef<{ id: string; text: string } | null>(null);

  // --- テキスト配置の既定値 ---
  const [textFontSize, setTextFontSize] = useState(14);
  const [textColorChoice, setTextColorChoice] = useState<ColorChoice>("black");
  const [textBold, setTextBold] = useState(false);
  const [textAlign, setTextAlign] = useState<TextAlign>("left");

  // --- チェック配置の既定値 ---
  const [checkboxSize, setCheckboxSize] = useState(16);
  const [checkboxMarkStyle, setCheckboxMarkStyle] = useState<CheckboxMarkStyle>("check");

  // --- 図形配置の既定値（Phase 17） ---
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
  const [shapeColorChoice, setShapeColorChoice] = useState<ColorChoice>("blue");
  const [shapeStrokeWidth, setShapeStrokeWidth] = useState(2);
  const [shapeFill, setShapeFill] = useState(false);

  // --- ページ移動（ページ番号を指定してジャンプ） ---
  const [pageJumpValue, setPageJumpValue] = useState("");

  // --- 手書き ---
  const [inkColorChoice, setInkColorChoice] = useState<ColorChoice>("black");
  const [inkThickness, setInkThickness] = useState(2.5);
  const [eraseMode, setEraseMode] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<InkPoint[] | null>(null);
  const drawingPreSnapshotRef = useRef<AnnotationObject[] | null>(null);

  // --- 画像 ---
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);

  // --- 書き出し ---
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  const currentPageInfo = pages.find((p) => p.pageNumber === selectedPage) ?? null;
  const pageObjects = objects.filter((o) => o.page === selectedPage);

  // 生成結果のObject URLは画面上で直接使わないため、ページを離れる際に解放する
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // アンマウント時に、配置済みの画像注釈が保持しているObject URLをまとめて解放する
  // （Undo/Redoで復元し直す可能性があるため、削除の都度ではなくページ離脱時にまとめて行う）
  const objectsRef = useRef(objects);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);
  useEffect(() => {
    return () => {
      for (const o of objectsRef.current) {
        if (o.type === "image") URL.revokeObjectURL(o.previewUrl);
      }
    };
  }, []);

  function pushHistory(snapshot: AnnotationObject[]) {
    pastRef.current.push(snapshot);
    if (pastRef.current.length > PDF_FILL_ANNOTATE_LIMITS.maxUndoHistory) {
      pastRef.current.shift();
    }
    futureRef.current = [];
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(false);
  }

  function commit(next: AnnotationObject[]) {
    pushHistory(objects);
    setObjects(next);
  }

  function handleUndo() {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current.push(objects);
    setObjects(prev);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
    setActiveObjectId(null);
  }

  function handleRedo() {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(objects);
    if (pastRef.current.length > PDF_FILL_ANNOTATE_LIMITS.maxUndoHistory) pastRef.current.shift();
    setObjects(next);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
    setActiveObjectId(null);
  }

  function removeObject(id: string) {
    commit(objects.filter((o) => o.id !== id));
    if (activeObjectId === id) setActiveObjectId(null);
    if (repositioningId === id) setRepositioningId(null);
  }

  // Deleteキーで選択中のオブジェクトを削除する（キーボード操作のための最低限の対応）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!activeObjectId) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      removeObject(activeObjectId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeObjectId, objects]);

  function patchObjectLive(id: string, patch: Record<string, unknown>) {
    setObjects((prev) => prev.map((o) => (o.id === id ? ({ ...o, ...patch } as AnnotationObject) : o)));
  }

  function patchObjectWithHistory(id: string, patch: Record<string, unknown>) {
    const snapshot = objects;
    const next = objects.map((o) => (o.id === id ? ({ ...o, ...patch } as AnnotationObject) : o));
    pushHistory(snapshot);
    setObjects(next);
  }

  // ---------------------------------------------------------------------
  // 2.5 複製・回転・前面/背面（Phase 17）
  // ---------------------------------------------------------------------
  function duplicateObject(id: string) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    if (objects.length >= PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument) {
      setError(`配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument}個までです。`);
      return;
    }
    const onSamePage = objects.filter((o) => o.page === target.page).length;
    if (onSamePage >= PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerPage) {
      setError(`1ページに配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerPage}個までです。`);
      return;
    }
    const d = DUPLICATE_OFFSET_PT;
    let clone: AnnotationObject;
    if (target.type === "ink") {
      clone = { ...target, id: createAnnotationId("ink"), points: target.points.map((p) => ({ x: p.x + d, y: p.y + d })) };
    } else if (target.type === "shape" && target.shapeKind === "line") {
      clone = { ...target, id: createAnnotationId("shape"), x1: target.x1 + d, y1: target.y1 + d, x2: target.x2 + d, y2: target.y2 + d };
    } else {
      // text / checkbox / image / shape(rectangle・circle): 明らかにズレて見えるようx,yを両方ずらす
      clone = { ...target, id: createAnnotationId(target.type), x: target.x + d, y: target.y + d } as AnnotationObject;
    }
    commit([...objects, clone]);
    setActiveObjectId(clone.id);
  }

  /** 矩形・円・画像（rotationフィールドを持つもの）の回転を指定角ぶん進める */
  function rotateByField(id: string, deltaDeg: number) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    if (target.type === "image") {
      patchObjectWithHistory(id, { rotation: normalizeRotation((target.rotation ?? 0) + deltaDeg) });
    } else if (target.type === "shape" && target.shapeKind !== "line") {
      patchObjectWithHistory(id, { rotation: normalizeRotation(target.rotation + deltaDeg) });
    }
  }

  /** 直線・手書き（回転フィールドを持たないもの）は、中心を軸に座標をその場で回転させる */
  function rotateByBaking(id: string, deltaDeg: number) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    if (target.type === "ink") {
      const b = inkBounds(target);
      const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      patchObjectWithHistory(id, { points: target.points.map((p) => rotatePointAround(p, center, deltaDeg)) });
    } else if (target.type === "shape" && target.shapeKind === "line") {
      const center = { x: (target.x1 + target.x2) / 2, y: (target.y1 + target.y2) / 2 };
      const p1 = rotatePointAround({ x: target.x1, y: target.y1 }, center, deltaDeg);
      const p2 = rotatePointAround({ x: target.x2, y: target.y2 }, center, deltaDeg);
      patchObjectWithHistory(id, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
  }

  function rotateObject(id: string, deltaDeg: number) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    if (target.type === "image" || (target.type === "shape" && target.shapeKind !== "line")) {
      rotateByField(id, deltaDeg);
    } else if (target.type === "ink" || (target.type === "shape" && target.shapeKind === "line")) {
      rotateByBaking(id, deltaDeg);
    }
  }

  /** 選択中オブジェクトを、同じページ内の他のオブジェクトに対して最前面/最背面へ移動する */
  function reorderObject(id: string, direction: "front" | "back") {
    const idx = objects.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const target = objects[idx];
    const without = objects.filter((o) => o.id !== id);
    const samePageIndices = without.reduce<number[]>((acc, o, i) => {
      if (o.page === target.page) acc.push(i);
      return acc;
    }, []);
    let insertAt: number;
    if (samePageIndices.length === 0) {
      insertAt = without.length;
    } else if (direction === "front") {
      insertAt = samePageIndices[samePageIndices.length - 1] + 1;
    } else {
      insertAt = samePageIndices[0];
    }
    const next = [...without.slice(0, insertAt), target, ...without.slice(insertAt)];
    commit(next);
  }

  // ---------------------------------------------------------------------
  // 1. PDFアップロード・ページ表示
  // ---------------------------------------------------------------------
  async function handleFileSelect(files: File[]) {
    const f = files[0];
    if (!f) return;
    setError(null);
    setLoading(true);
    setResult(null);
    setStatus("idle");

    for (const o of objects) {
      if (o.type === "image") URL.revokeObjectURL(o.previewUrl);
    }
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
    setObjects([]);
    pastRef.current = [];
    futureRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setActiveObjectId(null);
    setRepositioningId(null);
    setMode("select");

    setFile(f);
    setPageImageUrl(null);

    try {
      const bytes = await f.arrayBuffer();
      setPdfBytes(bytes);
      const pdf = await loadPdfDocument(new File([bytes], f.name, { type: "application/pdf" }));
      if (pdf.numPages === 0) throw new Error("このPDFにはページがありません");
      const pageInfos: PageInfo[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        pageInfos.push({ pageNumber: i, width: viewport.width, height: viewport.height });
      }
      setPages(pageInfos);
      setSelectedPage(1);
      setZoom(100);
      await renderPagePreview(pdf, 1, pageInfos[0], 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
      setFile(null);
      setPdfBytes(null);
      setPages([]);
    } finally {
      setLoading(false);
    }
  }

  async function renderPagePreview(
    pdf: Awaited<ReturnType<typeof loadPdfDocument>>,
    pageNumber: number,
    pageInfo: PageInfo,
    zoomPercent: number
  ) {
    const page = await pdf.getPage(pageNumber);
    const containerWidth = canvasWrapRef.current?.clientWidth || PREVIEW_MAX_WIDTH;
    const baseWidth = Math.min(containerWidth, PREVIEW_MAX_WIDTH);
    const scale = (baseWidth / pageInfo.width) * (zoomPercent / 100);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("プレビューの生成に失敗しました");
    await page.render({ canvasContext: ctx, viewport }).promise;
    setPageRenderScale(scale);
    setPageImagePixelSize({ width: canvas.width, height: canvas.height });
    setPageImageUrl(canvas.toDataURL("image/png"));
  }

  async function reloadPreview(pageNumber: number, zoomPercent: number) {
    if (!file || !pdfBytes) return;
    const pageInfo = pages.find((p) => p.pageNumber === pageNumber);
    if (!pageInfo) return;
    const pdf = await loadPdfDocument(new File([pdfBytes.slice(0)], file.name, { type: "application/pdf" }));
    await renderPagePreview(pdf, pageNumber, pageInfo, zoomPercent);
  }

  function handlePageChange(pageNumber: number) {
    if (pageNumber < 1 || pageNumber > pages.length) return;
    setSelectedPage(pageNumber);
    setActiveObjectId(null);
    setRepositioningId(null);
    void reloadPreview(pageNumber, zoom);
  }

  function handleZoomChange(z: number) {
    setZoom(z);
    void reloadPreview(selectedPage, z);
  }

  // ---------------------------------------------------------------------
  // 2. 配置（クリックで配置 / 配置し直し）
  // ---------------------------------------------------------------------
  function atObjectLimit(): boolean {
    if (objects.length >= PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument) {
      setError(`配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument}個までです。`);
      return true;
    }
    const onThisPage = objects.filter((o) => o.page === selectedPage).length;
    if (onThisPage >= PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerPage) {
      setError(`1ページに配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerPage}個までです。`);
      return true;
    }
    return false;
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!currentPageInfo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const pdfX = screenToPdfX(clickX, pageRenderScale);

    if (repositioningId) {
      const target = objects.find((o) => o.id === repositioningId);
      if (target) {
        if (target.type === "ink") {
          const b = inkBounds(target);
          const centerX = (b.minX + b.maxX) / 2;
          const centerY = (b.minY + b.maxY) / 2;
          const newCenterY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
          const dx = pdfX - centerX;
          const dy = newCenterY - centerY;
          patchObjectWithHistory(target.id, {
            points: target.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          });
        } else if (target.type === "shape" && target.shapeKind === "line") {
          const centerX = (target.x1 + target.x2) / 2;
          const centerY = (target.y1 + target.y2) / 2;
          const newCenterY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
          const dx = pdfX - centerX;
          const dy = newCenterY - centerY;
          patchObjectWithHistory(target.id, {
            x1: target.x1 + dx,
            y1: target.y1 + dy,
            x2: target.x2 + dx,
            y2: target.y2 + dy,
          });
        } else if (target.type === "shape") {
          const pdfY = screenToPdfY(clickY, target.height, currentPageInfo.height, pageRenderScale);
          patchObjectWithHistory(target.id, { x: Math.max(0, pdfX), y: Math.max(0, pdfY) });
        } else {
          const h = target.type === "image" ? target.height : target.type === "checkbox" ? target.size : 0;
          const pdfY = screenToPdfY(clickY, h, currentPageInfo.height, pageRenderScale);
          patchObjectWithHistory(target.id, { x: Math.max(0, pdfX), y: Math.max(0, pdfY) });
        }
      }
      setRepositioningId(null);
      return;
    }

    if (mode === "text") {
      if (atObjectLimit()) return;
      const fontSize = textFontSize;
      const pdfY = screenToPdfY(clickY, fontSize * 0.3, currentPageInfo.height, pageRenderScale);
      const obj: TextAnnotationObject = {
        id: createAnnotationId("text"),
        type: "text",
        page: selectedPage,
        x: Math.max(0, pdfX),
        y: Math.max(0, pdfY),
        text: "",
        fontSize,
        color: COLOR_CHOICES[textColorChoice],
        bold: textBold,
        align: textAlign,
      };
      commit([...objects, obj]);
      setActiveObjectId(obj.id);
      setMode("select");
    } else if (mode === "checkbox") {
      if (atObjectLimit()) return;
      const size = checkboxSize;
      const pdfY = screenToPdfY(clickY, size, currentPageInfo.height, pageRenderScale);
      const obj: CheckboxAnnotationObject = {
        id: createAnnotationId("checkbox"),
        type: "checkbox",
        page: selectedPage,
        x: Math.max(0, pdfX),
        y: Math.max(0, pdfY),
        size,
        checked: false,
        markStyle: checkboxMarkStyle,
      };
      commit([...objects, obj]);
      setActiveObjectId(obj.id);
      setMode("select");
    } else if ((mode === "image" || mode === "stamp") && pendingImage) {
      if (atObjectLimit()) return;
      const maxWidthPt = Math.min(currentPageInfo.width * 0.6, 220);
      const width = maxWidthPt;
      const height = width / pendingImage.aspectRatio;
      const pdfY = screenToPdfY(clickY, height, currentPageInfo.height, pageRenderScale);
      const obj: ImageAnnotationObject = {
        id: createAnnotationId(pendingImage.isStamp ? "stamp" : "image"),
        type: "image",
        page: selectedPage,
        x: Math.max(0, pdfX),
        y: Math.max(0, pdfY),
        width,
        height,
        bytes: pendingImage.bytes,
        mimeType: pendingImage.mimeType,
        previewUrl: pendingImage.previewUrl,
        aspectRatio: pendingImage.aspectRatio,
        rotation: 0,
        aspectLocked: true,
        isStamp: pendingImage.isStamp,
      };
      commit([...objects, obj]);
      setActiveObjectId(obj.id);
      setPendingImage(null);
      setMode("select");
    } else if (mode === "shape") {
      if (atObjectLimit()) return;
      const color = COLOR_CHOICES[shapeColorChoice];
      if (shapeKind === "line") {
        const centerY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
        const half = 40;
        const obj: LineShapeObject = {
          id: createAnnotationId("shape"),
          type: "shape",
          shapeKind: "line",
          page: selectedPage,
          x1: Math.max(0, pdfX - half),
          y1: Math.max(0, centerY - half * 0.5),
          x2: pdfX + half,
          y2: centerY + half * 0.5,
          color,
          strokeWidth: shapeStrokeWidth,
        };
        commit([...objects, obj]);
        setActiveObjectId(obj.id);
      } else {
        const width = shapeKind === "circle" ? 70 : 100;
        const height = shapeKind === "circle" ? 70 : 60;
        const centerY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
        const base = {
          id: createAnnotationId("shape"),
          type: "shape" as const,
          page: selectedPage,
          x: Math.max(0, pdfX - width / 2),
          y: Math.max(0, centerY - height / 2),
          width,
          height,
          rotation: 0,
          color,
          strokeWidth: shapeStrokeWidth,
          fill: shapeFill,
        };
        const obj: RectangleShapeObject | CircleShapeObject =
          shapeKind === "circle" ? { ...base, shapeKind: "circle" } : { ...base, shapeKind: "rectangle" };
        commit([...objects, obj]);
        setActiveObjectId(obj.id);
      }
      setMode("select");
    } else if (mode === "select") {
      setActiveObjectId(null);
    }
  }

  // ---------------------------------------------------------------------
  // 3. 選択・ドラッグ移動（テキスト・チェック・画像・手書き共通）
  // ---------------------------------------------------------------------
  function handleObjectPointerDown(e: React.PointerEvent<HTMLDivElement>, obj: AnnotationObject) {
    if (mode !== "select") return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setActiveObjectId(obj.id);
    dragState.current = {
      id: obj.id,
      startX: e.clientX,
      startY: e.clientY,
      original: obj,
      snapshot: objects,
    };
  }

  function handleObjectPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (!drag) return;
    const dxPdf = (e.clientX - drag.startX) / pageRenderScale;
    const dyPdf = -(e.clientY - drag.startY) / pageRenderScale;
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== drag.id) return o;
        const original = drag.original;
        if (original.type === "ink" && o.type === "ink") {
          return { ...o, points: original.points.map((p) => ({ x: p.x + dxPdf, y: p.y + dyPdf })) };
        }
        if (original.type === "shape" && o.type === "shape" && original.shapeKind === "line" && o.shapeKind === "line") {
          return { ...o, x1: original.x1 + dxPdf, y1: original.y1 + dyPdf, x2: original.x2 + dxPdf, y2: original.y2 + dyPdf };
        }
        if (
          original.type === "shape" &&
          o.type === "shape" &&
          original.shapeKind !== "line" &&
          o.shapeKind !== "line"
        ) {
          return { ...o, x: Math.max(0, original.x + dxPdf), y: Math.max(0, original.y + dyPdf) } as ShapeAnnotationObject;
        }
        if (
          (original.type === "text" || original.type === "checkbox" || original.type === "image") &&
          (o.type === "text" || o.type === "checkbox" || o.type === "image")
        ) {
          return { ...o, x: Math.max(0, original.x + dxPdf), y: Math.max(0, original.y + dyPdf) } as AnnotationObject;
        }
        return o;
      })
    );
  }

  function handleObjectPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    const totalMove = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);

    if (totalMove < 4 && drag.original.type === "checkbox") {
      // 実質的な移動が無かった = クリックとして扱い、チェックのON/OFFを切り替える
      const snapshot = objects;
      const next = objects.map((o) => (o.id === drag.id && o.type === "checkbox" ? { ...o, checked: !o.checked } : o));
      pushHistory(snapshot);
      setObjects(next);
      return;
    }
    if (totalMove >= 4) {
      pushHistory(drag.snapshot);
    }
  }

  function handleObjectInertClick(e: React.MouseEvent) {
    // オブジェクト上のクリックが親要素(キャンバス)まで伝播し、配置モードで
    // 意図しない新規オブジェクトが作られてしまうのを防ぐ
    e.stopPropagation();
  }

  // ---------------------------------------------------------------------
  // 4. 手書き（フリーハンド）
  // ---------------------------------------------------------------------
  function handleWrapperPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (mode !== "ink" || eraseMode || !currentPageInfo) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = screenToPdfX(e.clientX - rect.left, pageRenderScale);
    const y = screenToPdfY(e.clientY - rect.top, 0, currentPageInfo.height, pageRenderScale);
    drawingPreSnapshotRef.current = objects;
    setDrawingPoints([{ x, y }]);
  }

  function handleWrapperPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (mode !== "ink" || eraseMode || !drawingPoints || !currentPageInfo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = screenToPdfX(e.clientX - rect.left, pageRenderScale);
    const y = screenToPdfY(e.clientY - rect.top, 0, currentPageInfo.height, pageRenderScale);
    setDrawingPoints((prev) => {
      if (!prev) return prev;
      const last = prev[prev.length - 1];
      if (last && pointDistance(last, { x, y }) < 1.2) return prev;
      if (prev.length >= PDF_FILL_ANNOTATE_LIMITS.maxInkPointsPerStroke) return prev;
      return [...prev, { x, y }];
    });
  }

  function handleWrapperPointerUp() {
    if (mode !== "ink" || eraseMode) return;
    const points = drawingPoints;
    setDrawingPoints(null);
    if (!points || points.length === 0) return;
    const preSnapshot = drawingPreSnapshotRef.current ?? objects;
    drawingPreSnapshotRef.current = null;
    if (preSnapshot.length >= PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument) {
      setError(`配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument}個までです。`);
      return;
    }
    const obj: InkAnnotationObject = {
      id: createAnnotationId("ink"),
      type: "ink",
      page: selectedPage,
      points,
      color: COLOR_CHOICES[inkColorChoice],
      strokeWidth: inkThickness,
    };
    pushHistory(preSnapshot);
    setObjects([...preSnapshot, obj]);
    setActiveObjectId(obj.id);
  }

  function handleEraseStroke(id: string) {
    commit(objects.filter((o) => o.id !== id));
    if (activeObjectId === id) setActiveObjectId(null);
  }

  function handleClearAllInk() {
    const remaining = objects.filter((o) => o.type !== "ink");
    if (remaining.length === objects.length) return;
    commit(remaining);
  }

  // ---------------------------------------------------------------------
  // 5. 画像
  // ---------------------------------------------------------------------
  async function handleImageStage(files: File[], isStamp: boolean) {
    const f = files[0];
    if (!f) return;
    setError(null);
    if (f.size > PDF_FILL_ANNOTATE_LIMITS.maxImageSizeMB * 1024 * 1024) {
      setError(`画像は${PDF_FILL_ANNOTATE_LIMITS.maxImageSizeMB}MBまでです。`);
      return;
    }
    const mimeType: "image/png" | "image/jpeg" | null =
      f.type === "image/png" ? "image/png" : f.type === "image/jpeg" || f.type === "image/jpg" ? "image/jpeg" : null;
    if (!mimeType) {
      setError("画像はPNGまたはJPEG形式のみ対応しています。");
      return;
    }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const previewUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
        img.src = previewUrl;
      });
      if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
      setPendingImage({ bytes, mimeType, previewUrl, aspectRatio: dims.width / dims.height || 1, isStamp });
      setMode(isStamp ? "stamp" : "image");
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像の読み込みに失敗しました");
    }
  }

  function handleCancelPendingImage() {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
    setMode("select");
  }

  // ---------------------------------------------------------------------
  // 6. 書き出し
  // ---------------------------------------------------------------------
  async function handleExport() {
    if (!file) return;
    setError(null);
    setStatus("processing");
    setResult(null);
    try {
      const output = await new PdfFillAnnotateProcessor().process({ file, objects });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの書き出しに失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result || !file) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-記入済み.pdf`);
  }

  const MODE_LABELS: { value: ToolMode; label: string }[] = [
    { value: "select", label: "選択・移動" },
    { value: "text", label: "テキスト" },
    { value: "checkbox", label: "チェック" },
    { value: "shape", label: "図形" },
    { value: "ink", label: "手書き" },
    { value: "image", label: "画像" },
    { value: "stamp", label: "印影" },
  ];

  function handlePageJumpSubmit() {
    const n = Number(pageJumpValue);
    if (!Number.isInteger(n)) return;
    handlePageChange(n);
    setPageJumpValue("");
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        PDFに文字・チェック・手書き・画像を書き込んで、その場でダウンロードできます。処理はすべてブラウザ内で行われ、
        アップロードしたPDF・入力した内容・生成したPDFはMr.Sattoのサーバーに送信・保存されません。ここでの「保存」は
        「編集後のPDFを端末へダウンロードすること」だけを指し、サーバー側への保存は行っていません。
        手書き入力は署名欄への記入などにご利用いただけますが、法的な効力を持つ電子署名機能ではありません。
      </p>

      {error && <ErrorMessage message={error} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">1. PDFをアップロード</h2>
        <FileDropzone
          accept="application/pdf,.pdf"
          label="PDFをドラッグ&ドロップ"
          hint="またはタップして選択（1ファイル）"
          onFilesSelected={handleFileSelect}
          onError={setError}
        />
        {file && <FileList files={[file]} />}
        {loading && <p className="text-xs text-neutral-500">読み込み中...</p>}
      </section>

      {file && pageImageUrl && currentPageInfo && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">2. 記入・注釈を配置</h2>

          <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-300">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="前のページ"
                onClick={() => handlePageChange(selectedPage - 1)}
                disabled={selectedPage <= 1}
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
              >
                ←
              </button>
              <span>
                {selectedPage} / {pages.length}ページ
              </span>
              <button
                type="button"
                aria-label="次のページ"
                onClick={() => handlePageChange(selectedPage + 1)}
                disabled={selectedPage >= pages.length}
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
              >
                →
              </button>
              {pages.length > 2 && (
                <span className="flex items-center gap-1">
                  <label className="flex items-center gap-1">
                    <span className="sr-only">ページ番号を指定して移動</span>
                    <input
                      type="number"
                      min={1}
                      max={pages.length}
                      value={pageJumpValue}
                      onChange={(e) => setPageJumpValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handlePageJumpSubmit();
                      }}
                      placeholder="ページ番号"
                      className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handlePageJumpSubmit}
                    className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700"
                  >
                    移動
                  </button>
                </span>
              )}
            </div>

            <div className="flex items-center gap-1" role="group" aria-label="表示倍率">
              {ZOOM_LEVELS.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => handleZoomChange(z)}
                  aria-pressed={zoom === z}
                  className={`rounded px-2 py-1 ${
                    zoom === z ? "bg-blue-600 text-white" : "border border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  {z}%
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="元に戻す"
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
              >
                ↶ 元に戻す
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="やり直す"
                className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
              >
                ↷ やり直す
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="編集ツール">
            {MODE_LABELS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => {
                  setMode(m.value);
                  setRepositioningId(null);
                  if (m.value !== "image" && m.value !== "stamp" && pendingImage) {
                    URL.revokeObjectURL(pendingImage.previewUrl);
                    setPendingImage(null);
                  }
                }}
                aria-pressed={mode === m.value}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  mode === m.value
                    ? "bg-blue-600 text-white"
                    : "border border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === "text" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <span className="text-blue-700 dark:text-blue-300">PDF上をクリックしてテキストを配置してください。</span>
              <label className="flex items-center gap-1">
                文字サイズ
                <input
                  type="number"
                  min={6}
                  max={96}
                  value={textFontSize}
                  onChange={(e) => setTextFontSize(Math.min(96, Math.max(6, Number(e.target.value) || 6)))}
                  className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-1">
                色
                <select
                  value={textColorChoice}
                  onChange={(e) => setTextColorChoice(e.target.value as ColorChoice)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => (
                    <option key={c} value={c}>
                      {COLOR_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={textBold} onChange={(e) => setTextBold(e.target.checked)} />
                太字
              </label>
              <label className="flex items-center gap-1">
                整列
                <select
                  value={textAlign}
                  onChange={(e) => setTextAlign(e.target.value as TextAlign)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => (
                    <option key={a} value={a}>
                      {ALIGN_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-neutral-500 dark:text-neutral-400">
                複数行にしたい場合は、配置後の入力欄でShift+Enter（またはEnter）で改行できます。
              </span>
            </div>
          )}

          {mode === "checkbox" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <span className="text-blue-700 dark:text-blue-300">PDF上をクリックしてチェック欄を配置してください。</span>
              <label className="flex items-center gap-1">
                大きさ
                <input
                  type="number"
                  min={8}
                  max={64}
                  value={checkboxSize}
                  onChange={(e) => setCheckboxSize(Math.min(64, Math.max(8, Number(e.target.value) || 8)))}
                  className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-1">
                マーク
                <select
                  value={checkboxMarkStyle}
                  onChange={(e) => setCheckboxMarkStyle(e.target.value as CheckboxMarkStyle)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(MARK_STYLE_LABELS) as CheckboxMarkStyle[]).map((m) => (
                    <option key={m} value={m}>
                      {MARK_STYLE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {mode === "shape" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <span className="text-blue-700 dark:text-blue-300">PDF上をクリックして図形を配置してください。</span>
              <label className="flex items-center gap-1">
                種類
                <select
                  value={shapeKind}
                  onChange={(e) => setShapeKind(e.target.value as ShapeKind)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(SHAPE_KIND_LABELS) as ShapeKind[]).map((k) => (
                    <option key={k} value={k}>
                      {SHAPE_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                色
                <select
                  value={shapeColorChoice}
                  onChange={(e) => setShapeColorChoice(e.target.value as ColorChoice)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => (
                    <option key={c} value={c}>
                      {COLOR_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                線の太さ
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.5}
                  value={shapeStrokeWidth}
                  onChange={(e) => setShapeStrokeWidth(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              {shapeKind !== "line" && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={shapeFill} onChange={(e) => setShapeFill(e.target.checked)} />
                  塗りつぶし
                </label>
              )}
            </div>
          )}

          {mode === "ink" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <span className="text-blue-700 dark:text-blue-300">
                {eraseMode ? "消したい手書きをタップしてください。" : "PDF上をドラッグして手書きできます。"}
              </span>
              <label className="flex items-center gap-1">
                太さ
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.5}
                  value={inkThickness}
                  onChange={(e) => setInkThickness(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-1">
                色
                <select
                  value={inkColorChoice}
                  onChange={(e) => setInkColorChoice(e.target.value as ColorChoice)}
                  className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => (
                    <option key={c} value={c}>
                      {COLOR_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setEraseMode((v) => !v)}
                aria-pressed={eraseMode}
                className={`rounded px-2 py-1 ${
                  eraseMode ? "bg-red-600 text-white" : "border border-neutral-300 dark:border-neutral-700"
                }`}
              >
                消しゴム
              </button>
              <button
                type="button"
                onClick={handleClearAllInk}
                className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-red-400 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-300"
              >
                手書きを全て消去
              </button>
            </div>
          )}

          {mode === "image" && (
            <div className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              {!pendingImage ? (
                <FileDropzone
                  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                  maxSizeMB={PDF_FILL_ANNOTATE_LIMITS.maxImageSizeMB}
                  label="画像をドラッグ&ドロップ"
                  hint="PNG・JPEGに対応（1枚）"
                  onFilesSelected={(files) => void handleImageStage(files, false)}
                  onError={setError}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-blue-700 dark:text-blue-300">PDF上をクリックして画像を配置してください。</span>
                  <button
                    type="button"
                    onClick={handleCancelPendingImage}
                    className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    キャンセル
                  </button>
                </div>
              )}
            </div>
          )}

          {mode === "stamp" && (
            <div className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <span className="text-neutral-500 dark:text-neutral-400">
                「電子印鑑生成」ツールで作った印影PNGなど、印影画像をそのまま配置できます（内部的には画像オブジェクトと同じ扱いです）。
              </span>
              {!pendingImage ? (
                <FileDropzone
                  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                  maxSizeMB={PDF_FILL_ANNOTATE_LIMITS.maxImageSizeMB}
                  label="印影画像をドラッグ&ドロップ"
                  hint="PNG・JPEGに対応（1枚、背景透過PNG推奨）"
                  onFilesSelected={(files) => void handleImageStage(files, true)}
                  onError={setError}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-blue-700 dark:text-blue-300">PDF上をクリックして印影を配置してください。</span>
                  <button
                    type="button"
                    onClick={handleCancelPendingImage}
                    className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    キャンセル
                  </button>
                </div>
              )}
            </div>
          )}

          {repositioningId && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              配置し直したい位置をPDF上でクリックしてください。
            </p>
          )}

          <div ref={canvasWrapRef} data-testid="tool-preview" className="w-full">
            <div
              data-testid="pdf-annotate-canvas"
              className="relative select-none border border-neutral-300 dark:border-neutral-700"
              style={{
                width: pageImagePixelSize.width || "100%",
                cursor: mode === "select" ? "default" : mode === "ink" ? (eraseMode ? "pointer" : "crosshair") : "crosshair",
                touchAction: mode === "ink" ? "none" : "auto",
              }}
              onClick={handleCanvasClick}
              onPointerDown={handleWrapperPointerDown}
              onPointerMove={handleWrapperPointerMove}
              onPointerUp={handleWrapperPointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pageImageUrl} alt={`PDF ${selectedPage}ページ目のプレビュー`} draggable={false} />

              {/* ライブ描画中の手書きプレビュー */}
              {drawingPoints && drawingPoints.length > 1 && (
                <svg
                  className="pointer-events-none absolute left-0 top-0"
                  width={pageImagePixelSize.width}
                  height={pageImagePixelSize.height}
                  aria-hidden="true"
                >
                  <polyline
                    points={drawingPoints
                      .map((p) => `${pdfToScreenX(p.x, pageRenderScale)},${pdfToScreenY(p.y, 0, currentPageInfo.height, pageRenderScale)}`)
                      .join(" ")}
                    fill="none"
                    stroke={cssColor(COLOR_CHOICES[inkColorChoice])}
                    strokeWidth={Math.max(1, inkThickness * pageRenderScale)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}

              {pageObjects.map((obj) => {
                const isActive = activeObjectId === obj.id;
                if (obj.type === "text") {
                  const width = Math.max(20, obj.text.length * obj.fontSize * 0.62) * pageRenderScale;
                  const height = obj.fontSize * 1.3 * pageRenderScale;
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      className={`absolute flex items-center whitespace-nowrap px-0.5 text-left ${
                        isActive ? "outline outline-2 outline-blue-500" : "outline outline-1 outline-dashed outline-neutral-400/60"
                      }`}
                      style={{
                        left: pdfToScreenX(obj.x, pageRenderScale),
                        top: pdfToScreenY(obj.y, obj.fontSize * 0.3, currentPageInfo.height, pageRenderScale) - height * 0.55,
                        minWidth: width,
                        height,
                        fontSize: Math.max(8, obj.fontSize * pageRenderScale),
                        fontWeight: obj.bold ? 700 : 400,
                        color: cssColor(obj.color),
                        cursor: mode === "select" ? "move" : "default",
                        touchAction: "none",
                      }}
                    >
                      {obj.text || "（テキスト未入力）"}
                    </div>
                  );
                }
                if (obj.type === "checkbox") {
                  const size = obj.size * pageRenderScale;
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      className={`absolute flex items-center justify-center border-2 bg-white/60 dark:bg-black/30 ${
                        isActive ? "border-blue-500" : "border-neutral-500"
                      }`}
                      style={{
                        left: pdfToScreenX(obj.x, pageRenderScale),
                        top: pdfToScreenY(obj.y, obj.size, currentPageInfo.height, pageRenderScale),
                        width: size,
                        height: size,
                        cursor: mode === "select" ? "pointer" : "default",
                        touchAction: "none",
                      }}
                    >
                      {obj.checked && <span aria-hidden="true">✓</span>}
                    </div>
                  );
                }
                if (obj.type === "image") {
                  const w = obj.width * pageRenderScale;
                  const h = obj.height * pageRenderScale;
                  const rotation = obj.rotation ?? 0;
                  return (
                    <div
                      key={obj.id}
                      data-testid={obj.isStamp ? "pdf-annotate-stamp-object" : undefined}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      className={`absolute ${isActive ? "outline outline-2 outline-blue-500" : ""}`}
                      style={{
                        left: pdfToScreenX(obj.x, pageRenderScale),
                        top: pdfToScreenY(obj.y, obj.height, currentPageInfo.height, pageRenderScale),
                        width: w,
                        height: h,
                        transform: rotation ? `rotate(${-rotation}deg)` : undefined,
                        cursor: mode === "select" ? "move" : "default",
                        touchAction: "none",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={obj.previewUrl} alt="配置した画像" className="h-full w-full object-contain" draggable={false} />
                    </div>
                  );
                }
                if (obj.type === "ink") {
                  const b = inkBounds(obj);
                  const left = pdfToScreenX(b.minX, pageRenderScale);
                  const top = pdfToScreenY(b.maxY, 0, currentPageInfo.height, pageRenderScale);
                  const width = (b.maxX - b.minX) * pageRenderScale;
                  const height = (b.maxY - b.minY) * pageRenderScale;
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => {
                        if (mode === "ink" && eraseMode) {
                          e.stopPropagation();
                          handleEraseStroke(obj.id);
                          return;
                        }
                        handleObjectPointerDown(e, obj);
                      }}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      className={isActive ? "absolute outline outline-2 outline-blue-500" : "absolute"}
                      style={{
                        left,
                        top,
                        width,
                        height,
                        cursor: mode === "select" ? "move" : eraseMode ? "pointer" : "default",
                        touchAction: "none",
                      }}
                    >
                      <svg width={width} height={height} style={{ overflow: "visible" }} aria-hidden="true">
                        <polyline
                          points={obj.points
                            .map((p) => `${(p.x - b.minX) * pageRenderScale},${(b.maxY - p.y) * pageRenderScale}`)
                            .join(" ")}
                          fill="none"
                          stroke={cssColor(obj.color)}
                          strokeWidth={Math.max(1, obj.strokeWidth * pageRenderScale)}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  );
                }
                // shape（矩形・円/楕円・直線）
                if (obj.shapeKind === "line") {
                  const b = lineBounds(obj);
                  const left = pdfToScreenX(b.minX, pageRenderScale);
                  const top = pdfToScreenY(b.maxY, 0, currentPageInfo.height, pageRenderScale);
                  const width = (b.maxX - b.minX) * pageRenderScale;
                  const height = (b.maxY - b.minY) * pageRenderScale;
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      className={isActive ? "absolute outline outline-2 outline-blue-500" : "absolute"}
                      style={{ left, top, width, height, cursor: mode === "select" ? "move" : "default", touchAction: "none" }}
                    >
                      <svg width={width} height={height} style={{ overflow: "visible" }} aria-hidden="true">
                        <line
                          x1={(obj.x1 - b.minX) * pageRenderScale}
                          y1={(b.maxY - obj.y1) * pageRenderScale}
                          x2={(obj.x2 - b.minX) * pageRenderScale}
                          y2={(b.maxY - obj.y2) * pageRenderScale}
                          stroke={cssColor(obj.color)}
                          strokeWidth={Math.max(1, obj.strokeWidth * pageRenderScale)}
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  );
                }
                const w = obj.width * pageRenderScale;
                const h = obj.height * pageRenderScale;
                return (
                  <div
                    key={obj.id}
                    onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                    onPointerMove={handleObjectPointerMove}
                    onPointerUp={handleObjectPointerUp}
                    onClick={handleObjectInertClick}
                    className={`absolute ${isActive ? "outline outline-2 outline-blue-500" : ""} ${
                      obj.shapeKind === "circle" ? "rounded-full" : ""
                    }`}
                    style={{
                      left: pdfToScreenX(obj.x, pageRenderScale),
                      top: pdfToScreenY(obj.y, obj.height, currentPageInfo.height, pageRenderScale),
                      width: w,
                      height: h,
                      border: `${Math.max(1, obj.strokeWidth * pageRenderScale)}px solid ${cssColor(obj.color)}`,
                      backgroundColor: obj.fill ? cssColor(obj.color) : "transparent",
                      transform: obj.rotation ? `rotate(${-obj.rotation}deg)` : undefined,
                      cursor: mode === "select" ? "move" : "default",
                      touchAction: "none",
                    }}
                  />
                );
              })}
            </div>
          </div>

          {objects.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">配置した注釈（{objects.length}件）</h3>
              <ul className="flex flex-col gap-2" data-testid="pdf-annotate-object-list">
                {objects.map((obj) => (
                  <li
                    key={obj.id}
                    onClick={() => {
                      if (obj.page !== selectedPage) handlePageChange(obj.page);
                      setActiveObjectId(obj.id);
                    }}
                    className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs ${
                      activeObjectId === obj.id ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20" : "border-neutral-200 dark:border-neutral-800"
                    }`}
                  >
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {obj.page}p
                    </span>

                    {obj.type === "text" && (
                      <>
                        <label className="flex items-center gap-1">
                          <span className="sr-only">テキスト内容</span>
                          <textarea
                            rows={obj.text.includes("\n") ? Math.min(5, obj.text.split("\n").length) : 1}
                            value={obj.text}
                            onFocus={() => (textEditStartRef.current = { id: obj.id, text: obj.text })}
                            onChange={(e) =>
                              patchObjectLive(obj.id, { text: e.target.value.slice(0, PDF_FILL_ANNOTATE_LIMITS.maxTextLength) })
                            }
                            onBlur={() => {
                              const start = textEditStartRef.current;
                              textEditStartRef.current = null;
                              if (start && start.id === obj.id) {
                                const latest = objects.find((o) => o.id === obj.id);
                                if (latest && latest.type === "text" && latest.text !== start.text) {
                                  pushHistory(objects.map((o) => (o.id === obj.id ? { ...o, text: start.text } : o)));
                                }
                              }
                            }}
                            placeholder="テキストを入力（Enterで改行）"
                            className="w-40 resize-y rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <DateInsertHelper onInsert={(text) => patchObjectWithHistory(obj.id, { text })} />
                        <label className="flex items-center gap-1">
                          文字サイズ
                          <input
                            type="number"
                            min={6}
                            max={96}
                            value={obj.fontSize}
                            onChange={(e) =>
                              patchObjectWithHistory(obj.id, { fontSize: Math.min(96, Math.max(6, Number(e.target.value) || 6)) })
                            }
                            className="w-14 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={obj.bold}
                            onChange={(e) => patchObjectWithHistory(obj.id, { bold: e.target.checked })}
                          />
                          太字
                        </label>
                        <label className="flex items-center gap-1">
                          整列
                          <select
                            value={obj.align ?? "left"}
                            onChange={(e) => patchObjectWithHistory(obj.id, { align: e.target.value as TextAlign })}
                            className="rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          >
                            {(Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => (
                              <option key={a} value={a}>
                                {ALIGN_LABELS[a]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}

                    {obj.type === "checkbox" && (
                      <>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={obj.checked}
                            onChange={(e) => patchObjectWithHistory(obj.id, { checked: e.target.checked })}
                          />
                          チェック
                        </label>
                        <label className="flex items-center gap-1">
                          大きさ
                          <input
                            type="number"
                            min={8}
                            max={64}
                            value={obj.size}
                            onChange={(e) => patchObjectWithHistory(obj.id, { size: Math.min(64, Math.max(8, Number(e.target.value) || 8)) })}
                            className="w-14 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          マーク
                          <select
                            value={obj.markStyle ?? "check"}
                            onChange={(e) => patchObjectWithHistory(obj.id, { markStyle: e.target.value as CheckboxMarkStyle })}
                            className="rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          >
                            {(Object.keys(MARK_STYLE_LABELS) as CheckboxMarkStyle[]).map((m) => (
                              <option key={m} value={m}>
                                {MARK_STYLE_LABELS[m]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}

                    {obj.type === "ink" && (
                      <>
                        <label className="flex items-center gap-1">
                          太さ
                          <input
                            type="number"
                            min={1}
                            max={20}
                            step={0.5}
                            value={obj.strokeWidth}
                            onChange={(e) =>
                              patchObjectWithHistory(obj.id, { strokeWidth: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })
                            }
                            className="w-14 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <RotateButtons onRotate={(delta) => rotateObject(obj.id, delta)} />
                      </>
                    )}

                    {obj.type === "image" && (
                      <>
                        <label className="flex items-center gap-1">
                          幅
                          <input
                            type="number"
                            min={10}
                            max={2000}
                            value={Math.round(obj.width)}
                            onChange={(e) => {
                              const width = Math.min(2000, Math.max(10, Number(e.target.value) || 10));
                              const aspectLocked = obj.aspectLocked !== false;
                              patchObjectWithHistory(obj.id, {
                                width,
                                height: aspectLocked ? width / obj.aspectRatio : obj.height,
                              });
                            }}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          高さ
                          <input
                            type="number"
                            min={10}
                            max={2000}
                            disabled={obj.aspectLocked !== false}
                            value={Math.round(obj.height)}
                            onChange={(e) => {
                              const height = Math.min(2000, Math.max(10, Number(e.target.value) || 10));
                              patchObjectWithHistory(obj.id, { height });
                            }}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={obj.aspectLocked !== false}
                            onChange={(e) => patchObjectWithHistory(obj.id, { aspectLocked: e.target.checked })}
                          />
                          縦横比を固定
                        </label>
                        <label className="flex items-center gap-1">
                          回転
                          <input
                            type="number"
                            min={0}
                            max={359}
                            value={Math.round(obj.rotation ?? 0)}
                            onChange={(e) => patchObjectWithHistory(obj.id, { rotation: normalizeRotation(Number(e.target.value) || 0) })}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                          °
                        </label>
                        <RotateButtons onRotate={(delta) => rotateObject(obj.id, delta)} />
                      </>
                    )}

                    {obj.type === "shape" && obj.shapeKind !== "line" && (
                      <>
                        <label className="flex items-center gap-1">
                          幅
                          <input
                            type="number"
                            min={5}
                            max={2000}
                            value={Math.round(obj.width)}
                            onChange={(e) => patchObjectWithHistory(obj.id, { width: Math.min(2000, Math.max(5, Number(e.target.value) || 5)) })}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          高さ
                          <input
                            type="number"
                            min={5}
                            max={2000}
                            value={Math.round(obj.height)}
                            onChange={(e) => patchObjectWithHistory(obj.id, { height: Math.min(2000, Math.max(5, Number(e.target.value) || 5)) })}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={obj.fill} onChange={(e) => patchObjectWithHistory(obj.id, { fill: e.target.checked })} />
                          塗りつぶし
                        </label>
                        <label className="flex items-center gap-1">
                          回転
                          <input
                            type="number"
                            min={0}
                            max={359}
                            value={Math.round(obj.rotation)}
                            onChange={(e) => patchObjectWithHistory(obj.id, { rotation: normalizeRotation(Number(e.target.value) || 0) })}
                            className="w-16 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                          °
                        </label>
                        <RotateButtons onRotate={(delta) => rotateObject(obj.id, delta)} />
                      </>
                    )}

                    {obj.type === "shape" && obj.shapeKind === "line" && (
                      <RotateButtons onRotate={(delta) => rotateObject(obj.id, delta)} />
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (obj.page !== selectedPage) handlePageChange(obj.page);
                        setRepositioningId(obj.id);
                        setActiveObjectId(obj.id);
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      移動
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicateObject(obj.id);
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      複製
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        reorderObject(obj.id, "front");
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      最前面へ
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        reorderObject(obj.id, "back");
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      最背面へ
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeObject(obj.id);
                      }}
                      className="rounded border border-red-300 px-2 py-1 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {file && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">3. PDFを書き出してダウンロード</h2>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            PDFを書き出す
          </button>

          <ProcessingStatus state={status} successLabel="書き出しが完了しました" />

          {result && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {result.pageCount}ページのPDFを生成しました。生成したPDFはMr.Sattoのサーバーへ保存されません。
              </p>
              <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** 日付のテキストへの挿入補助（現在日付を自動入力せず、ユーザーが選んだ日付だけを反映する） */
/**
 * 回転操作の共通ボタン（時計回り/反時計回りに15度）。Phase 17で追加した各オブジェクトの
 * 回転UIから共通で使う。
 *
 * 注意: オブジェクトのrotationフィールドはPDF-native座標系（反時計回りが正）の角度で
 * 保持しており、画面上はtransform: rotate(-rotation deg)で表示している（geometry.tsの
 * コメント参照）。そのため「画面上で時計回りに回す」操作はrotationフィールドを
 * 減算、「反時計回りに回す」操作は加算に対応する。
 */
function RotateButtons({ onRotate }: { onRotate: (deltaDeg: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRotate(ROTATE_STEP_DEG);
        }}
        aria-label="反時計回りに回転"
        className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        ↺
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRotate(-ROTATE_STEP_DEG);
        }}
        aria-label="時計回りに回転"
        className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        ↻
      </button>
    </span>
  );
}

function DateInsertHelper({ onInsert }: { onInsert: (text: string) => void }) {
  const [dateValue, setDateValue] = useState("");
  const [style, setStyle] = useState<"slash" | "kanji">("slash");

  return (
    <span className="flex items-center gap-1">
      <label className="flex items-center gap-1">
        <span className="sr-only">日付を選択して挿入</span>
        <input
          type="date"
          value={dateValue}
          onChange={(e) => setDateValue(e.target.value)}
          className="rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="sr-only">日付の表示形式</span>
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value as "slash" | "kanji")}
          className="rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="slash">2026/09/27</option>
          <option value="kanji">2026年9月27日</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          if (!dateValue) return;
          const formatted = formatDate(dateValue, style);
          if (formatted) onInsert(formatted);
        }}
        disabled={!dateValue}
        className="rounded border border-neutral-300 px-2 py-1 text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
      >
        日付を挿入
      </button>
    </span>
  );
}
