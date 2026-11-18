"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { withPdfDocument, type PdfDocument } from "@/lib/pdf/pdfjs-client";
import { PdfFillAnnotateProcessor } from "@/lib/processors/browser/pdf-fill-annotate";
import { analyzePageText, eraseSentences, loadTextGuides, type PageTextAnalysis } from "@/lib/processors/browser/pdf-text-erase";
import { sentenceAt } from "@/lib/pdf-text-edit/sentences";
import { nearestGuide, type TextGuides } from "@/lib/pdf-text-edit/guides";
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
import { clampMoveDelta, rotatePointAround } from "@/lib/pdf-annotate/geometry";
import {
  convertTextYForWritingMode,
  ensurePdfTextFont,
  layoutTextBox,
  layoutVerticalText,
  measureCharPt,
  PDF_TEXT_FONT_FAMILY,
  textBoundsPdf,
} from "@/lib/pdf-annotate/text-layout";
import { saveBlob, stripExtension } from "@/lib/utils/format";
import { runWithDownloadAccess } from "@/lib/download/download-gate";
import { useUnsavedChangesWarning } from "./shared/use-unsaved-changes-warning";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import {
  WHITEOUT_COLOR,
  WHITEOUT_DEFAULT_HEIGHT,
  WHITEOUT_DEFAULT_WIDTH,
  WHITEOUT_NOTICE,
  isWhiteoutObject,
  whiteoutInsertIndex,
  BLACKOUT_COLOR,
  BLACKOUT_DEFAULT_HEIGHT,
  BLACKOUT_DEFAULT_WIDTH,
  BLACKOUT_NOTICE,
  TRUE_REDACTION_TOOL_NAME,
  TRUE_REDACTION_TOOL_PATH,
  isBlackoutObject,
} from "@/lib/pdf-annotate/whiteout";
import Link from "next/link";
import { SliderField } from "@/components/common/slider-field";
import { ZoomSlider } from "@/components/common/zoom-slider";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { StepHeading } from "@/components/ui/step-heading";

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

export type ToolMode = "select" | "text" | "checkbox" | "ink" | "image" | "stamp" | "shape" | "whiteout" | "blackout" | "erase-text";
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
/** 全画面で編集するときの、100%表示でのページの幅の上限（画面いっぱいに広げすぎて、細かい調整がしにくくならないように） */
const FULLSCREEN_PREVIEW_MAX_WIDTH = 1100;
/** キャンバス枠をまだ計測できない最初の描画で使う幅。PC幅(lg以上)では右カラム(最大560px)に収まる幅にする */
function fallbackPreviewWidth(): number {
  if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches && !window.matchMedia("(min-width: 1280px)").matches) return 540;
  // スマホ幅: 画面の幅に収まるようにする(左右の余白ぶんを引く)。計測できる前でも横にはみ出さないため
  if (typeof window !== "undefined") return Math.max(240, Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - 56));
  return PREVIEW_MAX_WIDTH;
}
// Phase 17: 座標変換の検証対象倍率(100/125/150/200%)を含む形へ拡張
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const;
const ROTATE_STEP_DEG = 15;
const MARK_STYLE_LABELS: Record<CheckboxMarkStyle, string> = { check: "レ点", cross: "×", circle: "○" };
/** 画面に表示するチェックのマーク（書き出しのPDFでは、文字ではなく線・円で描く） */
const MARK_STYLE_GLYPHS: Record<CheckboxMarkStyle, string> = { check: "✓", cross: "×", circle: "○" };
/** つまみで大きさを変えるときの最小の大きさ(pt) */
const MIN_RESIZE_PT = 6;
const ALIGN_LABELS: Record<TextAlign, string> = { left: "左揃え", center: "中央揃え", right: "右揃え" };
const SHAPE_KIND_LABELS: Record<ShapeKind, string> = { rectangle: "矩形", circle: "円・楕円", line: "直線" };

const COLOR_CHOICES: Record<ColorChoice, AnnotationColor> = {
  black: { r: 0.1, g: 0.1, b: 0.12 },
  red: { r: 0.82, g: 0.15, b: 0.15 },
  blue: { r: 0.1, g: 0.35, b: 0.85 },
};
const COLOR_LABELS: Record<ColorChoice, string> = { black: "黒", red: "赤", blue: "青" };
/** 置いた注釈の色が、黒・赤・青のどれか（どれでもなければ null） */
function colorChoiceOf(c: AnnotationColor): ColorChoice | null {
  const hit = (Object.keys(COLOR_CHOICES) as ColorChoice[]).find((k) => {
    const v = COLOR_CHOICES[k];
    return Math.abs(v.r - c.r) < 0.02 && Math.abs(v.g - c.g) < 0.02 && Math.abs(v.b - c.b) < 0.02;
  });
  return hit ?? null;
}
/** 色のボタンに出す丸の色 */
const COLOR_SWATCH: Record<ColorChoice, string> = { black: "#111827", red: "#dc2626", blue: "#2563eb" };

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
/**
 * 移動のときに、オブジェクトがページの外へ出ないようにするための範囲（PDFの座標、回転前の見た目の大きさ）。
 * テキストの幅は、画面の表示と同じ見積もり（文字数×文字サイズ）を使う
 */
function objectBoundsForClamp(obj: AnnotationObject): { minX: number; maxX: number; minY: number; maxY: number } {
  if (obj.type === "ink") return inkBounds(obj);
  if (obj.type === "shape" && obj.shapeKind === "line") return lineBounds(obj);
  // 文字は、画面の表示・書き出しと同じ計算の箱を使う（縦書きにも対応。2026-11-17）
  if (obj.type === "text") return textBoundsPdf(obj);
  if (obj.type === "checkbox") return { minX: obj.x, maxX: obj.x + obj.size, minY: obj.y, maxY: obj.y + obj.size };
  return { minX: obj.x, maxX: obj.x + obj.width, minY: obj.y, maxY: obj.y + obj.height };
}

