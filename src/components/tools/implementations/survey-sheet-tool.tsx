"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { Segmented } from "@/components/ui/segmented";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
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

function PageSvg({ layout, index, className, testId }: { layout: LaidOutSurvey; index: number; className?: string; testId?: string }) {
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={className}
      style={{ fontFamily: `${FONT_FAMILY}, "Noto Sans JP", sans-serif` }}
      role="img"
      aria-label={`アンケート用紙 ${index + 1}ページ目`}
      data-testid={testId}
    >
      <rect x={0} y={0} width={layout.width} height={layout.height} fill="#ffffff" />
      {layout.pages[index].map((p, i) => (
        <PrimSvg key={i} p={p} />
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
  "inline-flex min-h-9 items-center justify-center gap-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";

function fmtTime(t: number) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function SurveySheetTool() {
  const [survey, setSurvey] = useState<Survey>(() => createDefaultSurvey());
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<null | "new" | { sample: TemplateId }>(null);
  /** この端末に保存するか（利用者が選んだときだけ保存する。最初は保存しない） */
  const [persist, setPersist] = useState(false);
  /** 保存をやめた（保存データを消した）ことを知らせる */
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "pdf" | "docx">(null);
  const [outputs, setOutputs] = useState<{ pdf?: { blob: Blob; pages: number }; docx?: Blob } | null>(null);
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

  const update = (patch: Partial<Survey>) => setSurvey((s) => ({ ...s, ...patch }));
  const updateDesign = (patch: Partial<SurveyDesign>) => setSurvey((s) => ({ ...s, design: { ...s.design, ...patch } }));
  const setQuestions = (fn: (qs: Question[]) => Question[]) => setSurvey((s) => ({ ...s, questions: fn(s.questions) }));

  const drag = useDragReorder(survey.questions.length, (from, to) => setQuestions((qs) => moveItem(qs, from, to)));

  function addQuestion(type: QuestionType) {
    if (survey.questions.length >= LIMITS.questions) {
      setError(`質問は${LIMITS.questions}個までです。`);
      return;
    }
    setQuestions((qs) => [...qs, newQuestion(type)]);
    setAdding(false);
    // 足した質問が見えるように、一覧の最後へスクロールする
    window.setTimeout(() => {
      const items = listRef.current?.querySelectorAll("[data-testid=survey-question]");
      items?.[items.length - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
  }

  function doConfirm() {
    if (confirm === "new") {
      const fresh = createDefaultSurvey();
      setSurvey(fresh);
      setPage(0);
    } else if (confirm && typeof confirm === "object") {
      const t = templateById(confirm.sample);
      setSurvey((s) => ({ ...s, ...t.sample(), design: applyTemplateDesign(s.design, t.id) }));
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

  const editor = (
    <div className="flex min-w-0 flex-col gap-4" data-testid="survey-editor">
      {/* アンケートの基本 */}
      <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/50">
        <input
          value={survey.title}
          onChange={(e) => update({ title: e.target.value.slice(0, LIMITS.shortText) })}
          placeholder="アンケートのタイトル"
          aria-label="アンケートのタイトル"
          className="ms-input text-lg font-bold"
          data-testid="survey-title"
        />
        <textarea
          value={survey.description}
          onChange={(e) => update({ description: e.target.value.slice(0, LIMITS.text) })}
          placeholder="説明文（アンケートの目的など）"
          aria-label="説明文"
          rows={2}
          className="ms-input ms-input-sm"
          data-testid="survey-description"
        />
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-blue-700 dark:text-blue-300">回答者への案内・注意事項（なくてもかまいません）</summary>
          <div className="mt-2 flex flex-col gap-2">
            <textarea value={survey.guide} onChange={(e) => update({ guide: e.target.value.slice(0, LIMITS.text) })} placeholder="回答者への案内（例：あてはまるものに○を付けてください）" aria-label="回答者への案内" rows={2} className="ms-input ms-input-sm" data-testid="survey-guide" />
            <textarea value={survey.notes} onChange={(e) => update({ notes: e.target.value.slice(0, LIMITS.text) })} placeholder="回答時の注意事項（例：回答は統計的に処理します）" aria-label="回答時の注意事項" rows={2} className="ms-input ms-input-sm" data-testid="survey-notes" />
          </div>
        </details>
        <details className="group" data-testid="survey-fields">
          <summary className="cursor-pointer text-sm font-medium text-blue-700 dark:text-blue-300">
            氏名・所属・回答日などの記入欄（{survey.fields.filter((f) => f.enabled).length}個を表示中）
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {survey.fields.map((f, i) => (
              <li key={f.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={(e) => update({ fields: survey.fields.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) })}
                  aria-label={`${f.label || "記入欄"}を表示`}
                  data-testid="survey-field-toggle"
                />
                <input
                  value={f.label}
                  onChange={(e) => update({ fields: survey.fields.map((x, j) => (j === i ? { ...x, label: e.target.value.slice(0, 30) } : x)) })}
                  aria-label="記入欄の項目名"
                  className="ms-input ms-input-sm min-w-0 flex-1"
                  data-testid="survey-field-label"
                />
                <button type="button" className={BTN} onClick={() => update({ fields: survey.fields.filter((_, j) => j !== i) })} aria-label={`${f.label}の欄を削除`}>
                  ×
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
      </section>

      {/* 質問 */}
      <ol ref={listRef} data-reorder-root className="flex flex-col gap-3" data-testid="survey-questions">
        {survey.questions.map((q, i) => (
          <SurveyQuestionCard
            key={q.id}
            q={q}
            index={i}
            number={numbers[i]}
            count={survey.questions.length}
            dragging={drag.draggingIndex === i}
            over={drag.overIndex === i}
            handleProps={drag.handleProps(i)}
            onChange={(nq) => setQuestions((qs) => qs.map((x) => (x.id === q.id ? nq : x)))}
            onMove={(to) => setQuestions((qs) => moveItem(qs, i, to))}
            onDuplicate={() =>
              setQuestions((qs) => (qs.length >= LIMITS.questions ? qs : [...qs.slice(0, i + 1), duplicateQuestion(q), ...qs.slice(i + 1)]))
            }
            onRemove={() => setQuestions((qs) => qs.filter((x) => x.id !== q.id))}
          />
        ))}
      </ol>
      {survey.questions.length === 0 && <p className="text-sm text-neutral-500">まだ質問がありません。「＋ 質問を追加」から追加してください。</p>}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          className="w-full rounded-xl border-2 border-dashed border-blue-300 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
          data-testid="survey-add"
        >
          ＋ 質問を追加
        </button>
        {adding && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="survey-add-menu">
            {QUESTION_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => addQuestion(t.type)}
                className="flex flex-col items-start rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left hover:border-blue-400 dark:border-neutral-800 dark:bg-neutral-900"
                data-testid={`survey-add-${t.type}`}
              >
                <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{t.label}</span>
                <span className="text-xs text-neutral-500">{t.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* デザイン */}
      <SettingsStack>
        <SettingsSection title="デザインのテンプレート" summary={templateById(survey.design.template).label} testId="survey-templates">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={survey.design.template === t.id}
                onClick={() => updateDesign(applyTemplateDesign(survey.design, t.id))}
                className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left ${
                  survey.design.template === t.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                }`}
                data-testid={`survey-template-${t.id}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ background: t.design.accent }} />
                  {t.label}
                </span>
                <span className="text-[11px] leading-snug text-neutral-500">{t.description}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">テンプレートを選んでも、質問の内容はそのままです（見た目だけが変わります）。</p>
          <button type="button" className={`${BTN} w-fit`} onClick={() => setConfirm({ sample: survey.design.template })} data-testid="survey-use-sample">
            「{templateById(survey.design.template).label}」の質問例を使う…
          </button>
        </SettingsSection>

        <SettingsSection title="用紙・レイアウト" summary={`A4${survey.design.orientation === "portrait" ? "縦" : "横"}・${survey.design.fontSize}pt`} defaultOpen={false} testId="survey-layout">
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
          <RangeRow label="タイトルの大きさ" value={survey.design.titleSize} min={12} max={32} step={1} unit="pt" onChange={(v) => updateDesign({ titleSize: v })} />
          <RangeRow label="余白" value={survey.design.margin} min={8} max={30} step={1} unit="mm" onChange={(v) => updateDesign({ margin: v })} testId="survey-margin" />
          <RangeRow label="質問と質問の間" value={survey.design.spacing} min={2} max={20} step={1} unit="mm" onChange={(v) => updateDesign({ spacing: v })} />
          <RangeRow label="記入欄の高さ" value={survey.design.answerScale} min={0.6} max={2} step={0.1} unit="倍" onChange={(v) => updateDesign({ answerScale: Math.round(v * 10) / 10 })} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              見出しのデザイン
              <select value={survey.design.headingStyle} onChange={(e) => updateDesign({ headingStyle: e.target.value as HeadingStyle })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" data-testid="survey-heading-style">
                <option value="bar">帯（色付き）</option>
                <option value="underline">下線</option>
                <option value="box">枠</option>
                <option value="plain">太字だけ</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              色
              <input type="color" value={survey.design.accent} onChange={(e) => updateDesign({ accent: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-neutral-300" aria-label="見出しの色" />
            </label>
            <label className="flex items-center gap-1.5">
              タイトル
              <select value={survey.design.titleAlign} onChange={(e) => updateDesign({ titleAlign: e.target.value as SurveyDesign["titleAlign"] })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="center">中央</option>
                <option value="left">左寄せ</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <Check label="質問に番号（Q1）" checked={survey.design.numbering} onChange={(v) => updateDesign({ numbering: v })} />
            <Check label="「必須」の印" checked={survey.design.showRequired} onChange={(v) => updateDesign({ showRequired: v })} />
            <Check label="ページ番号" checked={survey.design.pageNumbers} onChange={(v) => updateDesign({ pageNumbers: v })} testId="survey-page-numbers" />
            <Check label="記入欄に罫線" checked={survey.design.ruledLines} onChange={(v) => updateDesign({ ruledLines: v })} />
          </div>
        </SettingsSection>
      </SettingsStack>
    </div>
  );

  const preview = (
    <div className="flex flex-col gap-2" data-testid="tool-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200" data-testid="survey-page-count">
          紙のプレビュー（A4{survey.design.orientation === "portrait" ? "縦" : "横"}・全{pageCount}ページ）
        </p>
        {pageCount > 1 && (
          <div className="flex items-center gap-1" role="group" aria-label="ページの切り替え">
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
      </div>
      <div className="rounded-lg bg-neutral-200/70 p-3 dark:bg-neutral-800/70">
        <PageSvg layout={layout} index={currentPage} className="mx-auto block h-auto w-full max-w-[640px] shadow-md" testId="survey-page" />
      </div>
    </div>
  );

  const output = (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="survey-output">
      <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">書き出す・印刷する</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void makePdf()} disabled={busy !== null || survey.questions.length === 0} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="survey-make-pdf">
          {busy === "pdf" ? "PDFを作っています…" : "PDFを作る"}
        </button>
        <button type="button" onClick={() => void makeDocx()} disabled={busy !== null || survey.questions.length === 0} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50" data-testid="survey-make-docx">
          {busy === "docx" ? "Wordを作っています…" : "Wordを作る"}
        </button>
        <button type="button" onClick={() => window.print()} disabled={survey.questions.length === 0} className={BTN} data-testid="survey-print">
          印刷する
        </button>
      </div>
      {outputs?.pdf && (
        <div className="flex flex-col gap-1" data-testid="survey-pdf-ready">
          <p className="text-xs text-neutral-500">PDF（{outputs.pdf.pages}ページ）ができました。</p>
          <RewardedDownloadGate onDownload={() => downloadBlob(outputs.pdf!.blob, `${baseName}.pdf`)} label="PDFをダウンロード" />
        </div>
      )}
      {outputs?.docx && (
        <div className="flex flex-col gap-1" data-testid="survey-docx-ready">
          <p className="text-xs text-neutral-500">Word（.docx）ができました。Wordで開いて、文字や表をそのまま編集できます。</p>
          <RewardedDownloadGate onDownload={() => downloadBlob(outputs.docx!, `${baseName}.docx`)} label="Wordをダウンロード" />
        </div>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">印刷では、紙のプレビューのページだけが印刷されます（編集画面やボタンは印刷されません）。</p>
    </section>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="survey-tool" data-loaded={loaded ? "1" : "0"}>
      <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white/60 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/40 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-100">
            <input type="checkbox" checked={persist} onChange={(e) => changePersist(e.target.checked)} data-testid="survey-persist" />
            この端末に保存する（次に開いたときに続きから再開）
          </label>
          <span className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="survey-save-status" aria-live="polite">
            {persist
              ? saveFailed
                ? "このブラウザでは保存できません（ページを閉じると内容は消えます）"
                : savedAt
                  ? `この端末のブラウザに保存しました（${fmtTime(savedAt)}）。共用のパソコンでは、使い終わったらチェックを外してください（保存した内容が消えます）。`
                  : "この端末のブラウザに保存します（サーバーには送りません）。"
              : cleared
                ? "この端末に保存した内容を削除しました。いまは保存していません。"
                : "いまは保存していません（ページを閉じたり再読み込みしたりすると、内容は消えます）。サーバーには送りません。"}
          </span>
        </div>
        <button type="button" className={`${BTN} sm:ml-auto`} onClick={() => setConfirm("new")} data-testid="survey-new">
          新しいアンケート
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className={`${tab === "edit" ? "flex" : "hidden"} min-w-0 flex-col gap-4 lg:flex`}>
          {editor}
        </div>
        <div className={`${tab === "preview" ? "flex" : "hidden"} min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:flex`}>
          {preview}
        </div>
      </div>
      {/* 書き出し・印刷（編集・プレビューのどちらを表示していても使える） */}
      {output}
      <PrintPages layout={layout} />
    </div>
  );
}

function RangeRow({ label, value, min, max, step, unit, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-28 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1" aria-label={label} data-testid={testId} />
      <span className="w-14 text-right text-xs text-neutral-600 dark:text-neutral-300">
        {value}
        {unit}
      </span>
    </label>
  );
}

function Check({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
}
