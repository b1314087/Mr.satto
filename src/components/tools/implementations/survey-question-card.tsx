"use client";

import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TrashIcon } from "@/components/ui/trash-icon";
import { useDragReorder, moveItem } from "@/lib/hooks/use-drag-reorder";
import { LIMITS, QUESTION_TYPES, SCALE_PRESETS, TYPE_LABEL, changeType, type Question, type QuestionType } from "@/lib/survey/model";
import { ChevronIcon, CopyIcon, DragIcon, PlusIcon, TypeIcon } from "./survey-icons";

/**
 * アンケート用紙作成の「質問カード」（Microsoft Forms のような操作。2026-11-17 改修）。
 * - 編集中のカードだけを開き、ほかのカードは「Q2 質問文」と答え方の要約だけを1〜2行で見せる（押すと開く）。
 * - 操作はアイコン（⋮⋮ で並べ替え・複製・ゴミ箱）にして、文字のボタンを減らす。
 * - 選択肢は、用紙と同じ「○ 満足」の形で並べる。○・□ は飾りで押せない（用紙で回答者が印を付ける場所）ことを、上の一文で知らせる。
 */

const ICON_BTN =
  "ms-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";
const LINE_INPUT =
  "w-full min-w-0 border-0 border-b border-neutral-300 bg-transparent px-1 py-1.5 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-b-2 focus:border-blue-600 dark:border-neutral-700 dark:text-neutral-100";

/** 用紙での印（○・□）。押せない飾り */
function PaperMark({ type }: { type: "single" | "multiple" }) {
  return (
    <span aria-hidden="true" className={`inline-block h-4 w-4 shrink-0 border-2 border-neutral-400 align-middle ${type === "single" ? "rounded-full" : "rounded-[3px]"}`} />
  );
}

function summary(q: Question): string {
  switch (q.type) {
    case "single":
    case "multiple":
      return [...q.options.filter((o) => o.trim()), ...(q.other ? ["その他"] : [])].join(" / ");
    case "scale":
      return q.scale.filter((s) => s.trim()).join(" / ");
    case "rating":
      return `${q.ratingStyle === "star" ? "★".repeat(q.ratingMax) : Array.from({ length: q.ratingMax }, (_, i) => i + 1).join(" ")}`;
    case "long":
      return `記入欄 ${q.lines}行`;
    case "number":
      return `数値を記入${q.unit ? `（${q.unit}）` : ""}`;
    case "date":
      return "＿年＿月＿日";
    case "short":
      return "1行の記入欄";
    case "section":
      return q.description.trim() || "見出し";
  }
}

/** 選択肢・段階の一覧（行のドラッグ・ゴミ箱・追加）。Alt＋↑↓ キーでも並べ替えられる */
function ItemList({
  items,
  onChange,
  mark,
  addLabel,
  min,
  max,
  testIds,
  extra,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  mark: (i: number) => ReactNode;
  addLabel: string;
  min: number;
  max: number;
  testIds: { item: string; remove: string; add: string };
  extra?: ReactNode;
}) {
  const drag = useDragReorder(items.length, (from, to) => onChange(moveItem(items, from, to)), { root: "data-item-root", item: "data-item-index" });
  const onKey = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onChange(moveItem(items, i, e.key === "ArrowUp" ? i - 1 : i + 1));
  };
  return (
    <div className="flex flex-col" data-item-root>
      {items.map((o, i) => (
        <div
          key={i}
          data-item-index={i}
          className={`group flex items-center gap-2 rounded-md py-0.5 ${drag.draggingIndex === i ? "bg-blue-50 opacity-70 dark:bg-blue-950/30" : ""} ${drag.overIndex === i && drag.draggingIndex !== i ? "ring-1 ring-blue-300" : ""}`}
        >
          <span
            {...drag.handleProps(i)}
            aria-label={`${i + 1}番目をドラッグして並べ替え`}
            title="ドラッグして並べ替え"
            className="flex h-8 w-5 shrink-0 items-center justify-center text-neutral-300 hover:text-neutral-600 dark:text-neutral-600"
          >
            <DragIcon className="h-4 w-4" />
          </span>
          {mark(i)}
          <input
            value={o}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value.slice(0, LIMITS.shortText) : x)))}
            onKeyDown={(e) => onKey(e, i)}
            aria-label={`${i + 1}番目`}
            className={LINE_INPUT}
            data-testid={testIds.item}
          />
          <button
            type="button"
            className={`${ICON_BTN} h-8 w-8 sm:opacity-0 sm:focus:opacity-100 sm:group-hover:opacity-100`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            disabled={items.length <= min}
            aria-label={`${i + 1}番目を削除`}
            title="削除"
            data-testid={testIds.remove}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
      {extra}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-7 text-sm">
        <button
          type="button"
          className="font-medium text-blue-700 hover:underline disabled:opacity-40 dark:text-blue-300"
          onClick={() => onChange([...items, `${addLabel}${items.length + 1}`])}
          disabled={items.length >= max}
          data-testid={testIds.add}
        >
          ＋ {addLabel}を追加
        </button>
      </div>
    </div>
  );
}