/** 回した矩形・画像の、ページの上での外側の箱（PDFの座標） */
function rotatedRectBounds(x: number, y: number, w: number, h: number, rotation: number) {
  if (!rotation || rotation % 360 === 0) return { minX: x, maxX: x + w, minY: y, maxY: y + h };
  const center = { x: x + w / 2, y: y + h / 2 };
  const corners = [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ].map((p) => rotatePointAround(p, center, rotation));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

/** 揃える操作で使う、注釈の見た目の箱（PDFの座標。回したものは、回したあとの外側の箱） */
function objectBoundsForAlign(obj: AnnotationObject): { minX: number; maxX: number; minY: number; maxY: number } {
  if (obj.type === "image") return rotatedRectBounds(obj.x, obj.y, obj.width, obj.height, obj.rotation ?? 0);
  if (obj.type === "shape" && obj.shapeKind !== "line") return rotatedRectBounds(obj.x, obj.y, obj.width, obj.height, obj.rotation);
  return objectBoundsForClamp(obj);
}

type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
const ALIGN_ACTIONS: { kind: AlignKind; label: string; icon: string }[] = [
  { kind: "left", label: "左を揃える", icon: "⇤" },
  { kind: "hcenter", label: "左右の中央を揃える", icon: "↔" },
  { kind: "right", label: "右を揃える", icon: "⇥" },
  { kind: "top", label: "上を揃える", icon: "⤒" },
  { kind: "vcenter", label: "上下の中央（高さ）を揃える", icon: "↕" },
  { kind: "bottom", label: "下を揃える", icon: "⤓" },
];

/** 一覧の見出しに出す、注釈の種類と中身の短い説明 */
function objectSummary(obj: AnnotationObject): { kind: string; detail: string } {
  if (obj.type === "text") {
    const t = obj.text.replace(/\s+/g, " ").trim();
    return { kind: obj.vertical ? "テキスト（縦書き）" : "テキスト", detail: t ? (t.length > 24 ? `${t.slice(0, 24)}…` : t) : "（未入力）" };
  }
  if (obj.type === "checkbox") return { kind: "チェック", detail: obj.checked ? MARK_STYLE_LABELS[obj.markStyle ?? "check"] : "（印なし）" };
  if (obj.type === "ink") return { kind: "手書き", detail: `${obj.points.length}点` };
  if (obj.type === "image") return { kind: obj.isStamp ? "印影" : "画像", detail: `${Math.round(obj.width)}×${Math.round(obj.height)}pt` };
  if (obj.shapeKind === "line") return { kind: "直線", detail: "" };
  return { kind: obj.shapeKind === "circle" ? "円" : "四角形", detail: `${Math.round(obj.width)}×${Math.round(obj.height)}pt` };
}

/** 注釈をずらす（矢印キーでの微調整用。PDFの座標で dx・dy） */
function moveObjectBy(o: AnnotationObject, dx: number, dy: number): AnnotationObject {
  if (o.type === "ink") return { ...o, points: o.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  if (o.type === "shape" && o.shapeKind === "line") return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
  if (o.type === "shape") return { ...o, x: o.x + dx, y: o.y + dy } as AnnotationObject;
  return { ...o, x: o.x + dx, y: o.y + dy } as AnnotationObject;
}

function normalizeRotation(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

export function PdfFillAnnotateTool({
  initialFile = null,
  onFileChange,
  onDirtyChange,
  controlledMode,
  onModeChange,
  inactive,
  operationSlot,
  previewToolbar,
  onOpenRedaction,
}: SharedPdfFileProps & {
  /** 配置済みの注釈・文字・図形などが1つでもあるかが変わったときに呼ばれる（総合画面が、機能の切り替え前に確認を出すため） */
  onDirtyChange?: (hasEdits: boolean) => void;
  /**
   * 新工程1：操作（テキスト・チェック・図形など）を、外側（PDF修正の「やりたい操作」のプルダウン）から決める。
   * 指定したときは、この画面の中の操作ボタンの列は出さない（操作の選び方を1か所にまとめる）
   */
  controlledMode?: ToolMode;
  /** 画面の中で操作が変わったとき（置いたあとに「選択・移動」へ戻るときなど）に呼ばれる */
  onModeChange?: (mode: ToolMode) => void;
  /** 新工程1：この画面を隠しているあいだ（PDF修正でページ番号・透かしを選んでいるとき）は true。ページ全体へのドロップの受け取り先にしない */
  inactive?: boolean;
  /**
   * PDF修正の「やりたい操作」。PDFを表示しているときは設定の列（「記入・注釈を配置」の見出しのすぐ下）に、
   * まだ表示していないときは画面の一番上に出す（どちらか1か所だけ。プレビューの上には重ねない）
   */
  operationSlot?: React.ReactNode;
  /**
   * PDF修正の「やりたい操作」のボタンの帯。プレビューの列の一番上に置き、PCではプレビューと一緒に画面に固定、
   * スマホでは画面の上（ヘッダーの下）に固定する。編集の途中でも、上まで戻らずに操作を切り替えられる
   */
  previewToolbar?: React.ReactNode;
  /** PDF修正の中で使うとき：墨消し（元の文字ごと消す）へ切り替える。無いときは墨消しのページへのリンクを出す */
  onOpenRedaction?: () => void;
} = {}) {
  const [file, setFile] = useState<File | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selectedPage, setSelectedPage] = useState(1);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageImagePixelSize, setPageImagePixelSize] = useState({ width: 0, height: 0 });
  const [pageRenderScale, setPageRenderScale] = useState(1);
  const [zoom, setZoom] = useState<number>(100);
  // プレビューを全画面にして編集する（2026-11-18）。プレビューの列を画面いっぱいに広げるだけなので、置いたものや操作はそのまま
  const [fullscreen, setFullscreen] = useState(false);
  // 全画面のときに、左側へ設定の欄を引き出す（2026-11-18）
  const [fullscreenSettingsOpen, setFullscreenSettingsOpen] = useState(false);
  const fullscreenRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const [objects, setObjects] = useState<AnnotationObject[]>([]);
  // 文字を消す（文単位。2026-11-18）：消す前のPDFを順に積む（「1つ前に戻す」で戻せるように）
  const [eraseStack, setEraseStack] = useState<ArrayBuffer[]>([]);
  // 書き出したとき・保存したときのPDF（文字を消したあとに保存したかを見分ける）
  const exportedBytesRef = useRef<ArrayBuffer | null>(null);
  const [savedPdfBytes, setSavedPdfBytes] = useState<ArrayBuffer | null>(null);
  const [textAnalysis, setTextAnalysis] = useState<{ page: number; bytes: ArrayBuffer; analysis: PageTextAnalysis } | null>(null);
  const [textAnalysisLoading, setTextAnalysisLoading] = useState(false);
  const [hoverSentenceId, setHoverSentenceId] = useState<number | null>(null);
  const [selectedSentenceIds, setSelectedSentenceIds] = useState<number[]>([]);
  const [erasing, setErasing] = useState(false);
  const [eraseMessage, setEraseMessage] = useState<string | null>(null);
  // もともと書かれている文字の、書き始めの位置・基準線の高さ（位置合わせの目印。2026-11-18）
  const [textGuides, setTextGuides] = useState<{ page: number; bytes: ArrayBuffer; guides: TextGuides } | null>(null);
  const [activeGuide, setActiveGuide] = useState<{ x: number | null; y: number | null } | null>(null);
  // 編集中のデータ（配置済みのオブジェクト・消した文字）の有無を、総合画面へ知らせる。画面が外れるときは「なし」に戻す
  const hasEdits = objects.length > 0 || eraseStack.length > 0;
  // 「保存した」時点の編集内容（ダウンロードの保存処理が実際に実行された時点の objects）。
  // objects は編集のたびに新しい配列へ置き換わり、既存の配列は書き換えない。そのため
  // 「いまの objects が保存した配列そのものか」で、保存後に編集が加わったかを判定できる
  // （元に戻す操作で保存時点の配列に戻れば、保存済みの状態に戻る）。
  const [savedObjects, setSavedObjects] = useState<AnnotationObject[] | null>(null);
  // 直近に書き出し（PDF生成）が成功した時点の objects。画面に出ている生成結果は、この編集内容から作られている
  const exportedObjectsRef = useRef<AnnotationObject[] | null>(null);
  // 保存していない編集があるあいだだけ、ブラウザを閉じる・再読み込みする直前に確認を出す
  const hasUnsavedEdits = (objects.length > 0 && objects !== savedObjects) || (eraseStack.length > 0 && pdfBytes !== savedPdfBytes);
  useUnsavedChangesWarning(hasUnsavedEdits);
  // 配置済みの編集があるときに別のPDFが選ばれた場合の、確認待ちのファイル（確認するまで、読み込み・編集の消去はしない）
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  useEffect(() => {
    onDirtyChange?.(hasEdits);
    // 編集がなくなったら、残っていた確認待ちも捨てる（あとで編集を始めたときに、古い確認が突然出ないように）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!hasEdits) setPendingFiles(null);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEdits]);
  const pastRef = useRef<AnnotationObject[][]>([]);
  const futureRef = useRef<AnnotationObject[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [modeState, setModeState] = useState<ToolMode>(controlledMode ?? "select");
  const isControlled = controlledMode !== undefined;
  const mode: ToolMode = controlledMode ?? modeState;
  /** 画面の中から操作を変えたときに、外側へ伝えた値（外側から変わったのかを見分けるため） */
  const lastInternalModeRef = useRef<ToolMode | null>(null);
  function setMode(next: ToolMode) {
    if (isControlled) {
      lastInternalModeRef.current = next;
      onModeChange?.(next);
    } else {
      setModeState(next);
    }
  }
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  const [repositioningId, setRepositioningId] = useState<string | null>(null);

  // 白消しを動かしている・大きさを変えている間だけ、半透明にして下の文字を透かす（縁が文字にかかっているか見やすくする。2026-11-18）
  const [adjustingWhiteoutId, setAdjustingWhiteoutId] = useState<string | null>(null);
  const dragState = useRef<{
    id: string;
    startX: number;
    startY: number;
    original: AnnotationObject;
    snapshot: AnnotationObject[];
    /** 押す前から選ばれていたか（選ばれている文字をもう一度押すと、その場で文字を編集する） */
    wasActive?: boolean;
  } | null>(null);
  const textEditStartRef = useRef<{ id: string; text: string } | null>(null);
  /** プレビューの上で、その場で文字を入力・編集している文字の注釈 */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /** 書き出しと同じフォント（Noto Sans JP）を、画面の表示用に読み込んだか */
  const [, setPdfFontReady] = useState(false);

  // --- テキスト配置の既定値 ---
  const [textFontSize, setTextFontSize] = useState(14);
  const [textColorChoice, setTextColorChoice] = useState<ColorChoice>("black");
  const [textBold, setTextBold] = useState(false);
  const [textAlign, setTextAlign] = useState<TextAlign>("left");
  // 縦書きで置くか（2026-11-17）
  const [textVertical, setTextVertical] = useState(false);
  // 揃えるために、いっしょに選んでいる注釈（activeObjectId 以外。2026-11-17）
  const [extraSelectedIds, setExtraSelectedIds] = useState<string[]>([]);
  const suppressCanvasClickRef = useRef(false);
  // スマホ向け：押した注釈を、選んでいるものに足していく（Shift／⌘を押しながら押すのと同じ）
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  // 「配置した注釈」の一覧で、開いている注釈（選んだ注釈だけを開き、ほかは見出しだけにする）
  const [openListIds, setOpenListIds] = useState<string[]>([]);

  // --- チェック配置の既定値 ---
  const [checkboxSize, setCheckboxSize] = useState(16);
  const [checkboxMarkStyle, setCheckboxMarkStyle] = useState<CheckboxMarkStyle>("check");
  /** 工程4：枠を付けるか（オフのときはマークだけを、チェックした状態で置く） */
  const [checkboxFrame, setCheckboxFrame] = useState(true);
  /** 工程4：つまみをドラッグして大きさを変えている最中の状態 */
  const resizeState = useRef<{
    id: string;
    startX: number;
    startY: number;
    original: AnnotationObject;
    snapshot: AnnotationObject[];
  } | null>(null);

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
  // 外側（プルダウン）から操作が変わったときも、操作ボタンを押したときと同じ後片付けをする
  useEffect(() => {
    if (!isControlled) return;
    if (lastInternalModeRef.current === controlledMode) return;
    lastInternalModeRef.current = controlledMode ?? null;
    setRepositioningId(null);
    if (controlledMode !== "image" && controlledMode !== "stamp" && pendingImage) {
      URL.revokeObjectURL(pendingImage.previewUrl);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingImage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledMode]);

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

  // Deleteキーで選択中のオブジェクトを削除する。矢印キーで少しずつ動かす（1pt。Shiftを押しながらなら10pt）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!activeObjectId) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeObject(activeObjectId);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const delta = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, step] : e.key === "ArrowDown" ? [0, -step] : null;
      if (!delta) return;
      const obj = objects.find((o) => o.id === activeObjectId);
      if (!obj) return;
      e.preventDefault();
      const page = currentPageInfo ?? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
      const { dx, dy } = clampMoveDelta(objectBoundsForClamp(obj), delta[0], delta[1], page);
      if (dx === 0 && dy === 0) return;
      commit(objects.map((o) => (o.id === obj.id ? moveObjectBy(o, dx, dy) : o)));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeObjectId, objects]);

  // 文字の注釈があるときは、書き出しと同じフォントを画面の表示用に読み込む（画面とPDFで、文字の幅・位置を同じにするため）
  const hasTextObject = objects.some((o) => o.type === "text");
  useEffect(() => {
    if (!hasTextObject) return;
    let alive = true;
    void ensurePdfTextFont().then((ok) => {
      if (alive && ok) setPdfFontReady(true);
    });
    return () => {
      alive = false;
    };
  }, [hasTextObject]);

  // 選んだ注釈を、一覧で開く（ほかは閉じて見出しだけにする）。何も選んでいないときは、いっしょに選んでいるものも外す
  // （React の「表示中に前の値と比べて state を直す」書き方。effect で直すと、表示が2回走るため）
  const [listSyncedActiveId, setListSyncedActiveId] = useState<string | null>(null);
  if (listSyncedActiveId !== activeObjectId) {
    setListSyncedActiveId(activeObjectId);
    setOpenListIds(activeObjectId ? [activeObjectId] : []);
    // 全画面のときは、置いた・選んだ注釈の設定を、左の「詳細設定」に出す（2026-11-18）
    if (activeObjectId && fullscreen) setFullscreenSettingsOpen(true);
    if (!activeObjectId) {
      setExtraSelectedIds([]);
      setMultiSelectMode(false);
    }
  }

  /**
   * その場の文字の編集を終える。空のままの欄も残す（下の一覧の入力欄で続きを入力できるように。空の欄はPDFには書き出さない）
   */
  function finishTextEditing(id: string) {
    setEditingTextId((cur) => (cur === id ? null : cur));
    const obj = objects.find((o) => o.id === id);
    const start = textEditStartRef.current;
    textEditStartRef.current = null;
    if (start && start.id === id && obj && obj.type === "text" && obj.text !== start.text) {
      pushHistory(objects.map((o) => (o.id === id ? { ...o, text: start.text } : o)));
    }
  }

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

  /** 選んでいる2つ以上の注釈を、上・下・左・右・中央で揃える（PowerPoint と同じく、選んだもの全体の端・中央に合わせる） */
  function alignSelected(kind: AlignKind) {
    const ids = new Set([activeObjectId, ...extraSelectedIds].filter((v): v is string => !!v));
    const targets = objects.filter((o) => ids.has(o.id) && o.page === selectedPage);
    if (targets.length < 2) return;
    const bounds = new Map(targets.map((o) => [o.id, objectBoundsForAlign(o)]));
    const all = [...bounds.values()];
    const g = {
      minX: Math.min(...all.map((b) => b.minX)),
      maxX: Math.max(...all.map((b) => b.maxX)),
      minY: Math.min(...all.map((b) => b.minY)),
      maxY: Math.max(...all.map((b) => b.maxY)),
    };
    const next = objects.map((o) => {
      const b = bounds.get(o.id);
      if (!b) return o;
      let dx = 0;
      let dy = 0;
      if (kind === "left") dx = g.minX - b.minX;
      else if (kind === "right") dx = g.maxX - b.maxX;
      else if (kind === "hcenter") dx = (g.minX + g.maxX) / 2 - (b.minX + b.maxX) / 2;
      else if (kind === "top") dy = g.maxY - b.maxY;
      else if (kind === "bottom") dy = g.minY - b.minY;
      else dy = (g.minY + g.maxY) / 2 - (b.minY + b.maxY) / 2;
      return Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001 ? o : moveObjectBy(o, dx, dy);
    });
    commit(next);
  }

  /** 文字の横書き⇔縦書きを切り替える（文字の箱の左上は動かさない） */
  function toggleTextVertical(obj: TextAnnotationObject) {
    const toVertical = !obj.vertical;
    patchObjectWithHistory(obj.id, { vertical: toVertical, y: convertTextYForWritingMode(obj, toVertical) });
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
  // 利用者がPDFを選んだとき。配置済みの編集があれば、読み込む（＝編集が消える）前に確認する。なければそのまま読み込む
  function requestFileSelect(files: File[]) {
    if (!files[0]) return;
    if (hasEdits) {
      setPendingFiles(files);
      return;
    }
    setPendingFiles(null);
    void handleFileSelect(files);
  }

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
    setSavedObjects(null);
    exportedObjectsRef.current = null;
    setEraseStack([]);
    exportedBytesRef.current = null;
    setSavedPdfBytes(null);
    setTextAnalysis(null);
    setSelectedSentenceIds([]);
    setHoverSentenceId(null);
    setEraseMessage(null);
    pastRef.current = [];
    futureRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setActiveObjectId(null);
    setRepositioningId(null);
    // 外側（プルダウン）で操作を選んでいるときは、PDFを読み込んでも、選んだ操作のままにする
    if (!isControlled) setMode("select");

    setFile(f);
    onFileChange?.(f);
    setPageImageUrl(null);

    try {
      const bytes = await f.arrayBuffer();
      setPdfBytes(bytes);
      // 読み終わったら必ず閉じる（作業用スレッドを残さない。ロードマップC 工程2）
      await withPdfDocument(new File([bytes], f.name, { type: "application/pdf" }), async (pdf) => {
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
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
      setFile(null);
      onFileChange?.(null);
      setPdfBytes(null);
      setPages([]);
    } finally {
      setLoading(false);
    }
  }

  // PDF修正の画面で機能を切り替える前に選んでいたPDFがあれば、ファイル選択と同じ読み込み処理で最初に1回だけ開く。
  // （StrictModeの開発時の二重実行でも、引き継いだPDFを二重に読み込まないよう ref で守る）
  const initialFileLoadedRef = useRef(false);
  useEffect(() => {
    if (initialFileLoadedRef.current || !initialFile) return;
    initialFileLoadedRef.current = true;
    void handleFileSelect([initialFile]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function renderPagePreview(
    pdf: PdfDocument,
    pageNumber: number,
    pageInfo: PageInfo,
    zoomPercent: number
  ) {
    const page = await pdf.getPage(pageNumber);
    const containerWidth = canvasWrapRef.current?.clientWidth || fallbackPreviewWidth();
    const baseWidth = Math.min(containerWidth, fullscreenRef.current ? FULLSCREEN_PREVIEW_MAX_WIDTH : PREVIEW_MAX_WIDTH);
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
    await withPdfDocument(new File([pdfBytes.slice(0)], file.name, { type: "application/pdf" }), (pdf) =>
      renderPagePreview(pdf, pageNumber, pageInfo, zoomPercent)
    );
  }

  function handlePageChange(pageNumber: number) {
    if (pageNumber < 1 || pageNumber > pages.length) return;
    setSelectedPage(pageNumber);
    setActiveObjectId(null);
    setExtraSelectedIds([]);
    setRepositioningId(null);
    void reloadPreview(pageNumber, zoom);
  }

  function handleZoomChange(z: number) {
    setZoom(z);
    void reloadPreview(selectedPage, z);
  }

  // ---------------------------------------------------------------------
  // 文字を消す（文単位。2026-11-18）
  // ---------------------------------------------------------------------
  // 「文字を消す」を選んでいる間は、表示中のページの文字を読み、文に分ける（PDFやページが変わったら読み直す）
  useEffect(() => {
    if (mode !== "erase-text" || !pdfBytes || !currentPageInfo) return;
    if (textAnalysis && textAnalysis.page === selectedPage && textAnalysis.bytes === pdfBytes) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTextAnalysisLoading(true);
    setSelectedSentenceIds([]);
    setHoverSentenceId(null);
    const bytes = pdfBytes;
    const page = selectedPage;
    analyzePageText(bytes, page)
      .then((analysis) => {
        if (!cancelled) setTextAnalysis({ page, bytes, analysis });
      })
      .catch(() => {
        if (!cancelled) setTextAnalysis({ page, bytes, analysis: { sentences: [], hasText: false, erasable: false } });
      })
      .finally(() => {
        if (!cancelled) setTextAnalysisLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pdfBytes, selectedPage, pages.length]);

  const pageSentences = textAnalysis && textAnalysis.page === selectedPage && textAnalysis.bytes === pdfBytes ? textAnalysis.analysis.sentences : [];

  // 位置合わせの目印：文字を書き込む・選んで動かす操作のときに、表示中のページの文字から作る
  useEffect(() => {
    if ((mode !== "text" && mode !== "select") || !pdfBytes || !currentPageInfo) return;
    if (textGuides && textGuides.page === selectedPage && textGuides.bytes === pdfBytes) return;
    let cancelled = false;
    const bytes = pdfBytes;
    const page = selectedPage;
    loadTextGuides(bytes, page)
      .then((guides) => {
        if (!cancelled) setTextGuides({ page, bytes, guides });
      })
      .catch(() => {
        if (!cancelled) setTextGuides({ page, bytes, guides: { xs: [], ys: [] } });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pdfBytes, selectedPage, pages.length]);

  const pageGuides = textGuides && textGuides.page === selectedPage && textGuides.bytes === pdfBytes ? textGuides.guides : null;
  /** 目印に吸い付く距離（画面で6px） */
  const guideThreshold = 6 / Math.max(0.01, pageRenderScale);

  /** 文字の左端・基準線を、近くの目印に合わせる（目印がなければ、そのまま） */
  function snapToGuides(x: number, y: number): { x: number; y: number; guide: { x: number | null; y: number | null } | null } {
    if (!pageGuides) return { x, y, guide: null };
    const gx = nearestGuide(x, pageGuides.xs, guideThreshold);
    const gy = nearestGuide(y, pageGuides.ys, guideThreshold);
    return { x: gx ?? x, y: gy ?? y, guide: gx === null && gy === null ? null : { x: gx, y: gy } };
  }

  function sentenceAtScreen(e: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) {
    if (!currentPageInfo) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = screenToPdfX(e.clientX - rect.left, pageRenderScale);
    const y = screenToPdfY(e.clientY - rect.top, 0, currentPageInfo.height, pageRenderScale);
    return sentenceAt(pageSentences, x, y);
  }

  /** 新しいPDFのバイトに差し替える（文字を消した・戻したとき）。置いたもの・表示中のページはそのまま */
  async function applyPdfBytes(next: ArrayBuffer) {
    if (!file) return;
    const nextFile = new File([next], file.name, { type: "application/pdf" });
    setPdfBytes(next);
    setFile(nextFile);
    onFileChange?.(nextFile);
    // 前に書き出した結果は、消す前のPDFから作ったものなので、片付ける
    setResult(null);
    setStatus("idle");
    const pageInfo = pages.find((p) => p.pageNumber === selectedPage);
    if (pageInfo) {
      await withPdfDocument(new File([next.slice(0)], file.name, { type: "application/pdf" }), (pdf) =>
        renderPagePreview(pdf, selectedPage, pageInfo, zoom)
      );
    }
  }

  async function handleEraseSelected() {
    if (!pdfBytes || selectedSentenceIds.length === 0 || erasing) return;
    setErasing(true);
    setEraseMessage(null);
    try {
      const out = await eraseSentences(pdfBytes, selectedPage, selectedSentenceIds);
      const next = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      const count = selectedSentenceIds.length;
      setEraseStack((prev) => [...prev, pdfBytes]);
      setSelectedSentenceIds([]);
      setHoverSentenceId(null);
      await applyPdfBytes(next);
      setEraseMessage(`${count}つの文を消しました。`);
    } catch (e) {
      setEraseMessage(e instanceof Error ? e.message : "文字を消せませんでした");
    } finally {
      setErasing(false);
    }
  }

  async function handleEraseUndo() {
    const prev = eraseStack[eraseStack.length - 1];
    if (!prev || erasing) return;
    setEraseStack((s) => s.slice(0, -1));
    setSelectedSentenceIds([]);
    setEraseMessage(null);
    await applyPdfBytes(prev);
  }

  // 「文字を消す」で文を選んでいるとき、Delete・Backspace キーで消す（文字を入力している途中は除く）
  useEffect(() => {
    if (mode !== "erase-text" || selectedSentenceIds.length === 0 || inactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      void handleEraseSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedSentenceIds, pdfBytes, inactive]);

  /** 注釈の設定を出す（一覧でその注釈を開き、全画面なら左の詳細設定を出して、その注釈の設定までスクロールする） */
  function openObjectSettings(id: string) {
    setOpenListIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (fullscreen) setFullscreenSettingsOpen(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.querySelector(`[data-object-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      })
    );
  }

  function toggleFullscreen(next: boolean) {
    fullscreenRef.current = next;
    setFullscreen(next);
    if (!next) setFullscreenSettingsOpen(false);
  }

  // 全画面の切り替え：広さが変わるので描き直す。全画面の間は、後ろのページがスクロールしないようにし、Escキーで閉じられるようにする
  useEffect(() => {
    if (!file || !pdfBytes) return;
    const id = requestAnimationFrame(() => void reloadPreview(selectedPage, zoom));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, fullscreenSettingsOpen]);
  useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 文字を入力している途中のEscは、入力の確定・取り消しに使うので、全画面は閉じない
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      toggleFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

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
    if (mode === "erase-text") {
      // 文字を消す：押した文を選ぶ（もう一度押すと外す。いくつでも選べる）
      const s = sentenceAtScreen(e);
      if (!s) {
        setSelectedSentenceIds([]);
        return;
      }
      if (!s.erasable) {
        setEraseMessage("この文は、消せない文字（縦書き・特別なフォントなど）を含むため、選べません。");
        return;
      }
      setEraseMessage(null);
      setSelectedSentenceIds((prev) => (prev.includes(s.id) ? prev.filter((id) => id !== s.id) : [...prev, s.id]));
      return;
    }
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
      // 縦書きは、押した位置を文字の箱の上端にする。横書きは、押した位置の少し下を文字の基準線にする（従来どおり）
      const pdfY = textVertical
        ? screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale)
        : screenToPdfY(clickY, fontSize * 0.3, currentPageInfo.height, pageRenderScale);
      // 横書き・左揃えの文字は、もともと書かれている文字の書き始めの位置・基準線に合わせる（近いときだけ）
      const snapped = !textVertical && textAlign === "left" ? snapToGuides(pdfX, pdfY) : { x: pdfX, y: pdfY };
      setActiveGuide(null);
      const obj: TextAnnotationObject = {
        id: createAnnotationId("text"),
        type: "text",
        page: selectedPage,
        x: Math.max(0, snapped.x),
        y: Math.max(0, snapped.y),
        text: "",
        fontSize,
        color: COLOR_CHOICES[textColorChoice],
        bold: textBold,
        align: textAlign,
        ...(textVertical ? { vertical: true } : {}),
      };
      commit([...objects, obj]);
      setActiveObjectId(obj.id);
      // 置いた場所で、そのまま文字を入力できるようにする
      textEditStartRef.current = { id: obj.id, text: "" };
      setEditingTextId(obj.id);
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
        // 枠なし（マークだけ）は、印を付けるために置くので、最初からチェックした状態にする
        checked: !checkboxFrame,
        markStyle: checkboxMarkStyle,
        frame: checkboxFrame,
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
    } else if (mode === "whiteout") {
      // 白消し：白で塗りつぶした矩形を置く（見た目を隠すだけで、元の文字情報は消えない）。
      // 後から置いても、すでに書いた文字・図形を隠さないよう、配列の先頭側（＝奥）に差し込む。
      if (atObjectLimit()) return;
      const width = WHITEOUT_DEFAULT_WIDTH;
      const height = WHITEOUT_DEFAULT_HEIGHT;
      const centerY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
      const obj: RectangleShapeObject = {
        id: createAnnotationId("shape"),
        type: "shape",
        shapeKind: "rectangle",
        page: selectedPage,
        x: Math.max(0, pdfX - width / 2),
        y: Math.max(0, centerY - height / 2),
        width,
        height,
        rotation: 0,
        color: WHITEOUT_COLOR,
        strokeWidth: 1,
        fill: true,
      };
      const at = whiteoutInsertIndex(objects);
      commit([...objects.slice(0, at), obj, ...objects.slice(at)]);
      setActiveObjectId(obj.id);
      setMode("select");
    } else if (mode === "blackout") {
      // 黒塗り（見た目だけ。工程4）：真っ黒で塗りつぶした矩形を、いちばん手前に置く。
      // 見た目を隠すだけで、元の文字・画像のデータは消えない（本当の墨消しは「PDF黒塗り・墨消し」ツール）。
      if (atObjectLimit()) return;
      const width = BLACKOUT_DEFAULT_WIDTH;
      const height = BLACKOUT_DEFAULT_HEIGHT;
      const centerY = screenToPdfY(clickY, 0, currentPageInfo.height, pageRenderScale);
      const obj: RectangleShapeObject = {
        id: createAnnotationId("shape"),
        type: "shape",
        shapeKind: "rectangle",
        page: selectedPage,
        x: Math.min(Math.max(0, pdfX - width / 2), Math.max(0, currentPageInfo.width - width)),
        y: Math.min(Math.max(0, centerY - height / 2), Math.max(0, currentPageInfo.height - height)),
        width,
        height,
        rotation: 0,
        color: BLACKOUT_COLOR,
        strokeWidth: 1,
        fill: true,
      };
      commit([...objects, obj]);
      setActiveObjectId(obj.id);
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
      if (suppressCanvasClickRef.current) {
        suppressCanvasClickRef.current = false;
        return;
      }
      setActiveObjectId(null);
    }
  }

  // ---------------------------------------------------------------------
  // 3. 選択・ドラッグ移動（テキスト・チェック・画像・手書き共通）
  // ---------------------------------------------------------------------
  function handleObjectPointerDown(e: React.PointerEvent<HTMLDivElement>, obj: AnnotationObject) {
    // 工程4：配置用のモード（テキスト・チェック・図形など）のままでも、置いたものをつかんで動かせるようにする。
    // つかんだら「選択・移動」に切り替える。手書き中と、画像・印影を置こうとしている間は、従来どおり（置く・描く操作を優先）
    if (mode === "ink") return;
    if ((mode === "image" || mode === "stamp") && pendingImage) return;
    // 白消しの上には、テキストなどを置けるようにする（白消し→書き直しのため。従来どおり）
    if (mode !== "select" && isWhiteoutObject(obj) && (mode === "text" || mode === "checkbox")) return;
    if (mode !== "select") setMode("select");
    e.stopPropagation();
    // 揃えるために、いくつか選ぶ（Shift・⌘・Ctrl を押しながら押す。スマホは「複数選択」をオンにして押す）
    const additive = multiSelectMode || e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive && activeObjectId && objects.some((o) => o.id === activeObjectId && o.page === obj.page)) {
      // 押した直後のクリックが、下のページに届いても選択を外さないようにする
      suppressCanvasClickRef.current = true;
      if (activeObjectId === obj.id) {
        if (extraSelectedIds.length > 0) {
          setActiveObjectId(extraSelectedIds[0]);
          setExtraSelectedIds(extraSelectedIds.slice(1));
        }
      } else {
        setExtraSelectedIds((prev) => (prev.includes(obj.id) ? prev.filter((id) => id !== obj.id) : [...prev, obj.id]));
      }
      return;
    }
    if (extraSelectedIds.length > 0) setExtraSelectedIds([]);
    (e.target as Element).setPointerCapture(e.pointerId);
    const wasActive = activeObjectId === obj.id;
    setActiveObjectId(obj.id);
    dragState.current = {
      id: obj.id,
      startX: e.clientX,
      startY: e.clientY,
      original: obj,
      snapshot: objects,
      wasActive,
    };
  }

  function handleObjectPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    if (!drag) return;
    if (isWhiteoutObject(drag.original) && adjustingWhiteoutId !== drag.id) setAdjustingWhiteoutId(drag.id);
    // 工程4：ページの外へ出ないように、ずらす量を抑える（位置ずれ・書き出し時の見切れを防ぐ）
    const page = currentPageInfo ?? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY };
    const { dx: dxPdf, dy: dyPdf } = clampMoveDelta(
      objectBoundsForClamp(drag.original),
      (e.clientX - drag.startX) / pageRenderScale,
      -(e.clientY - drag.startY) / pageRenderScale,
      page
    );
    // 横書き・左揃えの文字は、もともと書かれている文字の書き始めの位置・基準線の近くに来たら、ぴったり合わせる
    let snapDx = dxPdf;
    let snapDy = dyPdf;
    if (drag.original.type === "text" && !drag.original.vertical && (drag.original.align ?? "left") === "left") {
      const snapped = snapToGuides(drag.original.x + dxPdf, drag.original.y + dyPdf);
      snapDx = snapped.x - drag.original.x;
      snapDy = snapped.y - drag.original.y;
      if (snapped.guide?.x !== activeGuide?.x || snapped.guide?.y !== activeGuide?.y) setActiveGuide(snapped.guide);
    }
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== drag.id) return o;
        const original = drag.original;
        if (original.type === "text" && o.type === "text") {
          return { ...o, x: original.x + snapDx, y: original.y + snapDy };
        }
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
          return { ...o, x: original.x + dxPdf, y: original.y + dyPdf } as ShapeAnnotationObject;
        }
        if (
          (original.type === "text" || original.type === "checkbox" || original.type === "image") &&
          (o.type === "text" || o.type === "checkbox" || o.type === "image")
        ) {
          return { ...o, x: original.x + dxPdf, y: original.y + dyPdf } as AnnotationObject;
        }
        return o;
      })
    );
  }

  function handleObjectPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    dragState.current = null;
    setAdjustingWhiteoutId(null);
    setActiveGuide(null);
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
      return;
    }
    // 選ばれている文字をもう一度押したら、その場で文字を編集する
    if (drag.original.type === "text" && drag.wasActive) {
      textEditStartRef.current = { id: drag.id, text: drag.original.text };
      setEditingTextId(drag.id);
    }
  }

  // ---------------------------------------------------------------------
  // 3-2. つまみで大きさを変える（工程4。チェック・画像/印影・矩形/円）
  // ---------------------------------------------------------------------
  function handleResizePointerDown(e: React.PointerEvent<HTMLElement>, obj: AnnotationObject) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    if (mode !== "select") setMode("select");
    setActiveObjectId(obj.id);
    resizeState.current = { id: obj.id, startX: e.clientX, startY: e.clientY, original: obj, snapshot: objects };
  }

  function handleResizePointerMove(e: React.PointerEvent<HTMLElement>) {
    const rs = resizeState.current;
    if (!rs || !currentPageInfo) return;
    if (isWhiteoutObject(rs.original) && adjustingWhiteoutId !== rs.id) setAdjustingWhiteoutId(rs.id);
    e.stopPropagation();
    const page = currentPageInfo;
    const scale = pageRenderScale;
    const sdx = e.clientX - rs.startX;
    const sdy = e.clientY - rs.startY;
    const o = rs.original;
    if (o.type === "checkbox") {
      const grow = Math.max(sdx, sdy) / scale;
      // 左上を動かさずに大きくする（PDFの座標は左下が原点なので、上端 y+size を保つ）
      const top = o.y + o.size;
      const size = Math.min(Math.max(MIN_RESIZE_PT, o.size + grow), 200, top, page.width - o.x);
      patchObjectLive(o.id, { size, y: top - size });
      return;
    }
    if (o.type !== "image" && !(o.type === "shape" && o.shapeKind !== "line")) return;
    const rotation = o.type === "image" ? (o.rotation ?? 0) : o.rotation;
    // 画面では rotate(-rotation) で表示しているので、画面の動きを、回す前の向きの動きに直す
    const th = (-rotation * Math.PI) / 180;
    const lx = (Math.cos(th) * sdx + Math.sin(th) * sdy) / scale;
    const ly = (-Math.sin(th) * sdx + Math.cos(th) * sdy) / scale;
    let w = Math.max(MIN_RESIZE_PT, o.width + lx);
    let h = Math.max(MIN_RESIZE_PT, o.height + ly);
    if (o.type === "image" && o.aspectLocked !== false) {
      // 縦横比を保つ（大きく動かした方に合わせる）
      if (Math.abs(lx) * o.height >= Math.abs(ly) * o.width) h = w / o.aspectRatio;
      else w = h * o.aspectRatio;
    }
    w = Math.min(w, page.width * 2);
    h = Math.min(h, page.height * 2);
    // 回す前の左上の角（画面の見た目で固定する点）を動かさないように、中心をずらす
    const cx = o.x + o.width / 2;
    const cy = o.y + o.height / 2;
    const r = (rotation * Math.PI) / 180;
    // 左上の角の見た目の位置（PDFの座標。反時計回りが正）
    const rot = (vx: number, vy: number) => ({ x: vx * Math.cos(r) - vy * Math.sin(r), y: vx * Math.sin(r) + vy * Math.cos(r) });
    const a = rot(-o.width / 2, o.height / 2);
    const anchor = { x: cx + a.x, y: cy + a.y };
    const b = rot(w / 2, -h / 2);
    const ncx = anchor.x + b.x;
    const ncy = anchor.y + b.y;
    patchObjectLive(o.id, { width: w, height: h, x: ncx - w / 2, y: ncy - h / 2 });
  }

  function handleResizePointerUp(e: React.PointerEvent<HTMLElement>) {
    const rs = resizeState.current;
    resizeState.current = null;
    setAdjustingWhiteoutId(null);
    if (!rs) return;
    e.stopPropagation();
    if (Math.hypot(e.clientX - rs.startX, e.clientY - rs.startY) >= 2) pushHistory(rs.snapshot);
  }

  /** 選んでいるオブジェクトの右下に出す、大きさを変えるつまみ */
  function resizeHandle(obj: AnnotationObject) {
    if (activeObjectId !== obj.id) return null;
    return (
      <span
        role="presentation"
        data-testid="pdf-annotate-resize-handle"
        onPointerDown={(e) => handleResizePointerDown(e, obj)}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onClick={(e) => e.stopPropagation()}
        className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600 shadow"
        style={{ touchAction: "none" }}
      />
    );
  }

  function handleObjectInertClick(e: React.MouseEvent) {
    // オブジェクト上のクリックが親要素(キャンバス)まで伝播し、配置モードで
    // 意図しない新規オブジェクトが作られてしまうのを防ぐ
    e.stopPropagation();
    suppressCanvasClickRef.current = false;
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
    if (mode === "erase-text") {
      const s = sentenceAtScreen(e);
      const id = s ? s.id : null;
      if (id !== hoverSentenceId) setHoverSentenceId(id);
      return;
    }
    if (mode === "text" && currentPageInfo) {
      // 文字を書き込む前：押したときに合う目印を、点線で先に見せる
      if (textVertical || textAlign !== "left") {
        if (activeGuide) setActiveGuide(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = screenToPdfX(e.clientX - rect.left, pageRenderScale);
      const y = screenToPdfY(e.clientY - rect.top, textFontSize * 0.3, currentPageInfo.height, pageRenderScale);
      const { guide } = snapToGuides(x, y);
      if (guide?.x !== activeGuide?.x || guide?.y !== activeGuide?.y) setActiveGuide(guide);
      return;
    }
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
    exportedObjectsRef.current = null;
    // 書き出しに使う編集内容を、処理の開始時点で控えておく（処理中に編集が加わっても、結果と対応づけられるように）
    const snapshot = objects;
    const bytesSnapshot = pdfBytes;
    try {
      const output = await new PdfFillAnnotateProcessor().process({ file, objects: snapshot });
      exportedObjectsRef.current = snapshot;
      exportedBytesRef.current = bytesSnapshot;
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの書き出しに失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result || !file) return;
    const blob = result.blob;
    const filename = `${stripExtension(file.name)}-記入済み.pdf`;
    const exported = exportedObjectsRef.current;
    const exportedBytes = exportedBytesRef.current;
    // downloadBlob() と同じ流れ（広告の確認が必要な場合は保留される）。保存処理が実際に実行された時点でだけ「保存済み」にする。
    // 保存処理が例外で失敗した場合や、広告の確認画面で取りやめた場合は、保存済みにしない。
    // ブラウザがファイルを書き終えたか（OSへの保存完了）は、アプリからは検出できない。
    runWithDownloadAccess({
      key: blob,
      label: filename,
      run: () => {
        saveBlob(blob, filename);
        if (exported) setSavedObjects(exported);
        if (exportedBytes) setSavedPdfBytes(exportedBytes);
      },
    });
  }

  const MODE_LABELS: { value: ToolMode; label: string }[] = [
    { value: "select", label: "選択・移動" },
    { value: "text", label: "テキスト" },
    { value: "checkbox", label: "チェック" },
    { value: "shape", label: "図形" },
    { value: "whiteout", label: "白消し" },
    { value: "blackout", label: "黒塗り（見た目だけ）" },
    { value: "erase-text", label: "文字を消す（文単位）" },
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

  const previewShown = Boolean(file && pageImageUrl && currentPageInfo);
  // 置いた注釈の色を、あとから変える欄（文字・手書き・図形。2026-11-18：置いたあとに色を変えられなかったため）
  const colorField = (obj: AnnotationObject & { color: AnnotationColor }) => (
    <div className="flex items-center gap-1.5" data-testid="pdf-annotate-object-color">
      <span aria-hidden="true">色</span>
      <Segmented
        size="sm"
        ariaLabel="色"
        value={(colorChoiceOf(obj.color) ?? "") as ColorChoice}
        onChange={(next) => patchObjectWithHistory(obj.id, { color: COLOR_CHOICES[next] })}
        options={(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => ({ value: c, label: COLOR_LABELS[c], swatch: COLOR_SWATCH[c] }))}
      />
    </div>
  );
  const strokeField = (obj: AnnotationObject & { strokeWidth: number }, label = "線の太さ") => (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        min={1}
        max={20}
        step={0.5}
        value={obj.strokeWidth}
        data-testid="pdf-annotate-object-stroke"
        onChange={(e) => patchObjectWithHistory(obj.id, { strokeWidth: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
        className="w-14 rounded border border-neutral-300 px-1 py-1 dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );

  // 配置した注釈の一覧（それぞれの設定を開ける）。ふだんは設定の列の下、全画面の「詳細設定」を出したときは、その中に出す
  const objectListContent = (
    <>
              <h3 className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">配置した注釈（{objects.length}件）</h3>
              <ul className="flex flex-col gap-2" data-testid="pdf-annotate-object-list">
                {objects.map((obj) => {
                  const open = openListIds.includes(obj.id);
                  const summary = objectSummary(obj);
                  const special = isWhiteoutObject(obj) || isBlackoutObject(obj);
                  return (
                  <li
                    key={obj.id}
                    data-testid="pdf-annotate-object-item"
                    data-object-id={obj.id}
                    data-expanded={open ? "true" : "false"}
                    onClick={() => {
                      if (obj.page !== selectedPage) handlePageChange(obj.page);
                      setActiveObjectId(obj.id);
                    }}
                    className={`flex flex-col gap-2 rounded-lg border p-2 text-xs ${
                      activeObjectId === obj.id ? "border-blue-400 bg-blue-50 dark:bg-blue-950/20" : "border-neutral-200 dark:border-neutral-800"
                    }`}
                  >
                    {/* 見出し：何の注釈か（種類・中身・ページ）。押すと開く／閉じる */}
                    <button
                      type="button"
                      aria-expanded={open}
                      data-testid="pdf-annotate-object-summary"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (obj.page !== selectedPage) handlePageChange(obj.page);
                        if (activeObjectId !== obj.id) {
                          setActiveObjectId(obj.id);
                          setOpenListIds([obj.id]);
                        } else {
                          setOpenListIds((prev) => (prev.includes(obj.id) ? prev.filter((id) => id !== obj.id) : [...prev, obj.id]));
                        }
                      }}
                      className="flex w-full min-w-0 items-center gap-2 text-left"
                    >
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                        {obj.page}p
                      </span>
                      {isWhiteoutObject(obj) && (
                        <span
                          data-testid="pdf-whiteout-badge"
                          className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                        >
                          白消し
                        </span>
                      )}
                      {isBlackoutObject(obj) && (
                        <span
                          data-testid="pdf-blackout-badge"
                          className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                          title={BLACKOUT_NOTICE.body}
                        >
                          黒塗り（見た目だけ・元データは残る）
                        </span>
                      )}
                      {!special && <span className="shrink-0 font-semibold text-neutral-700 dark:text-neutral-200">{summary.kind}</span>}
                      {!special && summary.detail && (
                        <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400" data-testid="pdf-annotate-object-detail">
                          {summary.detail}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-neutral-400" aria-hidden="true">
                        {open ? "▲" : "▼"}
                      </span>
                    </button>
                    {open && (
                    <div className="flex flex-wrap items-center gap-2" data-testid="pdf-annotate-object-detail-panel">

                    {obj.type === "text" && (
                      <>
                        {/* 2026-11：文字を打つ欄を、行いっぱいの幅・3行以上の高さに広げた（小さくて打ちにくかったため）。日付の挿入はやめた */}
                        <label className="flex w-full basis-full items-center gap-1">
                          <span className="sr-only">テキスト内容</span>
                          <textarea
                            rows={Math.min(8, Math.max(3, obj.text.split("\n").length))}
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
                            className="w-full resize-y rounded border border-neutral-300 px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                            data-testid="pdf-annotate-text-input"
                          />
                        </label>
                        <div className="w-56">
                          <SliderField
                            label="文字サイズ"
                            value={obj.fontSize}
                            min={6}
                            max={96}
                            unit="pt"
                            onChange={(v) => patchObjectWithHistory(obj.id, { fontSize: v })}
                          />
                        </div>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={obj.bold}
                            onChange={(e) => patchObjectWithHistory(obj.id, { bold: e.target.checked })}
                          />
                          太字
                        </label>
                        {colorField(obj)}
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={!!obj.vertical} onChange={() => toggleTextVertical(obj)} data-testid="pdf-annotate-list-vertical" />
                          縦書き
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
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={obj.frame !== false}
                            onChange={(e) => patchObjectWithHistory(obj.id, { frame: e.target.checked })}
                          />
                          枠
                        </label>
                      </>
                    )}

                    {obj.type === "ink" && (
                      <>
                        {colorField(obj)}
                        {strokeField(obj, "太さ")}
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
                        {!isWhiteoutObject(obj) && !isBlackoutObject(obj) && colorField(obj)}
                        {!isWhiteoutObject(obj) && !isBlackoutObject(obj) && strokeField(obj)}
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
                      <>
                        {colorField(obj)}
                        {strokeField(obj)}
                        <RotateButtons onRotate={(delta) => rotateObject(obj.id, delta)} />
                      </>
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
                    </div>
                    )}
                  </li>
                  );
                })}
              </ul>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {previewToolbar && !previewShown && previewToolbar}
      {operationSlot && !previewShown && operationSlot}

      {error && <ErrorMessage message={error} />}

      <section className="flex flex-col gap-3">
        <StepHeading n={1} as="h2">PDFをアップロード</StepHeading>
        <FileDropzone
          compact={!!file}
          accept="application/pdf,.pdf"
          label="PDFをドラッグ&ドロップ"
          hint="またはタップして選択（1ファイル）"
          pageDrop={inactive ? false : undefined}
          onFilesSelected={requestFileSelect}
          onError={setError}
        />
        {pendingFiles && hasEdits && (
          <div
            role="alertdialog"
            aria-label="PDFの選び直しの確認"
            data-testid="pdf-annotate-replace-confirm"
            className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200"
          >
            <p>配置した文字・図形などがあります。「{pendingFiles[0].name}」を選び直すと、これらは消えます（元に戻せません）。</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="pdf-annotate-replace-cancel"
                onClick={() => setPendingFiles(null)}
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-transparent dark:text-red-200 dark:hover:bg-red-900/30"
              >
                編集を続ける
              </button>
              <button
                type="button"
                data-testid="pdf-annotate-replace-ok"
                onClick={() => {
                  const next = pendingFiles;
                  setPendingFiles(null);
                  void handleFileSelect(next);
                }}
                className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
              >
                消して選び直す
              </button>
            </div>
          </div>
        )}
        {file && <FileList files={[file]} />}
        {loading && <p className="text-xs text-neutral-500">読み込み中...</p>}
      </section>

      {file && pageImageUrl && currentPageInfo && (
        <section data-preview-split className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,560px)] xl:grid-cols-[minmax(0,1fr)_minmax(360px,664px)] lg:grid-rows-[auto_1fr] lg:gap-x-6">
          {/* PC幅: 左に設定、右にキャンバス(画面に固定)。スマホ幅は従来どおり 設定 → キャンバス → 注釈一覧 の順に縦並び */}
          <div
            className={
              fullscreen && fullscreenSettingsOpen
                ? "fixed bottom-0 left-0 top-0 z-[72] flex w-[min(340px,85vw)] flex-col gap-3 overflow-y-auto border-r border-neutral-200 bg-white p-3 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
                : "flex min-w-0 flex-col gap-3 lg:col-start-1 lg:row-start-1"
            }
            data-testid="pdf-settings-column"
            data-fullscreen-drawer={fullscreen && fullscreenSettingsOpen ? "true" : undefined}
          >
          {fullscreen && fullscreenSettingsOpen && (
            <button
              type="button"
              onClick={() => setFullscreenSettingsOpen(false)}
              className="self-end rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
            >
              ✕ 詳細設定をしまう
            </button>
          )}
          <StepHeading n={2} as="h2">記入・注釈を配置</StepHeading>

          {operationSlot && (
            // PDF修正の「やりたい操作」は、設定の列（PCでは左、スマホではプレビューの上）に置く。
            // 以前はプレビュー（PDFの表示）の上に重ねて貼り付けていたが、操作のボタンと説明がPDFを覆ってしまうため、
            // 設定は設定の列、PDFの確認はプレビューの列、と役割を分けた（プレビューの上には何も重ねない）
            <div className="flex flex-col gap-2" data-testid="pdf-fix-operation-in-settings">
              {operationSlot}
            </div>
          )}

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

            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="表示倍率">
              <ZoomSlider value={zoom} min={50} max={300} step={5} onChange={handleZoomChange} testId="fill-zoom-slider" className="w-32" />
              <span className="w-10 text-right tabular-nums" data-testid="fill-zoom-value">
                {zoom}%
              </span>
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

          {!isControlled && (
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
          )}

          {mode === "text" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <div className="w-56">
                <SliderField label="文字サイズ" value={textFontSize} min={6} max={96} unit="pt" onChange={setTextFontSize} />
              </div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">色</span>
                <Segmented
                  size="sm"
                  ariaLabel="色"
                  value={textColorChoice}
                  onChange={(next) => setTextColorChoice(next)}
                  options={(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => ({ value: c, label: COLOR_LABELS[c], swatch: COLOR_SWATCH[c] }))}
                />
              </div>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={textBold} onChange={(e) => setTextBold(e.target.checked)} />
                太字
              </label>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">整列</span>
                <Segmented
                  size="sm"
                  ariaLabel="整列"
                  value={textAlign}
                  onChange={(next) => setTextAlign(next)}
                  options={(Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => ({ value: a, label: ALIGN_LABELS[a] }))}
                />
              </div>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={textVertical} onChange={(e) => setTextVertical(e.target.checked)} data-testid="pdf-annotate-text-vertical-setting" />
                縦書き
              </label>
              <span className="text-neutral-500 dark:text-neutral-400">改行はEnter</span>
            </div>
          )}

          {mode === "checkbox" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
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
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">マーク</span>
                <Segmented
                  size="sm"
                  ariaLabel="マーク"
                  value={checkboxMarkStyle}
                  onChange={(next) => setCheckboxMarkStyle(next)}
                  options={(Object.keys(MARK_STYLE_LABELS) as CheckboxMarkStyle[]).map((m) => ({ value: m, label: MARK_STYLE_LABELS[m] }))}
                />
              </div>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid="pdf-annotate-checkbox-frame"
                  checked={checkboxFrame}
                  onChange={(e) => setCheckboxFrame(e.target.checked)}
                />
                枠を付ける
              </label>
              <span className="w-full text-neutral-500 dark:text-neutral-400">
                枠を外すと、マーク（レ点・×・○）だけを置きます。PDFにもともとあるチェック欄に印を付けるときに使います。
                置いたあとは、ドラッグで位置を、右下のつまみで大きさを調整できます。
              </span>
            </div>
          )}

          {mode === "erase-text" && (
            <div
              data-testid="pdf-erase-panel"
              className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200"
            >
              <span>消したい文を押して選び（いくつでも選べます）、「選んだ文を消す」かDeleteキーで消します。</span>
              <span>消した文字は、PDFのデータから取り除きます（コピー・検索でも出ません）。ほかの文字の位置は変わりません。</span>
              {textAnalysisLoading && <span data-testid="pdf-erase-loading">文字を読み取っています…</span>}
              {!textAnalysisLoading && textAnalysis && textAnalysis.page === selectedPage && !textAnalysis.analysis.hasText && (
                <span className="font-semibold" data-testid="pdf-erase-no-text">
                  このページには文字の情報がありません（スキャンしたPDFなど）。白消しで隠してください。
                </span>
              )}
              {!textAnalysisLoading && textAnalysis && textAnalysis.page === selectedPage && textAnalysis.analysis.hasText && !textAnalysis.analysis.erasable && (
                <span className="font-semibold" data-testid="pdf-erase-unsupported">
                  このページの文字は、作りの都合で消せません（縦書き・特別なフォントなど）。白消しで隠してください。
                </span>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleEraseSelected()}
                  disabled={selectedSentenceIds.length === 0 || erasing}
                  data-testid="pdf-erase-run"
                  className="rounded bg-red-600 px-3 py-1.5 font-semibold text-white disabled:opacity-50"
                >
                  {erasing ? "消しています…" : `選んだ文を消す（${selectedSentenceIds.length}）`}
                </button>
                {selectedSentenceIds.length > 0 && (
                  <button type="button" onClick={() => setSelectedSentenceIds([])} className="rounded border border-red-300 px-3 py-1.5 dark:border-red-800">
                    選ぶのをやめる
                  </button>
                )}
                {eraseStack.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleEraseUndo()}
                    disabled={erasing}
                    data-testid="pdf-erase-undo"
                    className="rounded border border-red-300 px-3 py-1.5 dark:border-red-800"
                  >
                    消した文を1つ前に戻す
                  </button>
                )}
              </div>
              {eraseMessage && (
                <span role="status" data-testid="pdf-erase-message">
                  {eraseMessage}
                </span>
              )}
            </div>
          )}

          {mode === "whiteout" && (
            <div
              data-testid="pdf-whiteout-panel"
              className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
            >
              <span>書き直すときは、白消しの上に「テキスト」で入力します。</span>
              <span className="font-semibold">{WHITEOUT_NOTICE.title}</span>
              <span>{WHITEOUT_NOTICE.body}</span>
            </div>
          )}

          {mode === "blackout" && (
            <div
              data-testid="pdf-blackout-panel"
              className="flex flex-col gap-1 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200"
            >
              <span>隠したい場所をクリックすると、黒い四角形を置きます。ドラッグで位置を、右下のつまみで大きさを調整できます。</span>
              <span className="font-semibold">{BLACKOUT_NOTICE.title}</span>
              <span>{BLACKOUT_NOTICE.body}</span>
              <span>
                個人情報などを元のデータごと消す（墨消し）には、
                {onOpenRedaction ? (
                  <button type="button" onClick={onOpenRedaction} className="font-semibold underline" data-testid="pdf-blackout-redact-link">
                    {TRUE_REDACTION_TOOL_NAME}
                  </button>
                ) : (
                  <Link href={TRUE_REDACTION_TOOL_PATH} className="font-semibold underline" data-testid="pdf-blackout-redact-link">
                    {TRUE_REDACTION_TOOL_NAME}
                  </Link>
                )}
                を使ってください。
              </span>
            </div>
          )}

          {mode === "shape" && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">種類</span>
                <Segmented
                  size="sm"
                  ariaLabel="種類"
                  value={shapeKind}
                  onChange={(next) => setShapeKind(next)}
                  options={(Object.keys(SHAPE_KIND_LABELS) as ShapeKind[]).map((k) => ({ value: k, label: SHAPE_KIND_LABELS[k] }))}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">色</span>
                <Segmented
                  size="sm"
                  ariaLabel="色"
                  value={shapeColorChoice}
                  onChange={(next) => setShapeColorChoice(next)}
                  options={(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => ({ value: c, label: COLOR_LABELS[c], swatch: COLOR_SWATCH[c] }))}
                />
              </div>
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
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">色</span>
                <Segmented
                  size="sm"
                  ariaLabel="色"
                  value={inkColorChoice}
                  onChange={(next) => setInkColorChoice(next)}
                  options={(Object.keys(COLOR_LABELS) as ColorChoice[]).map((c) => ({ value: c, label: COLOR_LABELS[c], swatch: COLOR_SWATCH[c] }))}
                />
              </div>
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
                  acceptHandoff={false}
                  label="画像をドラッグ&ドロップ"
                  hint="PNG・JPEGに対応（1枚）"
                  onFilesSelected={(files) => void handleImageStage(files, false)}
                  onError={setError}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-blue-700 dark:text-blue-300">PDF上をクリックして配置してください。</span>
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
              {!pendingImage ? (
                <FileDropzone
                  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                  maxSizeMB={PDF_FILL_ANNOTATE_LIMITS.maxImageSizeMB}
                  acceptHandoff={false}
                  label="印影画像をドラッグ&ドロップ"
                  hint="PNG・JPEGに対応（1枚、背景透過PNG推奨）"
                  onFilesSelected={(files) => void handleImageStage(files, true)}
                  onError={setError}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-blue-700 dark:text-blue-300">PDF上をクリックして配置してください。</span>
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
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">配置し直す位置をクリックしてください。</p>
          )}

          {fullscreen && fullscreenSettingsOpen && objects.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800" data-testid="pdf-fullscreen-object-list">
              {objectListContent}
            </div>
          )}
          </div>

          {/* プレビューの列：PCでは画面に固定（スクロールしても見えたまま）。一番上に「やりたい操作」の帯を置く */}
          <div
            className={
              fullscreen
                ? `fixed inset-0 z-[70] flex min-w-0 flex-col bg-white p-2 sm:p-3 dark:bg-neutral-950${fullscreenSettingsOpen ? " lg:pl-[352px]" : ""}`
                : "min-w-0 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start"
            }
            data-testid="pdf-preview-column"
            data-fullscreen={fullscreen ? "true" : undefined}
            role={fullscreen ? "dialog" : undefined}
            aria-modal={fullscreen ? true : undefined}
            aria-label={fullscreen ? "全画面で編集" : undefined}
          >
          {/* 全画面のボタン（全画面の間は、ページ送り・表示倍率・閉じるをここにまとめる） */}
          <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-xs" data-testid="pdf-fullscreen-bar">
            {fullscreen && (
              <button
                type="button"
                onClick={() => setFullscreenSettingsOpen((v) => !v)}
                aria-pressed={fullscreenSettingsOpen}
                data-testid="pdf-fullscreen-settings"
                className={`flex items-center gap-1 rounded px-2 py-1 font-semibold ${
                  fullscreenSettingsOpen ? "bg-blue-600 text-white" : "border border-neutral-300 dark:border-neutral-700"
                }`}
              >
                <span aria-hidden="true">⚙</span>詳細設定
              </button>
            )}
            {fullscreen && pages.length > 1 && (
              <span className="mr-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handlePageChange(selectedPage - 1)}
                  disabled={selectedPage <= 1}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                  aria-label="前のページ"
                >
                  ‹
                </button>
                <span className="tabular-nums" data-testid="pdf-fullscreen-page">
                  {selectedPage} / {pages.length}
                </span>
                <button
                  type="button"
                  onClick={() => handlePageChange(selectedPage + 1)}
                  disabled={selectedPage >= pages.length}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                  aria-label="次のページ"
                >
                  ›
                </button>
              </span>
            )}
            {fullscreen && (
              <span className="flex items-center gap-1" role="group" aria-label="表示倍率">
                <button
                  type="button"
                  onClick={() => handleZoomChange(Math.max(50, zoom - 25))}
                  disabled={zoom <= 50}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                  aria-label="縮小"
                >
                  −
                </button>
                <span className="w-10 text-center tabular-nums" data-testid="pdf-fullscreen-zoom">
                  {zoom}%
                </span>
                <button
                  type="button"
                  onClick={() => handleZoomChange(Math.min(300, zoom + 25))}
                  disabled={zoom >= 300}
                  className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
                  aria-label="拡大"
                >
                  ＋
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={() => toggleFullscreen(!fullscreen)}
              aria-pressed={fullscreen}
              data-testid="pdf-fullscreen-toggle"
              className={`flex items-center gap-1 rounded px-2 py-1 font-semibold ${
                fullscreen ? "bg-blue-600 text-white" : "border border-neutral-300 dark:border-neutral-700"
              }`}
            >
              <span aria-hidden="true">{fullscreen ? "✕" : "⛶"}</span>
              {fullscreen ? "全画面を閉じる" : "全画面で編集"}
            </button>
          </div>
          {previewToolbar && (
            <div
              className={fullscreen ? "mb-2" : "sticky top-14 z-30 -mx-1 mb-2 px-1 lg:static lg:mx-0 lg:px-0"}
              data-testid="pdf-fix-toolbar-slot"
            >
              {previewToolbar}
            </div>
          )}
          <div
            ref={canvasWrapRef}
            data-testid="tool-preview"
            className={
              fullscreen
                ? "w-full min-h-0 min-w-0 flex-1 overflow-auto"
                : `w-full min-w-0 overflow-x-auto lg:overflow-y-auto ${previewToolbar ? "lg:max-h-[calc(100vh-9.5rem)]" : "lg:max-h-[calc(100vh-6rem)]"}`
            }
          >
            <div
              data-testid="pdf-annotate-canvas"
              data-text-guides={pageGuides ? `${pageGuides.xs.length},${pageGuides.ys.length}` : undefined}
              className={`relative select-none border border-neutral-300 dark:border-neutral-700${fullscreen ? " mx-auto" : ""}`}
              style={{
                width: pageImagePixelSize.width || "100%",
                cursor: mode === "select" ? "default" : mode === "ink" ? (eraseMode ? "pointer" : "crosshair") : "crosshair",
                touchAction: mode === "ink" ? "none" : "auto",
              }}
              onClick={handleCanvasClick}
              onPointerDown={handleWrapperPointerDown}
              onPointerMove={handleWrapperPointerMove}
              onPointerUp={handleWrapperPointerUp}
              onPointerLeave={() => {
                if (hoverSentenceId !== null) setHoverSentenceId(null);
                if (mode === "text" && activeGuide) setActiveGuide(null);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pageImageUrl} alt={`PDF ${selectedPage}ページ目のプレビュー`} draggable={false} />

              {/* 位置合わせの目印：もともと書かれている文字の書き始めの位置（縦の点線）・基準線（横の点線） */}
              {activeGuide && currentPageInfo && (mode === "text" || mode === "select") && (
                <>
                  {activeGuide.x !== null && (
                    <div
                      data-testid="pdf-text-guide-x"
                      className="pointer-events-none absolute top-0 border-l border-dashed border-sky-500"
                      style={{ left: activeGuide.x * pageRenderScale, height: currentPageInfo.height * pageRenderScale }}
                    />
                  )}
                  {activeGuide.y !== null && (
                    <div
                      data-testid="pdf-text-guide-y"
                      className="pointer-events-none absolute left-0 border-t border-dashed border-sky-500"
                      style={{ top: (currentPageInfo.height - activeGuide.y) * pageRenderScale, width: currentPageInfo.width * pageRenderScale }}
                    />
                  )}
                </>
              )}

              {/* 文字を消す：カーソルを乗せた文・選んだ文に色を付ける（押す操作はキャンバスで受ける） */}
              {mode === "erase-text" && currentPageInfo &&
                pageSentences
                  .filter((s) => s.id === hoverSentenceId || selectedSentenceIds.includes(s.id))
                  .flatMap((s) =>
                    s.boxes.map((b, bi) => {
                      const selected = selectedSentenceIds.includes(s.id);
                      return (
                        <div
                          key={`${s.id}-${bi}`}
                          data-testid={selected ? "pdf-erase-selected" : "pdf-erase-hover"}
                          className={`pointer-events-none absolute rounded-sm ${
                            !s.erasable
                              ? "bg-neutral-400/30 outline outline-1 outline-neutral-400"
                              : selected
                                ? "bg-red-500/25 outline outline-2 outline-red-500"
                                : "bg-amber-300/35 outline outline-1 outline-amber-500"
                          }`}
                          style={{
                            left: (b.x0 - 1) * pageRenderScale,
                            top: (currentPageInfo.height - b.y1 - 1) * pageRenderScale,
                            width: (b.x1 - b.x0 + 2) * pageRenderScale,
                            height: (b.y1 - b.y0 + 2) * pageRenderScale,
                          }}
                        />
                      );
                    })
                  )}

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
                const isActive = activeObjectId === obj.id || extraSelectedIds.includes(obj.id);
                if (obj.type === "text" && obj.vertical) {
                  // 縦書き：書き出しと同じ並べ方（layoutVerticalText）で、1文字ずつ SVG に描く
                  const s = pageRenderScale;
                  const fontSize = obj.fontSize;
                  const v = layoutVerticalText(obj.text, fontSize, obj.align ?? "left", (ch) => measureCharPt(ch, fontSize));
                  const left = obj.x * s;
                  const top = (currentPageInfo.height - obj.y) * s;
                  const boldShift = obj.bold ? Math.max(0.35, fontSize * 0.018) * s : 0;
                  const fontFamily = `${PDF_TEXT_FONT_FAMILY}, "Noto Sans JP", sans-serif`;
                  if (editingTextId === obj.id) {
                    const lineH = fontSize * 1.3 * s;
                    const w = Math.max(v.width * s + lineH, lineH * 2);
                    return (
                      <textarea
                        key={obj.id}
                        autoFocus
                        value={obj.text}
                        wrap="off"
                        spellCheck={false}
                        aria-label="PDFに書き込む文字（縦書き）"
                        data-testid="pdf-annotate-inline-text"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={() => {
                          if (!textEditStartRef.current || textEditStartRef.current.id !== obj.id) textEditStartRef.current = { id: obj.id, text: obj.text };
                        }}
                        onChange={(e) => patchObjectLive(obj.id, { text: e.target.value.slice(0, PDF_FILL_ANNOTATE_LIMITS.maxTextLength) })}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
                            e.preventDefault();
                            (e.target as HTMLTextAreaElement).blur();
                          }
                        }}
                        onBlur={() => finishTextEditing(obj.id)}
                        placeholder="文字を入力"
                        className="absolute z-20 m-0 resize-none overflow-hidden whitespace-pre border-0 bg-white/70 p-0 outline outline-2 outline-blue-500 placeholder:text-neutral-400"
                        style={{
                          // 右端（1行目）の位置は動かさず、左へ列が増えていく
                          left: left + v.width * s - w,
                          top,
                          width: w,
                          height: Math.max(v.height * s + fontSize * s, fontSize * s * 5),
                          writingMode: "vertical-rl",
                          fontSize: fontSize * s,
                          lineHeight: `${lineH}px`,
                          fontFamily,
                          color: cssColor(obj.color),
                        }}
                      />
                    );
                  }
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setActiveObjectId(obj.id);
                        textEditStartRef.current = { id: obj.id, text: obj.text };
                        setEditingTextId(obj.id);
                      }}
                      data-testid="pdf-annotate-text-object"
                      data-vertical="true"
                      data-lines={obj.text.split("\n").length}
                      className={`absolute ${isActive ? "outline outline-2 outline-blue-500" : "outline outline-1 outline-dashed outline-neutral-400/60"}`}
                      style={{ left, top, width: v.width * s, height: v.height * s, cursor: mode === "ink" ? "default" : "move", touchAction: "none" }}
                    >
                      {obj.text ? (
                        <svg width={v.width * s} height={v.height * s} style={{ overflow: "visible", display: "block" }} role="img" aria-label={obj.text}>
                          {v.glyphs.map((g, i) => {
                            const gx = g.x * s;
                            const gy = g.y * s;
                            const transform = g.rotate ? `rotate(90 ${gx} ${gy})` : undefined;
                            const props = { fontSize: fontSize * s, fontFamily, fill: cssColor(obj.color), xmlSpace: "preserve" as const };
                            return (
                              <g key={i} transform={transform}>
                                <text x={gx} y={gy} {...props}>
                                  {g.ch}
                                </text>
                                {boldShift > 0 && (
                                  <text x={gx + boldShift} y={gy} {...props} aria-hidden="true">
                                    {g.ch}
                                  </text>
                                )}
                              </g>
                            );
                          })}
                        </svg>
                      ) : (
                        <span className="text-neutral-400" style={{ writingMode: "vertical-rl", fontSize: Math.max(10, fontSize * s * 0.8) }}>
                          （テキスト未入力）
                        </span>
                      )}
                    </div>
                  );
                }
                if (obj.type === "text") {
                  // 書き出しと同じフォント・同じ送り幅・同じ基準線で表示する（src/lib/pdf-annotate/text-layout.ts）。
                  // 画面の拡大・縮小は、PDFの座標×倍率で位置を決めるので、ずれない
                  const lines = obj.text.split("\n");
                  const box = layoutTextBox(obj, currentPageInfo.height, pageRenderScale);
                  const editing = editingTextId === obj.id;
                  const common: React.CSSProperties = {
                    left: box.left,
                    top: box.top,
                    lineHeight: `${box.lineHeight}px`,
                    textAlign: obj.align ?? "left",
                    fontSize: box.fontPx,
                    fontFamily: `${PDF_TEXT_FONT_FAMILY}, "Noto Sans JP", sans-serif`,
                    fontWeight: 400,
                    fontSynthesis: "none",
                    fontKerning: "none",
                    color: cssColor(obj.color),
                    // 書き出しの疑似太字（少しずらして重ねる）と同じ見た目にする
                    textShadow: box.boldShiftPx ? `${box.boldShiftPx}px 0 0 ${cssColor(obj.color)}` : undefined,
                  };
                  if (editing) {
                    return (
                      <textarea
                        key={obj.id}
                        autoFocus
                        value={obj.text}
                        rows={Math.max(1, lines.length)}
                        wrap="off"
                        spellCheck={false}
                        aria-label="PDFに書き込む文字"
                        data-testid="pdf-annotate-inline-text"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={() => {
                          if (!textEditStartRef.current || textEditStartRef.current.id !== obj.id) textEditStartRef.current = { id: obj.id, text: obj.text };
                        }}
                        onChange={(e) => patchObjectLive(obj.id, { text: e.target.value.slice(0, PDF_FILL_ANNOTATE_LIMITS.maxTextLength) })}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
                            e.preventDefault();
                            (e.target as HTMLTextAreaElement).blur();
                          }
                        }}
                        onBlur={() => finishTextEditing(obj.id)}
                        placeholder="文字を入力"
                        className="absolute z-20 m-0 resize-none overflow-hidden whitespace-pre border-0 bg-white/70 p-0 outline outline-2 outline-blue-500 placeholder:text-neutral-400 dark:bg-white/70"
                        style={{ ...common, width: Math.max(box.width + box.fontPx, box.fontPx * 4), height: box.height }}
                      />
                    );
                  }
                  return (
                    <div
                      key={obj.id}
                      onPointerDown={(e) => handleObjectPointerDown(e, obj)}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onClick={handleObjectInertClick}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setActiveObjectId(obj.id);
                        textEditStartRef.current = { id: obj.id, text: obj.text };
                        setEditingTextId(obj.id);
                      }}
                      data-testid="pdf-annotate-text-object"
                      data-lines={lines.length}
                      className={`absolute whitespace-pre ${
                        isActive ? "outline outline-2 outline-blue-500" : "outline outline-1 outline-dashed outline-neutral-400/60"
                      }`}
                      style={{
                        ...common,
                        width: box.width,
                        height: box.height,
                        cursor: mode === "ink" ? "default" : "move",
                        touchAction: "none",
                      }}
                    >
                      {obj.text || <span className="text-neutral-400">（テキスト未入力）</span>}
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
                      data-testid="pdf-annotate-checkbox-object"
                      data-frame={obj.frame === false ? "false" : "true"}
                      className={`absolute flex items-center justify-center ${
                        obj.frame === false
                          ? isActive
                            ? "outline outline-2 outline-blue-500"
                            : "outline outline-1 outline-dashed outline-neutral-400/60"
                          : `border-2 bg-white/60 dark:bg-black/30 ${isActive ? "border-blue-500" : "border-neutral-500"}`
                      }`}
                      style={{
                        left: pdfToScreenX(obj.x, pageRenderScale),
                        top: pdfToScreenY(obj.y, obj.size, currentPageInfo.height, pageRenderScale),
                        width: size,
                        height: size,
                        fontSize: Math.max(8, size * 0.8),
                        lineHeight: 1,
                        color: "rgb(26, 102, 217)",
                        cursor: "move",
                        touchAction: "none",
                      }}
                    >
                      {obj.checked && <span aria-hidden="true">{MARK_STYLE_GLYPHS[obj.markStyle ?? "check"]}</span>}
                      {resizeHandle(obj)}
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
                        cursor: mode === "image" || mode === "stamp" ? "default" : "move",
                        touchAction: "none",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={obj.previewUrl} alt="配置した画像" className="h-full w-full object-contain" draggable={false} />
                      {resizeHandle(obj)}
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
                      style={{ left, top, width, height, cursor: mode === "ink" ? "default" : "move", touchAction: "none" }}
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
                    // 白消しの上にも、テキストなどを配置できるようにする（白消し→書き直しのため）。選択モードでは従来どおり
                    onClick={isWhiteoutObject(obj) && mode !== "select" ? undefined : handleObjectInertClick}
                    data-testid={isBlackoutObject(obj) ? "pdf-blackout-object" : isWhiteoutObject(obj) ? "pdf-whiteout-object" : undefined}
                    // 白消しは、選択の枠を少し外側に点線で出す（白消しの縁が、枠に重なって見えなくならないように）
                    className={`absolute ${
                      isActive
                        ? isWhiteoutObject(obj)
                          ? "outline-dashed outline-2 outline-offset-[3px] outline-blue-500"
                          : "outline outline-2 outline-blue-500"
                        : ""
                    } ${obj.shapeKind === "circle" ? "rounded-full" : ""}`}
                    data-adjusting={adjustingWhiteoutId === obj.id ? "true" : undefined}
                    style={{
                      left: pdfToScreenX(obj.x, pageRenderScale),
                      top: pdfToScreenY(obj.y, obj.height, currentPageInfo.height, pageRenderScale),
                      width: w,
                      height: h,
                      border: `${Math.max(1, obj.strokeWidth * pageRenderScale)}px solid ${cssColor(obj.color)}`,
                      backgroundColor: obj.fill ? cssColor(obj.color) : "transparent",
                      transform: obj.rotation ? `rotate(${-obj.rotation}deg)` : undefined,
                      cursor: mode === "ink" ? "default" : "move",
                      touchAction: "none",
                      opacity: adjustingWhiteoutId === obj.id ? 0.5 : undefined,
                    }}
                  >
                    {resizeHandle(obj)}
                  </div>
                );
              })}

              {/* 選んでいる文字の、すぐ上に出す小さな操作の帯（編集・大きさ・太字・揃え・削除） */}
              {(() => {
                const obj = pageObjects.find((o) => o.id === activeObjectId);
                if (!obj || obj.type !== "text" || mode === "ink" || extraSelectedIds.length > 0) return null;
                const tb = textBoundsPdf(obj);
                const box = {
                  left: tb.minX * pageRenderScale,
                  top: (currentPageInfo.height - tb.maxY) * pageRenderScale,
                  height: (tb.maxY - tb.minY) * pageRenderScale,
                };
                const barTop = box.top - 40 >= 0 ? box.top - 40 : box.top + box.height + 6;
                const btn = "flex h-8 min-w-8 shrink-0 items-center justify-center whitespace-nowrap rounded px-1.5 text-xs font-semibold hover:bg-neutral-100 dark:hover:bg-neutral-700";
                const setSize = (v: number) => patchObjectWithHistory(obj.id, { fontSize: Math.min(96, Math.max(6, v)) });
                return (
                  <div
                    data-testid="pdf-annotate-text-toolbar"
                    className="absolute z-30 flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-neutral-300 bg-white p-0.5 text-neutral-800 shadow-md dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    style={{ left: Math.max(0, Math.min(box.left, pageImagePixelSize.width - 470)), top: barTop }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={btn}
                      title="文字を編集（文字をダブルクリックしても編集できます）"
                      data-testid="pdf-annotate-text-edit"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        textEditStartRef.current = { id: obj.id, text: obj.text };
                        setEditingTextId(obj.id);
                      }}
                    >
                      編集
                    </button>
                    <span className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-600" aria-hidden="true" />
                    <button type="button" className={btn} title="文字を小さく" aria-label="文字を小さく" data-testid="pdf-annotate-text-smaller" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(obj.fontSize - 1)}>
                      A−
                    </button>
                    <span className="w-9 text-center text-xs tabular-nums" data-testid="pdf-annotate-text-size">
                      {obj.fontSize}pt
                    </span>
                    <button type="button" className={btn} title="文字を大きく" aria-label="文字を大きく" data-testid="pdf-annotate-text-larger" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(obj.fontSize + 1)}>
                      A＋
                    </button>
                    <span className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-600" aria-hidden="true" />
                    <button
                      type="button"
                      className={`${btn} ${obj.bold ? "bg-blue-600 text-white hover:bg-blue-700" : ""}`}
                      aria-pressed={obj.bold}
                      title="太字"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => patchObjectWithHistory(obj.id, { bold: !obj.bold })}
                    >
                      B
                    </button>
                    {(Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        className={`${btn} ${(obj.align ?? "left") === a ? "bg-blue-600 text-white hover:bg-blue-700" : ""}`}
                        aria-pressed={(obj.align ?? "left") === a}
                        title={`${ALIGN_LABELS[a]}（複数行のときの、行どうしの揃え方）`}
                        data-testid={`pdf-annotate-text-align-${a}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => patchObjectWithHistory(obj.id, { align: a })}
                      >
                        {obj.vertical ? (a === "left" ? "⤒" : a === "center" ? "↕" : "⤓") : a === "left" ? "⇤" : a === "center" ? "↔" : "⇥"}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`${btn} ${obj.vertical ? "bg-blue-600 text-white hover:bg-blue-700" : ""}`}
                      aria-pressed={!!obj.vertical}
                      title={obj.vertical ? "横書きにする" : "縦書きにする"}
                      data-testid="pdf-annotate-text-vertical"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleTextVertical(obj)}
                    >
                      縦書き
                    </button>
                    <span className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-600" aria-hidden="true" />
                    <button type="button" className={btn} title="この文字を複製" data-testid="pdf-annotate-toolbar-duplicate" onMouseDown={(e) => e.preventDefault()} onClick={() => duplicateObject(obj.id)}>
                      複製
                    </button>
                    <button
                      type="button"
                      className={`${btn} ${multiSelectMode ? "bg-blue-600 text-white hover:bg-blue-700" : ""}`}
                      aria-pressed={multiSelectMode}
                      title="ほかの注釈もいくつでも選んで、位置を揃える（PCでは Shift を押しながら押しても選べます）"
                      data-testid="pdf-annotate-toolbar-multi"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setMultiSelectMode((v) => !v)}
                    >
                      位置合わせ
                    </button>
                    <button
                      type="button"
                      className={btn}
                      title="この文字の設定を、左の詳細設定に出す"
                      data-testid="pdf-annotate-toolbar-settings"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => openObjectSettings(obj.id)}
                    >
                      詳細設定
                    </button>
                    <button type="button" className={`${btn} text-red-600`} title="この文字を削除" aria-label="この文字を削除" onMouseDown={(e) => e.preventDefault()} onClick={() => removeObject(obj.id)}>
                      ✕
                    </button>
                  </div>
                );
              })()}

              {/* 揃える操作の帯（2つ以上選んでいるとき）。プレビューの上に重ねて出す（下の表示を押し下げると、押した位置がずれるため） */}
              {(() => {
                const ids = [activeObjectId, ...extraSelectedIds];
                const selected = pageObjects.filter((o) => ids.includes(o.id));
                if (selected.length >= 2) {
                  const bs = selected.map((o) => objectBoundsForAlign(o));
                  const top = (currentPageInfo.height - Math.max(...bs.map((b) => b.maxY))) * pageRenderScale;
                  const bottom = (currentPageInfo.height - Math.min(...bs.map((b) => b.minY))) * pageRenderScale;
                  const left = Math.min(...bs.map((b) => b.minX)) * pageRenderScale;
                  const barTop = top - 46 >= 0 ? top - 46 : Math.min(bottom + 6, Math.max(0, pageImagePixelSize.height - 46));
                  return (
                    <div
                      data-testid="pdf-annotate-align-bar"
                      className="absolute z-30 flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-blue-300 bg-white p-0.5 text-xs shadow-md dark:border-blue-800 dark:bg-neutral-800"
                      style={{ left: Math.max(0, Math.min(left, pageImagePixelSize.width - 420)), top: barTop }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="whitespace-nowrap px-1 font-semibold text-blue-800 dark:text-blue-200" data-testid="pdf-annotate-align-count">
                        {selected.length}個：
                      </span>
                      {ALIGN_ACTIONS.map((a) => (
                        <button
                          key={a.kind}
                          type="button"
                          title={a.label}
                          aria-label={a.label}
                          data-testid={`pdf-annotate-align-${a.kind}`}
                          onClick={() => alignSelected(a.kind)}
                          className="flex h-8 shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1.5 font-semibold text-neutral-700 hover:bg-blue-50 hover:text-blue-700 dark:text-neutral-200 dark:hover:bg-neutral-700"
                        >
                          <span aria-hidden="true">{a.icon}</span>
                          {a.label.replace("を揃える", "").replace("（高さ）", "").replace("左右の", "").replace("上下の", "")}
                        </button>
                      ))}
                      <button
                        type="button"
                        data-testid="pdf-annotate-align-clear"
                        title="選ぶのを1つに戻す"
                        onClick={() => {
                          setExtraSelectedIds([]);
                          setMultiSelectMode(false);
                        }}
                        className="h-8 shrink-0 whitespace-nowrap rounded px-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                      >
                        解除
                      </button>
                    </div>
                  );
                }
                if (multiSelectMode && selected.length === 1) {
                  const b = objectBoundsForAlign(selected[0]);
                  const bottom = (currentPageInfo.height - b.minY) * pageRenderScale;
                  return (
                    <p
                      className="pointer-events-none absolute z-30 max-w-[16rem] rounded-lg border border-blue-200 bg-blue-50 p-1.5 text-xs text-blue-800 shadow dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
                      style={{ left: Math.max(0, Math.min(b.minX * pageRenderScale, pageImagePixelSize.width - 260)), top: Math.min(bottom + 6, Math.max(0, pageImagePixelSize.height - 60)) }}
                      data-testid="pdf-annotate-multi-hint"
                    >
                      揃えたい注釈を押して、いっしょに選んでください（いくつでも選べます。もう一度押すと外れます）。
                    </p>
                  );
                }
                return null;
              })()}

              {/* 文字以外の注釈を選んだときの、小さな操作の帯（複製・位置合わせ・詳細設定・削除。2026-11-17・2026-11-18） */}
              {(() => {
                const obj = pageObjects.find((o) => o.id === activeObjectId);
                if (!obj || obj.type === "text" || mode === "ink" || extraSelectedIds.length > 0 || repositioningId) return null;
                const b = objectBoundsForAlign(obj);
                const top = (currentPageInfo.height - b.maxY) * pageRenderScale;
                const bottom = (currentPageInfo.height - b.minY) * pageRenderScale;
                const barTop = top - 40 >= 0 ? top - 40 : bottom + 6;
                const btn = "flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded px-2 text-xs font-semibold hover:bg-neutral-100 dark:hover:bg-neutral-700";
                return (
                  <div
                    data-testid="pdf-annotate-object-toolbar"
                    className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-neutral-300 bg-white p-0.5 text-neutral-800 shadow-md dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    style={{ left: Math.max(0, Math.min(b.minX * pageRenderScale, pageImagePixelSize.width - 300)), top: barTop }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button type="button" className={btn} data-testid="pdf-annotate-toolbar-duplicate" onClick={() => duplicateObject(obj.id)}>
                      複製
                    </button>
                    <button
                      type="button"
                      className={`${btn} ${multiSelectMode ? "bg-blue-600 text-white hover:bg-blue-700" : ""}`}
                      aria-pressed={multiSelectMode}
                      title="ほかの注釈もいくつでも選んで、位置を揃える（PCでは Shift を押しながら押しても選べます）"
                      data-testid="pdf-annotate-toolbar-multi"
                      onClick={() => setMultiSelectMode((v) => !v)}
                    >
                      位置合わせ
                    </button>
                    <button
                      type="button"
                      className={btn}
                      title="この注釈の設定を、左の詳細設定に出す"
                      data-testid="pdf-annotate-toolbar-settings"
                      onClick={() => openObjectSettings(obj.id)}
                    >
                      詳細設定
                    </button>
                    <button type="button" className={`${btn} text-red-600`} aria-label="この注釈を削除" onClick={() => removeObject(obj.id)}>
                      ✕
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>
          </div>

          {objects.length > 0 && !(fullscreen && fullscreenSettingsOpen) && (
            <div className="flex min-w-0 flex-col gap-2 lg:col-start-1 lg:row-start-2">
              {objectListContent}
            </div>
          )}
        </section>
      )}

      {file && (
        <section className="flex flex-col gap-3">
          <StepHeading n={3} as="h2">PDFを書き出してダウンロード</StepHeading>
          {objects.some(isWhiteoutObject) && (
            <p
              data-testid="pdf-whiteout-export-notice"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
            >
              白消しを含んでいます。{WHITEOUT_NOTICE.title}
              {WHITEOUT_NOTICE.body}
            </p>
          )}
          {objects.some(isBlackoutObject) && (
            <p
              data-testid="pdf-blackout-export-notice"
              className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200"
            >
              黒塗り（見た目だけ）を含んでいます。{BLACKOUT_NOTICE.title}
              {BLACKOUT_NOTICE.body}
              元のデータごと消す必要があるときは、
              {onOpenRedaction ? (
                <button type="button" onClick={onOpenRedaction} className="font-semibold underline">
                  {TRUE_REDACTION_TOOL_NAME}
                </button>
              ) : (
                <Link href={TRUE_REDACTION_TOOL_PATH} className="font-semibold underline">
                  {TRUE_REDACTION_TOOL_NAME}
                </Link>
              )}
              を使ってください。
            </p>
          )}
          <RunBar>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={status === "processing"} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              PDFを書き出す
            </button>
          </RunBar>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">手書き入力は署名欄への記入などに使えますが、法的な効力を持つ電子署名機能ではありません。</p>

          <ProcessingStatus state={status} successLabel="書き出しが完了しました" />

          {result && (
            <ResultPopup>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {result.pageCount}ページのPDFを生成しました。生成したPDFはMr.Sattoのサーバーへ保存されません。
              </p>
              <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
            </ResultPopup>
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

