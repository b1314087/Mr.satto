"use client";

import type { HTMLAttributes } from "react";
import { LIMITS, QUESTION_TYPES, SCALE_PRESETS, TYPE_LABEL, changeType, type Question, type QuestionType } from "@/lib/survey/model";

/**
 * アンケート用紙作成の「質問カード」（1つの質問の編集）。
 * 質問文・形式・必須・説明・選択肢など、形式ごとの設定をここで編集する。並べ替え・複製・削除のボタンも持つ。
 */

const INPUT = "ms-input ms-input-sm";
const SMALL_BTN =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-neutral-300 bg-white px-2 text-xs text-neutral-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";

function moveIn<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

export function SurveyQuestionCard({
  q,
  index,
  number,
  count,
  dragging,
  over,
  handleProps,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  q: Question;
  index: number;
  /** 質問の番号（セクションは null） */
  number: number | null;
  count: number;
  dragging: boolean;
  over: boolean;
  handleProps: HTMLAttributes<HTMLElement>;
  onChange: (q: Question) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<Question>) => onChange({ ...q, ...patch });
  const isChoice = q.type === "single" || q.type === "multiple";
  const isSection = q.type === "section";

  return (
    <li
      data-reorder-index={index}
      data-testid="survey-question"
      data-type={q.type}
      className={`rounded-xl border bg-white/80 p-3 shadow-sm transition-shadow dark:bg-neutral-900/70 ${
        isSection ? "border-l-4 border-l-blue-500" : ""
      } ${dragging ? "opacity-60 shadow-lg" : ""} ${over && !dragging ? "border-blue-400" : "border-neutral-200 dark:border-neutral-800"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          {...handleProps}
          role="button"
          tabIndex={-1}
          aria-label="ドラッグして並べ替え"
          title="ドラッグして並べ替え"
          className="select-none px-1 text-lg leading-none text-neutral-400 hover:text-neutral-700"
          data-testid="survey-question-drag"
        >
          ⋮⋮
        </span>
        <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">{isSection ? "セクション" : `Q${number}`}</span>
        <select
          value={q.type}
          onChange={(e) => onChange(changeType(q, e.target.value as QuestionType))}
          aria-label="質問の形式"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          data-testid="survey-question-type"
        >
          {QUESTION_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className={SMALL_BTN} onClick={() => onMove(index - 1)} disabled={index === 0} aria-label="上へ移動" data-testid="survey-question-up">
            ↑
          </button>
          <button type="button" className={SMALL_BTN} onClick={() => onMove(index + 1)} disabled={index === count - 1} aria-label="下へ移動" data-testid="survey-question-down">
            ↓
          </button>
          <button type="button" className={SMALL_BTN} onClick={onDuplicate} aria-label="複製" title="複製" data-testid="survey-question-duplicate">
            複製
          </button>
          <button type="button" className={`${SMALL_BTN} hover:!border-red-400 hover:!text-red-700`} onClick={onRemove} aria-label="削除" title="削除" data-testid="survey-question-remove">
            削除
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        <input
          value={q.title}
          onChange={(e) => set({ title: e.target.value.slice(0, LIMITS.text) })}
          placeholder={isSection ? "見出し（例：サービスについて）" : "質問文"}
          aria-label={isSection ? "見出し" : "質問文"}
          className={`${INPUT} font-medium`}
          data-testid="survey-question-title"
        />
        <textarea
          value={q.description}
          onChange={(e) => set({ description: e.target.value.slice(0, LIMITS.text) })}
          placeholder={isSection ? "説明文（なくてもかまいません）" : "質問の説明（なくてもかまいません）"}
          aria-label={isSection ? "セクションの説明文" : "質問の説明"}
          rows={1}
          className={`${INPUT} min-h-9 text-xs`}
        />

        {isChoice && (
          <div className="flex flex-col gap-1.5" data-testid="survey-options">
            {q.options.map((o, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="w-4 text-center text-neutral-500">
                  {q.type === "single" ? "○" : "□"}
                </span>
                <input
                  value={o}
                  onChange={(e) => set({ options: q.options.map((x, j) => (j === i ? e.target.value.slice(0, LIMITS.shortText) : x)) })}
                  aria-label={`選択肢${i + 1}`}
                  className={`${INPUT} min-w-0 flex-1`}
                  data-testid="survey-option"
                />
                <button type="button" className={SMALL_BTN} onClick={() => set({ options: moveIn(q.options, i, i - 1) })} disabled={i === 0} aria-label={`選択肢${i + 1}を上へ`}>
                  ↑
                </button>
                <button type="button" className={SMALL_BTN} onClick={() => set({ options: moveIn(q.options, i, i + 1) })} disabled={i === q.options.length - 1} aria-label={`選択肢${i + 1}を下へ`}>
                  ↓
                </button>
                <button
                  type="button"
                  className={SMALL_BTN}
                  onClick={() => set({ options: q.options.filter((_, j) => j !== i) })}
                  disabled={q.options.length <= 1}
                  aria-label={`選択肢${i + 1}を削除`}
                  data-testid="survey-option-remove"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="text-sm font-medium text-blue-700 hover:underline disabled:opacity-40 dark:text-blue-300"
                onClick={() => set({ options: [...q.options, `選択肢${q.options.length + 1}`] })}
                disabled={q.options.length >= LIMITS.options}
                data-testid="survey-option-add"
              >
                ＋ 選択肢を追加
              </button>
              <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                <input type="checkbox" checked={q.other} onChange={(e) => set({ other: e.target.checked })} />
                「その他（　）」を付ける
              </label>
            </div>
          </div>
        )}

        {q.type === "scale" && (
          <div className="flex flex-col gap-1.5" data-testid="survey-scale">
            {q.scale.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-4 text-center text-xs text-neutral-500">{i + 1}</span>
                <input value={s} onChange={(e) => set({ scale: q.scale.map((x, j) => (j === i ? e.target.value.slice(0, LIMITS.shortText) : x)) })} aria-label={`段階${i + 1}`} className={`${INPUT} min-w-0 flex-1`} />
                <button type="button" className={SMALL_BTN} onClick={() => set({ scale: q.scale.filter((_, j) => j !== i) })} disabled={q.scale.length <= 2} aria-label={`段階${i + 1}を削除`}>
                  ×
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="text-sm font-medium text-blue-700 hover:underline disabled:opacity-40 dark:text-blue-300" onClick={() => set({ scale: [...q.scale, "段階"] })} disabled={q.scale.length >= LIMITS.scale}>
                ＋ 段階を追加
              </button>
              <select
                value=""
                onChange={(e) => {
                  const p = SCALE_PRESETS[Number(e.target.value)];
                  if (p) set({ scale: [...p.values] });
                }}
                aria-label="段階のひな形"
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">ひな形から選ぶ…</option>
                {SCALE_PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {q.type === "rating" && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              表し方
              <select value={q.ratingStyle} onChange={(e) => set({ ratingStyle: e.target.value as Question["ratingStyle"] })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" data-testid="survey-rating-style">
                <option value="star">★ 星</option>
                <option value="number">① 数字</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              段階
              <select value={q.ratingMax} onChange={(e) => set({ ratingMax: Number(e.target.value) })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                {[3, 4, 5, 6, 7, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <input value={q.ratingLow} onChange={(e) => set({ ratingLow: e.target.value.slice(0, 40) })} placeholder="左の言葉（例：不満）" aria-label="左の言葉" className={`${INPUT} w-36`} />
            <input value={q.ratingHigh} onChange={(e) => set({ ratingHigh: e.target.value.slice(0, 40) })} placeholder="右の言葉（例：満足）" aria-label="右の言葉" className={`${INPUT} w-36`} />
          </div>
        )}

        {q.type === "long" && (
          <label className="flex items-center gap-2 text-sm">
            記入欄の高さ
            <input type="range" min={1} max={LIMITS.lines} value={q.lines} onChange={(e) => set({ lines: Number(e.target.value) })} className="w-40" aria-label="記入欄の行数" data-testid="survey-long-lines" />
            <span className="w-12 text-xs text-neutral-600 dark:text-neutral-300">{q.lines}行</span>
          </label>
        )}

        {(q.type === "short" || q.type === "number") && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              記入欄の長さ
              <select value={q.width} onChange={(e) => set({ width: e.target.value as Question["width"] })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="short">短い</option>
                <option value="medium">ふつう</option>
                <option value="full">長い</option>
              </select>
            </label>
            {q.type === "number" && (
              <input value={q.unit} onChange={(e) => set({ unit: e.target.value.slice(0, 20) })} placeholder="単位（例：歳・人・回）" aria-label="単位" className={`${INPUT} w-40`} data-testid="survey-number-unit" />
            )}
          </div>
        )}

        {q.type === "date" && (
          <label className="flex items-center gap-1.5 text-sm">
            書き方
            <select value={q.dateStyle} onChange={(e) => set({ dateStyle: e.target.value as Question["dateStyle"] })} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="ymd">＿年＿月＿日</option>
              <option value="wareki">＿年＿月＿日（元号：＿）</option>
            </select>
          </label>
        )}

        {!isSection && (
          <div className="flex flex-wrap items-center gap-4 text-xs text-neutral-600 dark:text-neutral-300">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={q.required} onChange={(e) => set({ required: e.target.checked })} data-testid="survey-question-required" />
              必須（用紙に「必須」と表示）
            </label>
            {isChoice && (
              <label className="flex items-center gap-1.5">
                並べ方
                <select value={q.direction} onChange={(e) => set({ direction: e.target.value as Question["direction"] })} className="rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 dark:border-neutral-700 dark:bg-neutral-900" data-testid="survey-question-direction">
                  <option value="vertical">縦に1つずつ</option>
                  <option value="horizontal">横に並べる</option>
                </select>
              </label>
            )}
            <span className="ml-auto text-neutral-400">{TYPE_LABEL[q.type]}</span>
          </div>
        )}
      </div>
    </li>
  );
}
