"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TrashIcon } from "@/components/ui/trash-icon";
import { useDragReorder, moveItem } from "@/lib/hooks/use-drag-reorder";
import { downloadBlob, sanitizeFileName } from "@/lib/utils/format";
import {
  LIMITS,
  QUESTION_TYPES,
  TEMPLATES,
  applyTemplateDesign,
  createDefaultSurvey,
  duplicateQuestion,
  newId,
  newQuestion,
  templateById,
  type HeadingStyle,
  type Question,
  type QuestionType,
  type Survey,
  type SurveyDesign,
  type TemplateId,
} from "@/lib/survey/model";
import { PT, approxMeasure, layoutSurvey, starPoints, type LaidOutSurvey, type Measure, type Prim } from "@/lib/survey/layout";
import { clearDraft, loadDraft, saveDraft } from "@/lib/survey/storage";
import { SurveyQuestionCard } from "./survey-question-card";
import { FileIcon, PlusIcon, TypeIcon } from "./survey-icons";

/**
 * アンケート用紙作成（2026-11-17）。
 *
 * Microsoft Forms のように質問をカードで追加・編集・並べ替えし、右の紙のプレビュー（A4）で仕上がりを見ながら作る。
 * 完成したら PDF・Word で書き出すか、そのまま印刷して紙で配る（Web で回答を集める機能はない）。
 * - 作成中の内容は、この端末のブラウザの中（localStorage）に自動で保存する。サーバーへは送らない。
 * - PDF・紙のプレビューは同じ配置（src/lib/survey/layout.ts）を描く。PDF・Word の作成もブラウザの中だけで行う。
 */

const FONT_FAMILY = "MrSattoSurveyFont";
const FONT_URL = "/fonts/NotoSansJP-Regular.ttf";

/** 画面のフォント（PDFに埋め込むものと同じ Noto Sans JP）で、文字の幅を1文字ずつ測る */
function useSurveyFontMeasure(): { measure: Measure; ready: boolean } {
  const [ctx, setCtx] = useState<CanvasRenderingContext2D | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!Array.from(document.fonts).some((f) => f.family === FONT_FAMILY)) {
          const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
          document.fonts.add(await face.load());
        }
        await document.fonts.load(`16px ${FONT_FAMILY}`);
        const c = document.createElement("canvas").getContext("2d");
        if (c) c.font = `100px ${FONT_FAMILY}`;
        if (!cancelled && c) setCtx(c);
      } catch {
        // 読み込めないときは、仮の幅で配置する（PDF はフォントで測り直すので、PDF の仕上がりには影響しない）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const measure = useMemo<Measure>(() => {
    if (!ctx) return approxMeasure;
    const cache = new Map<string, number>();
    return (text, sizePt) => {
      let w = 0;
      for (const ch of text) {
        let cw = cache.get(ch);
        if (cw === undefined) {
          cw = ctx.measureText(ch).width / 100;
          cache.set(ch, cw);
        }
        w += cw;
      }
      return w * sizePt * PT;
    };
  }, [ctx]);
  return { measure, ready: ctx !== null };
}

// ---------------------------------------------------------------------------
// 紙のページ（SVG）
// ---------------------------------------------------------------------------

function PrimSvg({ p }: { p: Prim }) {
  switch (p.k) {
    case "text":
      return (
        <text
          x={p.x}
          y={p.y}
          fontSize={p.size * PT}
          fill={p.color}
          textAnchor={p.anchor ?? "start"}
          stroke={p.bold ? p.color : undefined}
          strokeWidth={p.bold ? p.size * PT * 0.035 : undefined}
          style={{ whiteSpace: "pre" }}
        >
          {p.text}
        </text>
      );
    case "line":
      return <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.color} strokeWidth={p.w} strokeDasharray={p.dash ? "0.56 0.56" : undefined} />;
    case "rect":
      return <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r ?? 0} fill={p.fill ?? "none"} stroke={p.stroke ?? "none"} strokeWidth={p.lw ?? 0.3} />;
    case "circle":
      return <circle cx={p.cx} cy={p.cy} r={p.r} fill="none" stroke={p.stroke} strokeWidth={p.lw} />;
    case "star":
      return <polygon points={starPoints(p.cx, p.cy, p.r).map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={p.stroke} strokeWidth={p.lw} strokeLinejoin="round" />;
  }
}