export function SurveyQuestionCard({
  q,
  index,
  number,
  count,
  active,
  dragging,
  over,
  handleProps,
  onActivate,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onInsertAfter,
}: {
  q: Question;
  index: number;
  /** 質問の番号（セクションは null） */
  number: number | null;
  count: number;
  active: boolean;
  dragging: boolean;
  over: boolean;
  handleProps: HTMLAttributes<HTMLElement>;
  onActivate: () => void;
  onChange: (q: Question) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onInsertAfter: () => void;
}) {
  const set = (patch: Partial<Question>) => onChange({ ...q, ...patch });
  const isChoice = q.type === "single" || q.type === "multiple";
  const isSection = q.type === "section";
  const label = isSection ? "見出し" : `Q${number}`;

  const handle = (
    <span
      {...handleProps}
      role="button"
      tabIndex={-1}
      aria-label="ドラッグして並べ替え"
      title="ドラッグして並べ替え"
      className="flex h-9 w-6 shrink-0 items-center justify-center text-neutral-300 hover:text-neutral-600 dark:text-neutral-600"
      data-testid="survey-question-drag"
    >
      <DragIcon className="h-5 w-5" />
    </span>
  );

  return (
    <li
      data-reorder-index={index}
      data-testid="survey-question"
      data-qid={q.id}
      data-type={q.type}
      data-active={active ? "1" : "0"}
      className={`relative rounded-xl border bg-white shadow-sm transition-shadow dark:bg-neutral-900 ${
        active ? "border-neutral-200 shadow-md dark:border-neutral-700" : "border-neutral-200 hover:shadow dark:border-neutral-800"
      } ${dragging ? "opacity-60 shadow-lg" : ""} ${over && !dragging ? "ring-2 ring-blue-300" : ""}`}
    >
      {/* 編集中の目印（左の青い線） */}
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5 rounded-l-xl bg-blue-600" />}

      {!active ? (
        <div className="flex items-start gap-1 py-2 pl-1 pr-3">
          {handle}
          <button type="button" onClick={onActivate} className="ms-focus-ring flex min-w-0 flex-1 items-start gap-2 rounded-lg py-1.5 text-left" data-testid="survey-question-open">
            <span className={`shrink-0 text-sm font-semibold ${isSection ? "text-neutral-500" : "text-blue-700 dark:text-blue-300"}`}>{label}</span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm ${isSection ? "font-bold" : "font-medium"} text-neutral-900 dark:text-neutral-100`}>
                {q.title.trim() || (isSection ? "（見出し）" : "（質問文）")}
                {q.required && <span className="ml-1.5 align-middle text-xs text-red-600">必須</span>}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-neutral-500">
                <TypeIcon type={q.type} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{summary(q)}</span>
              </span>
            </span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-3 pl-4 pr-3 sm:pl-5">
          <div className="flex flex-wrap items-start gap-2">
            <div className="-ml-2 flex items-center">{handle}</div>
            <span className={`pt-2 text-sm font-semibold ${isSection ? "text-neutral-500" : "text-blue-700 dark:text-blue-300"}`}>{label}</span>
            <input
              value={q.title}
              onChange={(e) => set({ title: e.target.value.slice(0, LIMITS.text) })}
              placeholder={isSection ? "見出し（例：サービスについて）" : "質問文"}
              aria-label={isSection ? "見出し" : "質問文"}
              className={`${LINE_INPUT} min-w-[12rem] flex-1 !text-base font-medium`}
              data-testid="survey-question-title"
              autoFocus={q.title === ""}
            />
            <label className="flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
              <TypeIcon type={q.type} className="h-4 w-4 text-neutral-600 dark:text-neutral-300" />
              <span className="sr-only">質問の形式</span>
              <select
                value={q.type}
                onChange={(e) => onChange(changeType(q, e.target.value as QuestionType))}
                aria-label="質問の形式"
                className="bg-transparent py-0.5 outline-none"
                data-testid="survey-question-type"
              >
                {QUESTION_TYPES.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            value={q.description}
            onChange={(e) => set({ description: e.target.value.slice(0, LIMITS.text) })}
            placeholder="説明（任意）"
            aria-label={isSection ? "見出しの説明" : "質問の説明"}
            className={`${LINE_INPUT} !text-xs text-neutral-600`}
          />

          {isChoice && (
            <div className="flex flex-col gap-1" data-testid="survey-options">
              <p className="rounded-md bg-neutral-50 px-2 py-1 text-xs leading-relaxed text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400 [&>span]:align-middle" data-testid="survey-options-hint">
                <span aria-hidden="true" className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-neutral-300 text-[10px] font-bold text-white dark:bg-neutral-600">i</span>
                {q.type === "single" ? (
                  <>
                    印刷した用紙で、回答者が <PaperMark type="single" /> に丸を付けて答えます（1つだけ）。ここでは押せません。
                  </>
                ) : (
                  <>
                    印刷した用紙で、回答者が <PaperMark type="multiple" /> に✓を付けて答えます（いくつでも）。ここでは押せません。
                  </>
                )}
              </p>
              <ItemList
                items={q.options}
                onChange={(options) => set({ options })}
                mark={() => <PaperMark type={q.type as "single" | "multiple"} />}
                addLabel="選択肢"
                min={1}
                max={LIMITS.options}
                testIds={{ item: "survey-option", remove: "survey-option-remove", add: "survey-option-add" }}
                extra={
                  q.other ? (
                    <div className="group flex items-center gap-2 py-0.5">
                      <span className="w-5 shrink-0" />
                      <PaperMark type={q.type as "single" | "multiple"} />
                      <span className="flex-1 border-b border-dashed border-neutral-300 px-1 py-1.5 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">その他（　　　　　　）</span>
                      <button type="button" className={`${ICON_BTN} h-8 w-8`} onClick={() => set({ other: false })} aria-label="「その他」を削除" title="削除" data-testid="survey-other-remove">
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ) : null
                }
              />
              {!q.other && (
                <button type="button" className="w-fit pl-7 text-sm text-neutral-500 hover:text-blue-700 hover:underline" onClick={() => set({ other: true })} data-testid="survey-other-add">
                  ＋「その他（自由記入）」を追加
                </button>
              )}
            </div>
          )}

          {q.type === "scale" && (
            <div className="flex flex-col gap-1" data-testid="survey-scale">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">用紙では、段階の名前の下に ○ が並び、回答者が1つに丸を付けます</p>
              <ItemList
                items={q.scale}
                onChange={(scale) => set({ scale })}
                mark={(i) => <span className="w-4 shrink-0 text-center text-xs text-neutral-400">{i + 1}</span>}
                addLabel="段階"
                min={2}
                max={LIMITS.scale}
                testIds={{ item: "survey-scale-item", remove: "survey-scale-remove", add: "survey-scale-add" }}
              />
              <select
                value=""
                onChange={(e) => {
                  const p = SCALE_PRESETS[Number(e.target.value)];
                  if (p) set({ scale: [...p.values] });
                }}
                aria-label="段階のひな形"
                className="ml-7 w-fit rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">ひな形から選ぶ…</option>
                {SCALE_PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {q.type === "rating" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-lg text-neutral-400" aria-hidden="true">
                {q.ratingLow && <span className="text-xs">{q.ratingLow}</span>}
                {Array.from({ length: q.ratingMax }, (_, i) =>
                  q.ratingStyle === "star" ? (
                    <span key={i}>☆</span>
                  ) : (
                    <span key={i} className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-xs">
                      {i + 1}
                    </span>
                  ),
                )}
                {q.ratingHigh && <span className="text-xs">{q.ratingHigh}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  value={q.ratingStyle}
                  onChange={(v) => set({ ratingStyle: v })}
                  ariaLabel="評価の表し方"
                  size="sm"
                  testId="survey-rating-style"
                  options={[
                    { value: "star", label: "★ 星" },
                    { value: "number", label: "① 数字" },
                  ]}
                />
                <label className="flex items-center gap-1.5 text-sm">
                  段階
                  <select value={q.ratingMax} onChange={(e) => set({ ratingMax: Number(e.target.value) })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                    {[3, 4, 5, 6, 7, 10].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <input value={q.ratingLow} onChange={(e) => set({ ratingLow: e.target.value.slice(0, 40) })} placeholder="左の言葉（例：不満）" aria-label="左の言葉" className={`${LINE_INPUT} !w-40`} />
                <input value={q.ratingHigh} onChange={(e) => set({ ratingHigh: e.target.value.slice(0, 40) })} placeholder="右の言葉（例：満足）" aria-label="右の言葉" className={`${LINE_INPUT} !w-40`} />
              </div>
            </div>
          )}

          {q.type === "long" && (
            <div className="flex flex-col gap-2">
              <div aria-hidden="true" className="rounded-md border border-neutral-300 dark:border-neutral-700" style={{ height: `${Math.min(10, q.lines) * 0.9 + 0.6}rem` }} />
              <div className="flex items-center gap-2 text-sm">
                記入欄の高さ
                <button type="button" className={`${ICON_BTN} h-8 w-8 border border-neutral-300 dark:border-neutral-700`} onClick={() => set({ lines: Math.max(1, q.lines - 1) })} disabled={q.lines <= 1} aria-label="記入欄を低くする">
                  −
                </button>
                <span className="w-10 text-center" data-testid="survey-long-lines">
                  {q.lines}行
                </span>
                <button type="button" className={`${ICON_BTN} h-8 w-8 border border-neutral-300 dark:border-neutral-700`} onClick={() => set({ lines: Math.min(LIMITS.lines, q.lines + 1) })} disabled={q.lines >= LIMITS.lines} aria-label="記入欄を高くする" data-testid="survey-long-more">
                  ＋
                </button>
              </div>
            </div>
          )}

          {(q.type === "short" || q.type === "number") && (
            <div className="flex flex-wrap items-center gap-3">
              <div aria-hidden="true" className={`h-6 border-b border-neutral-400 ${q.width === "short" ? "w-24" : q.width === "medium" ? "w-48" : "w-full max-w-sm"}`} />
              <Segmented
                value={q.width}
                onChange={(v) => set({ width: v })}
                ariaLabel="記入欄の長さ"
                size="sm"
                options={[
                  { value: "short", label: "短い" },
                  { value: "medium", label: "ふつう" },
                  { value: "full", label: "長い" },
                ]}
              />
              {q.type === "number" && (
                <input value={q.unit} onChange={(e) => set({ unit: e.target.value.slice(0, 20) })} placeholder="単位（歳・人・回）" aria-label="単位" className={`${LINE_INPUT} !w-36`} data-testid="survey-number-unit" />
              )}
            </div>
          )}

          {q.type === "date" && (
            <Segmented
              value={q.dateStyle}
              onChange={(v) => set({ dateStyle: v })}
              ariaLabel="日付の書き方"
              size="sm"
              options={[
                { value: "ymd", label: "＿年＿月＿日" },
                { value: "wareki", label: "元号を書く欄も付ける" },
              ]}
            />
          )}

          {/* 下の操作：設定のスイッチ（左）とアイコン（右） */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            {!isSection && <Switch checked={q.required} onChange={(v) => set({ required: v })} label="必須" size="sm" testId="survey-question-required" />}
            {isChoice && <Switch checked={q.direction === "horizontal"} onChange={(v) => set({ direction: v ? "horizontal" : "vertical" })} label="横に並べる" size="sm" testId="survey-question-direction" />}
            <div className="ml-auto flex items-center">
              <button type="button" className={ICON_BTN} onClick={() => onMove(index - 1)} disabled={index === 0} aria-label="上へ移動" title="上へ移動" data-testid="survey-question-up">
                <ChevronIcon dir="up" />
              </button>
              <button type="button" className={ICON_BTN} onClick={() => onMove(index + 1)} disabled={index === count - 1} aria-label="下へ移動" title="下へ移動" data-testid="survey-question-down">
                <ChevronIcon dir="down" />
              </button>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
              <button type="button" className={ICON_BTN} onClick={onInsertAfter} aria-label="この下に質問を追加" title="この下に質問を追加" data-testid="survey-question-insert">
                <PlusIcon />
              </button>
              <button type="button" className={ICON_BTN} onClick={onDuplicate} aria-label="複製" title="複製" data-testid="survey-question-duplicate">
                <CopyIcon />
              </button>
              <button type="button" className={`${ICON_BTN} hover:!text-red-600`} onClick={onRemove} aria-label="削除" title="削除" data-testid="survey-question-remove">
                <TrashIcon className="h-[18px] w-[18px]" />
              </button>
            </div>
          </div>
          <span className="sr-only">{TYPE_LABEL[q.type]}</span>
        </div>
      )}
    </li>
  );
}