function PageSvg({
  layout,
  index,
  className,
  style,
  testId,
  activeId,
  onPick,
}: {
  layout: LaidOutSurvey;
  index: number;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  /** 編集中の質問（プレビューで色を付けて目立たせる） */
  activeId?: string | null;
  /** プレビューの質問を押したとき（その質問を編集する） */
  onPick?: (id: string) => void;
}) {
  const regions = onPick ? layout.regions.filter((r) => r.page === index) : [];
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={className}
      style={{ fontFamily: `${FONT_FAMILY}, "Noto Sans JP", sans-serif`, ...style }}
      role="img"
      aria-label={`アンケート用紙 ${index + 1}ページ目`}
      data-testid={testId}
    >
      <rect x={0} y={0} width={layout.width} height={layout.height} fill="#ffffff" />
      {regions
        .filter((r) => r.id === activeId)
        .map((r) => (
          <rect key={`a-${r.id}-${r.y}`} x={layout.width * 0.03} y={r.y - 1.5} width={layout.width * 0.94} height={r.h + 3} rx={1.5} fill="#2563eb" fillOpacity={0.07} stroke="#2563eb" strokeWidth={0.35} strokeDasharray="1.2 0.8" />
        ))}
      {layout.pages[index].map((p, i) => (
        <PrimSvg key={i} p={p} />
      ))}
      {regions.map((r) => (
        <rect
          key={`r-${r.id}-${r.y}`}
          x={0}
          y={r.y - 1.5}
          width={layout.width}
          height={r.h + 3}
          fill="transparent"
          style={{ cursor: "pointer" }}
          onClick={() => onPick?.(r.id)}
          data-testid="survey-preview-region"
          data-id={r.id}
        >
          <title>押すと、この質問を編集します</title>
        </rect>
      ))}
    </svg>
  );
}

/** 印刷用：紙のページだけを、ページの大きさのまま並べる（編集画面・ボタンは印刷しない） */
function PrintPages({ layout }: { layout: LaidOutSurvey }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  if (!mounted) return null;
  const portrait = layout.width < layout.height;
  return createPortal(
    <div id="survey-print-root" aria-hidden="true">
      <style>{`
        #survey-print-root { display: none; }
        @media print {
          @page { size: A4 ${portrait ? "portrait" : "landscape"}; margin: 0; }
          body > *:not(#survey-print-root) { display: none !important; }
          #survey-print-root { display: block !important; }
          #survey-print-root .survey-print-page { width: ${layout.width}mm; height: ${layout.height}mm; page-break-after: always; break-after: page; overflow: hidden; }
          #survey-print-root .survey-print-page:last-child { page-break-after: auto; break-after: auto; }
          #survey-print-root svg { width: ${layout.width}mm; height: ${layout.height}mm; display: block; }
          html, body { background: #fff !important; }
        }
      `}</style>
      {layout.pages.map((_, i) => (
        <div key={i} className="survey-print-page">
          <PageSvg layout={layout} index={i} />
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

const BTN =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";
const LINE_INPUT =
  "w-full min-w-0 border-0 border-b border-neutral-300 bg-transparent px-1 py-1.5 text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-b-2 focus:border-blue-600 dark:border-neutral-700 dark:text-neutral-100";
const ZOOMS = [100, 125, 150, 200];

function fmtTime(t: number) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function SurveySheetTool() {
  // 最初の質問の ID は固定にする（サーバーで作った画面と、ブラウザの画面が同じになるように。ID は画面の印にも使うため）
  const [survey, setSurvey] = useState<Survey>(() => {
    const s = createDefaultSurvey();
    return { ...s, questions: s.questions.map((q, i) => ({ ...q, id: `q-init-${i}` })) };
  });
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [panel, setPanel] = useState<"questions" | "design">("questions");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 質問を足す場所（null＝メニューを閉じている、数＝その位置の後ろに足す、-1＝最後に足す） */
  const [addAt, setAddAt] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<null | "new" | { sample: TemplateId }>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "pdf" | "docx">(null);
  const [outputs, setOutputs] = useState<{ pdf?: { blob: Blob; pages: number }; docx?: Blob } | null>(null);
  /** この端末に保存するか（利用者が選んだときだけ保存する。最初は保存しない） */
  const [persist, setPersist] = useState(false);
  /** 保存をやめた（保存データを消した）ことを知らせる */
  const [cleared, setCleared] = useState(false);
  const { measure } = useSurveyFontMeasure();
  const listRef = useRef<HTMLOListElement>(null);
  /** 開いてから内容を変えたか（保存していないときに、ページを閉じる前の確認を出すため） */
  const dirty = useRef(false);
  const firstSurvey = useRef(true);

  // 前回の続き（「この端末に保存する」を選んで保存した内容）があれば読み込む
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSurvey(draft.survey);
      setSavedAt(draft.savedAt);
      setRestored(true);
      setPersist(true);
    }
    setLoaded(true);
  }, []);

  // 内容を変えたかを覚える（読み込みの前の最初の状態は数えない）
  useEffect(() => {
    if (firstSurvey.current || !loaded) {
      firstSurvey.current = false;
      return;
    }
    dirty.current = true;
  }, [survey, loaded]);

  // 保存していないときは、ページを閉じる・再読み込みする前に確認を出す（入力した内容が消えるため）
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (persist || !dirty.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [persist]);

  // 「この端末に保存する」を選んでいるときだけ、自動で保存する（入力が止まってから少しあと）
  useEffect(() => {
    if (!loaded || !persist) return;
    const t = window.setTimeout(() => {
      const at = saveDraft(survey);
      if (at) {
        setSavedAt(at);
        setSaveFailed(false);
      } else setSaveFailed(true);
    }, 500);
    return () => window.clearTimeout(t);
  }, [survey, loaded, persist]);

  function changePersist(on: boolean) {
    setPersist(on);
    setCleared(false);
    if (!on) {
      // 保存をやめたら、この端末に保存した内容をすぐに消す（画面の内容はそのまま）
      clearDraft();
      setSavedAt(null);
      setSaveFailed(false);
      setRestored(false);
      setCleared(true);
    }
  }

  // 内容が変わったら、前に作った PDF・Word は使えない（古い内容をダウンロードしないように）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOutputs(null);
  }, [survey]);

  const layout = useMemo(() => layoutSurvey(survey, measure), [survey, measure]);
  const pageCount = layout.pages.length;
  const currentPage = Math.min(page, pageCount - 1);

  // 編集中の質問が載っているページを、プレビューに出す
  const activeRegionPage = activeId ? layout.regions.find((r) => r.id === activeId)?.page : undefined;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeRegionPage !== undefined) setPage(activeRegionPage);
  }, [activeRegionPage]);

  const update = (patch: Partial<Survey>) => setSurvey((s) => ({ ...s, ...patch }));
  const updateDesign = (patch: Partial<SurveyDesign>) => setSurvey((s) => ({ ...s, design: { ...s.design, ...patch } }));
  const setQuestions = (fn: (qs: Question[]) => Question[]) => setSurvey((s) => ({ ...s, questions: fn(s.questions) }));

  const drag = useDragReorder(survey.questions.length, (from, to) => setQuestions((qs) => moveItem(qs, from, to)));

  function scrollToCard(id: string) {
    window.setTimeout(() => {
      const el = listRef.current?.querySelector(`[data-qid="${id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
  }

  function addQuestion(type: QuestionType) {
    if (survey.questions.length >= LIMITS.questions) {
      setError(`質問は${LIMITS.questions}個までです。`);
      return;
    }
    const q = newQuestion(type);
    const at = addAt === null || addAt < 0 ? survey.questions.length : addAt + 1;
    setQuestions((qs) => [...qs.slice(0, at), q, ...qs.slice(at)]);
    setActiveId(q.id);
    setAddAt(null);
    scrollToCard(q.id);
  }

  function pick(id: string) {
    setActiveId(id);
    setPanel("questions");
    setTab("edit");
    scrollToCard(id);
  }

  function doConfirm() {
    if (confirm === "new") {
      setSurvey(createDefaultSurvey());
      setActiveId(null);
      setPage(0);
    } else if (confirm && typeof confirm === "object") {
      const t = templateById(confirm.sample);
      setSurvey((s) => ({ ...s, ...t.sample(), design: applyTemplateDesign(s.design, t.id) }));
      setActiveId(null);
      setPage(0);
    }
    setConfirm(null);
  }

  async function makePdf() {
    setError(null);
    setBusy("pdf");
    try {
      const { buildSurveyPdf } = await import("@/lib/survey/pdf");
      const r = await buildSurveyPdf(survey);
      setOutputs((o) => ({ ...o, pdf: { blob: r.blob, pages: r.pageCount } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFを作れませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function makeDocx() {
    setError(null);
    setBusy("docx");
    try {
      const { buildSurveyDocx } = await import("@/lib/survey/docx");
      const blob = await buildSurveyDocx(survey);
      setOutputs((o) => ({ ...o, docx: blob }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wordを作れませんでした。");
    } finally {
      setBusy(null);
    }
  }

  const baseName = sanitizeFileName(survey.title.trim() || "アンケート") || "アンケート";
  let qNo = 0;
  const numbers = survey.questions.map((q) => (q.type === "section" ? null : ++qNo));
  const noQuestions = survey.questions.length === 0;

  const addMenu = (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-2 sm:grid-cols-3 dark:border-blue-900 dark:bg-blue-950/20" data-testid="survey-add-menu" role="menu" aria-label="質問の形式を選ぶ">
      {QUESTION_TYPES.map((t) => (
        <button
          key={t.type}
          type="button"
          role="menuitem"
          onClick={() => addQuestion(t.type)}
          className="flex items-center gap-2 rounded-lg border border-transparent bg-white px-3 py-2 text-left hover:border-blue-400 dark:bg-neutral-900"
          data-testid={`survey-add-${t.type}`}
        >
          <TypeIcon type={t.type} className="h-5 w-5 shrink-0 text-blue-600" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-neutral-800 dark:text-neutral-100">{t.label}</span>
            <span className="block text-[11px] leading-tight text-neutral-500">{t.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );

  const questionsPanel = (
    <div className="flex min-w-0 flex-col gap-3" data-testid="survey-editor">
      {/* タイトル・説明（Forms のいちばん上のカード） */}
      <section className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 pt-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-2" style={{ background: survey.design.accent }} />
        <input
          value={survey.title}
          onChange={(e) => update({ title: e.target.value.slice(0, LIMITS.shortText) })}
          placeholder="アンケートのタイトル"
          aria-label="アンケートのタイトル"
          className={`${LINE_INPUT} text-2xl font-bold`}
          data-testid="survey-title"
        />
        <textarea
          value={survey.description}
          onChange={(e) => update({ description: e.target.value.slice(0, LIMITS.text) })}
          placeholder="説明（任意）"
          aria-label="説明文"
          rows={2}
          className={`${LINE_INPUT} mt-2 resize-y text-sm`}
          data-testid="survey-description"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <details className="group w-full">
            <summary className="w-fit cursor-pointer list-none rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-blue-400 hover:text-blue-700 dark:border-neutral-700 dark:text-neutral-300">
              ＋ 回答の案内・注意事項
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <textarea value={survey.guide} onChange={(e) => update({ guide: e.target.value.slice(0, LIMITS.text) })} placeholder="回答の案内（例：あてはまるものに○を付けてください）" aria-label="回答者への案内" rows={2} className={`${LINE_INPUT} text-sm`} data-testid="survey-guide" />
              <textarea value={survey.notes} onChange={(e) => update({ notes: e.target.value.slice(0, LIMITS.text) })} placeholder="注意事項（例：回答は統計的に処理します）" aria-label="回答時の注意事項" rows={2} className={`${LINE_INPUT} text-sm`} data-testid="survey-notes" />
            </div>
          </details>
          <details className="group w-full" data-testid="survey-fields">
            <summary className="w-fit cursor-pointer list-none rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-blue-400 hover:text-blue-700 dark:border-neutral-700 dark:text-neutral-300">
              ＋ 氏名・所属・回答日の記入欄（{survey.fields.filter((f) => f.enabled).length}個を表示中）
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {survey.fields.map((f, i) => (
                <li key={f.id} className="group flex items-center gap-3">
                  <Switch
                    checked={f.enabled}
                    onChange={(v) => update({ fields: survey.fields.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })}
                    label=""
                    size="sm"
                    testId="survey-field-toggle"
                  />
                  <input
                    value={f.label}
                    onChange={(e) => update({ fields: survey.fields.map((x, j) => (j === i ? { ...x, label: e.target.value.slice(0, 30) } : x)) })}
                    aria-label="記入欄の項目名"
                    className={`${LINE_INPUT} text-sm`}
                    data-testid="survey-field-label"
                  />
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                    onClick={() => update({ fields: survey.fields.filter((_, j) => j !== i) })}
                    aria-label={`${f.label}の欄を削除`}
                    title="削除"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-1.5 text-sm font-medium text-blue-700 hover:underline disabled:opacity-40 dark:text-blue-300"
              onClick={() => update({ fields: [...survey.fields, { id: newId("f"), label: "項目", enabled: true }] })}
              disabled={survey.fields.length >= LIMITS.fields}
            >
              ＋ 記入欄を追加
            </button>
          </details>
        </div>
      </section>

      {/* 質問 */}
      <ol ref={listRef} data-reorder-root className="flex flex-col gap-3" data-testid="survey-questions">
        {survey.questions.map((q, i) => (
          <Fragment key={q.id}>
            <SurveyQuestionCard
              q={q}
              index={i}
              number={numbers[i]}
              count={survey.questions.length}
              active={activeId === q.id}
              dragging={drag.draggingIndex === i}
              over={drag.overIndex === i}
              handleProps={drag.handleProps(i)}
              onActivate={() => setActiveId(q.id)}
              onChange={(nq) => setQuestions((qs) => qs.map((x) => (x.id === q.id ? nq : x)))}
              onMove={(to) => setQuestions((qs) => moveItem(qs, i, to))}
              onDuplicate={() => {
                if (survey.questions.length >= LIMITS.questions) return;
                const copy = duplicateQuestion(q);
                setQuestions((qs) => [...qs.slice(0, i + 1), copy, ...qs.slice(i + 1)]);
                setActiveId(copy.id);
              }}
              onRemove={() => {
                setQuestions((qs) => qs.filter((x) => x.id !== q.id));
                setActiveId(null);
              }}
              onInsertAfter={() => setAddAt(addAt === i ? null : i)}
            />
            {addAt === i && <li className="list-none">{addMenu}</li>}
          </Fragment>
        ))}
      </ol>
      {noQuestions && <p className="text-sm text-neutral-500">まだ質問がありません。下の「＋ 質問を追加」から追加してください。</p>}

      <button
        type="button"
        onClick={() => setAddAt(addAt === -1 ? null : -1)}
        aria-expanded={addAt === -1}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-blue-300 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
        data-testid="survey-add"
      >
        <PlusIcon className="h-5 w-5" />
        質問を追加
      </button>
      {addAt === -1 && addMenu}
    </div>
  );

  const designPanel = (
    <div className="flex min-w-0 flex-col gap-4" data-testid="survey-design">
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900" data-testid="survey-templates">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">テンプレート</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={survey.design.template === t.id}
              onClick={() => updateDesign(applyTemplateDesign(survey.design, t.id))}
              className={`overflow-hidden rounded-lg border text-left transition-shadow hover:shadow ${
                survey.design.template === t.id ? "border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900" : "border-neutral-200 dark:border-neutral-700"
              }`}
              data-testid={`survey-template-${t.id}`}
            >
              {/* 見た目の小さな見本 */}
              <span aria-hidden="true" className="block bg-white px-2 pb-1.5 pt-2">
                <span className={`mx-auto mb-1 block h-1.5 w-1/2 rounded ${t.design.titleAlign === "left" ? "!mx-0" : ""}`} style={{ background: "#333" }} />
                <span className="mb-1 block h-[3px] w-full rounded" style={{ background: t.design.headingStyle === "plain" ? "transparent" : t.design.accent }} />
                <span
                  className="block h-2.5 w-full rounded-sm"
                  style={
                    t.design.headingStyle === "bar"
                      ? { background: t.design.accent }
                      : t.design.headingStyle === "box"
                        ? { border: `1.5px solid ${t.design.accent}` }
                        : { borderBottom: `1.5px solid ${t.design.accent}` }
                  }
                />
                <span className="mt-1 block h-1 w-3/4 rounded bg-neutral-300" />
                <span className="mt-1 block h-1 w-2/3 rounded bg-neutral-300" />
              </span>
              <span className="block border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
                <span className="block text-sm font-semibold">{t.label}</span>
                <span className="block text-[11px] leading-snug text-neutral-500">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">テンプレートを選んでも、質問はそのままです（見た目だけが変わります）。</p>
        <button type="button" className={`${BTN} w-fit`} onClick={() => setConfirm({ sample: survey.design.template })} data-testid="survey-use-sample">
          「{templateById(survey.design.template).label}」の質問例を使う…
        </button>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900" data-testid="survey-layout">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">用紙とレイアウト</p>
        <Segmented
          value={survey.design.orientation}
          onChange={(v) => updateDesign({ orientation: v })}
          label="用紙"
          size="sm"
          testId="survey-orientation"
          options={[
            { value: "portrait", label: "A4縦" },
            { value: "landscape", label: "A4横" },
          ]}
        />
        <RangeRow label="文字の大きさ" value={survey.design.fontSize} min={8} max={16} step={0.5} unit="pt" onChange={(v) => updateDesign({ fontSize: v })} testId="survey-font-size" />
        <RangeRow label="タイトル" value={survey.design.titleSize} min={12} max={32} step={1} unit="pt" onChange={(v) => updateDesign({ titleSize: v })} />
        <RangeRow label="余白" value={survey.design.margin} min={8} max={30} step={1} unit="mm" onChange={(v) => updateDesign({ margin: v })} testId="survey-margin" />
        <RangeRow label="質問の間" value={survey.design.spacing} min={2} max={20} step={1} unit="mm" onChange={(v) => updateDesign({ spacing: v })} />
        <RangeRow label="記入欄の高さ" value={survey.design.answerScale} min={0.6} max={2} step={0.1} unit="倍" onChange={(v) => updateDesign({ answerScale: Math.round(v * 10) / 10 })} />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Segmented
            value={survey.design.headingStyle}
            onChange={(v: HeadingStyle) => updateDesign({ headingStyle: v })}
            label="見出し"
            size="sm"
            testId="survey-heading-style"
            options={[
              { value: "bar", label: "帯" },
              { value: "underline", label: "下線" },
              { value: "box", label: "枠" },
              { value: "plain", label: "太字" },
            ]}
          />
          <label className="flex items-center gap-1.5">
            色
            <input type="color" value={survey.design.accent} onChange={(e) => updateDesign({ accent: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-neutral-300" aria-label="見出しの色" />
          </label>
          <Segmented
            value={survey.design.titleAlign}
            onChange={(v: SurveyDesign["titleAlign"]) => updateDesign({ titleAlign: v })}
            label="タイトルの位置"
            size="sm"
            options={[
              { value: "center", label: "中央" },
              { value: "left", label: "左" },
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Switch checked={survey.design.numbering} onChange={(v) => updateDesign({ numbering: v })} label="質問の番号（Q1）" size="sm" />
          <Switch checked={survey.design.showRequired} onChange={(v) => updateDesign({ showRequired: v })} label="「必須」の印" size="sm" />
          <Switch checked={survey.design.pageNumbers} onChange={(v) => updateDesign({ pageNumbers: v })} label="ページ番号" size="sm" testId="survey-page-numbers" />
          <Switch checked={survey.design.ruledLines} onChange={(v) => updateDesign({ ruledLines: v })} label="記入欄の罫線" size="sm" />
        </div>
      </section>
    </div>
  );

  const preview = (
    <div className="flex flex-col gap-2" data-testid="tool-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200" data-testid="survey-page-count">
          紙のプレビュー（A4{survey.design.orientation === "portrait" ? "縦" : "横"}・全{pageCount}ページ）
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="プレビューの大きさ">
          <button type="button" className={`${BTN} !px-2.5`} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])} disabled={zoom === ZOOMS[0]} aria-label="縮小">
            −
          </button>
          <span className="w-12 text-center text-xs text-neutral-600 dark:text-neutral-300" data-testid="survey-zoom">
            {zoom}%
          </span>
          <button type="button" className={`${BTN} !px-2.5`} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])} disabled={zoom === ZOOMS[ZOOMS.length - 1]} aria-label="拡大" data-testid="survey-zoom-in">
            ＋
          </button>
        </div>
      </div>
      <div className="max-h-[78vh] overflow-auto rounded-lg bg-neutral-200/70 p-3 dark:bg-neutral-800/70" data-testid="survey-preview-scroll">
        <PageSvg
          layout={layout}
          index={currentPage}
          className="mx-auto block h-auto shadow-md"
          style={{ width: `${zoom}%`, maxWidth: zoom === 100 ? 640 : undefined }}
          testId="survey-page"
          activeId={activeId}
          onPick={pick}
        />
      </div>
      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-1" role="group" aria-label="ページの切り替え">
          <button type="button" className={BTN} onClick={() => setPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0} aria-label="前のページ">
            ‹
          </button>
          {layout.pages.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`${BTN} ${i === currentPage ? "!border-blue-500 !bg-blue-600 !text-white" : ""}`}
              onClick={() => setPage(i)}
              aria-current={i === currentPage ? "page" : undefined}
              data-testid="survey-page-button"
            >
              {i + 1}
            </button>
          ))}
          <button type="button" className={BTN} onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))} disabled={currentPage === pageCount - 1} aria-label="次のページ">
            ›
          </button>
        </div>
      )}
      <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">プレビューの質問を押すと、その質問を編集できます。</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="survey-tool" data-loaded={loaded ? "1" : "0"}>
      {/* 上の操作：質問・デザインの切り替えと、書き出し・印刷 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white/80 p-2 shadow-sm dark:border-neutral-800 dark:bg-neutral-900/70" data-testid="survey-toolbar">
        <Segmented
          value={panel}
          onChange={(v) => {
            setPanel(v);
            setTab("edit");
          }}
          ariaLabel="編集する内容"
          testId="survey-panel"
          options={[
            { value: "questions", label: "質問" },
            { value: "design", label: "デザイン" },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-1.5" data-testid="survey-output">
          <button type="button" onClick={() => void makePdf()} disabled={busy !== null || noQuestions} className={BTN} data-testid="survey-make-pdf" title="PDFを作る">
            <FileIcon kind="pdf" />
            {busy === "pdf" ? "作成中…" : "PDF"}
          </button>
          <button type="button" onClick={() => void makeDocx()} disabled={busy !== null || noQuestions} className={BTN} data-testid="survey-make-docx" title="Wordを作る">
            <FileIcon kind="word" />
            {busy === "docx" ? "作成中…" : "Word"}
          </button>
          <button type="button" onClick={() => window.print()} disabled={noQuestions} className={BTN} data-testid="survey-print" title="印刷する（紙のページだけが印刷されます）">
            <FileIcon kind="print" />
            印刷
          </button>
        </div>
      </div>

      {(outputs?.pdf || outputs?.docx) && (
        <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
          {outputs?.pdf && (
            <div className="flex flex-col gap-1" data-testid="survey-pdf-ready">
              <p className="text-xs text-neutral-600 dark:text-neutral-300">PDF（{outputs.pdf.pages}ページ）ができました。</p>
              <RewardedDownloadGate onDownload={() => downloadBlob(outputs.pdf!.blob, `${baseName}.pdf`)} label="PDFをダウンロード" />
            </div>
          )}
          {outputs?.docx && (
            <div className="flex flex-col gap-1" data-testid="survey-docx-ready">
              <p className="text-xs text-neutral-600 dark:text-neutral-300">Word（.docx）ができました。Wordで開いて、文字や表をそのまま書き直せます。</p>
              <RewardedDownloadGate onDownload={() => downloadBlob(outputs.docx!, `${baseName}.docx`)} label="Wordをダウンロード" />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <Switch checked={persist} onChange={changePersist} label="この端末に保存する" size="sm" testId="survey-persist" />
        <span className="min-w-0 flex-1 text-xs text-neutral-500 dark:text-neutral-400" data-testid="survey-save-status" aria-live="polite">
          {persist
            ? saveFailed
              ? "このブラウザでは保存できません（ページを閉じると内容は消えます）"
              : savedAt
                ? `保存しました（${fmtTime(savedAt)}）。共用のパソコンでは、使い終わったらオフにしてください（保存した内容が消えます）。`
                : "この端末のブラウザに保存します（サーバーには送りません）。"
            : cleared
              ? "この端末に保存した内容を削除しました。いまは保存していません。"
              : "保存していません（閉じたり再読み込みしたりすると消えます）。オンにすると、次に開いたとき続きから再開できます。"}
        </span>
        <button type="button" className="text-xs text-neutral-500 underline-offset-2 hover:text-blue-700 hover:underline" onClick={() => setConfirm("new")} data-testid="survey-new">
          新しいアンケートを作る
        </button>
      </div>

      {restored && (
        <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200" data-testid="survey-restored">
          この端末に保存した前回の続きから表示しています。
        </p>
      )}
      {confirm && (
        <div role="alertdialog" aria-label="確認" className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="survey-confirm">
          <p>
            {confirm === "new"
              ? "いまのアンケートを閉じて、新しいアンケートを作りますか？（いまの内容は消えます）"
              : `「${templateById(confirm.sample).label}」の質問例に入れ替えますか？いまのタイトル・質問は、質問例に置き換わります。`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700" onClick={doConfirm} data-testid="survey-confirm-yes">
              入れ替える
            </button>
            <button type="button" className={BTN} onClick={() => setConfirm(null)} data-testid="survey-confirm-no">
              やめる
            </button>
          </div>
        </div>
      )}
      {error && <ErrorMessage message={error} testId="survey-error" />}

      {/* 狭い画面：編集とプレビューを切り替える */}
      <div className="lg:hidden">
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="表示の切り替え"
          testId="survey-tabs"
          wide
          options={[
            { value: "edit", label: "編集" },
            { value: "preview", label: `プレビュー（${pageCount}ページ）` },
          ]}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
        <div className={`${tab === "edit" ? "flex" : "hidden"} min-w-0 flex-col gap-4 lg:flex`}>{panel === "questions" ? questionsPanel : designPanel}</div>
        <div className={`${tab === "preview" ? "flex" : "hidden"} min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:flex`}>{preview}</div>
      </div>
      <PrintPages layout={layout} />
    </div>
  );
}

function RangeRow({ label, value, min, max, step, unit, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-neutral-700 dark:text-neutral-200">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 accent-blue-600" aria-label={label} data-testid={testId} />
      <span className="w-14 shrink-0 text-right text-xs text-neutral-600 dark:text-neutral-300">
        {value}
        {unit}
      </span>
    </label>
  );
}
