"use client";

import { useMemo, useRef, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import {
  DEFAULT_TEMPLATE,
  SEQUENCE_MAX_LINES,
  SEQUENCE_WIDTHS,
  TEMPLATE_EXAMPLES,
  TEMPLATE_MAX_LENGTH,
  generateMultiple,
  generateSingle,
  toClipboardText,
  type SequenceResult,
  type SequenceWidth,
} from "@/lib/sequence/sequence";

type Mode = "single" | "multiple";

/** 手動で編集した結果。base は、編集した時点の「自動生成の結果」（入力や設定が変わったかの判定に使う） */
interface EditedResult {
  text: string;
  base: string;
}

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "single", label: "単一項目", hint: "1つの項目に、開始〜終了の連番を付ける" },
  { value: "multiple", label: "複数項目", hint: "項目を自由な順に入力し、項目ごとに連番を付ける" },
];

const fieldClass =
  "w-full min-w-0 rounded-xl border border-neutral-300 px-4 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

function optionClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active
      ? "bg-blue-600 text-white"
      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
  }`;
}

/**
 * 連番・項目一括生成（生成ツール）。ブラウザの中だけで処理し、入力・結果は送信も保存もしない。
 * 番号の付け方は src/lib/sequence/sequence.ts の純関数だけで決める。
 *
 * 1行の書き方は、テンプレート（{n}=連番、{item}=項目名）を自由に入力して決める。
 * 結果欄は直接編集できる。編集した結果は、入力・テンプレート・設定を変えても自動では上書きせず（「入力から作り直す」を押したときだけ上書き）、
 * コピーは常に結果欄に表示されている文字を使う。
 */
export function SequenceGeneratorTool() {
  const [mode, setMode] = useState<Mode>("single");
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [width, setWidth] = useState<SequenceWidth>("full");

  // モードA（単一項目）
  const [item, setItem] = useState("英語");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("10");
  // モードB（複数項目）
  const [multiText, setMultiText] = useState("");
  // 手動編集の結果（モードごとに別々に保持する）
  const [editedSingle, setEditedSingle] = useState<EditedResult | null>(null);
  const [editedMultiple, setEditedMultiple] = useState<EditedResult | null>(null);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultRef = useRef<HTMLTextAreaElement>(null);

  const result: SequenceResult = useMemo(
    () => (mode === "single" ? generateSingle({ item, start, end, template, width }) : generateMultiple({ text: multiText, template, width })),
    [mode, item, start, end, multiText, template, width],
  );
  const generatedText = result.lines.join("\n");
  const edited = mode === "single" ? editedSingle : editedMultiple;
  const setEdited = mode === "single" ? setEditedSingle : setEditedMultiple;

  const shownText = edited ? edited.text : generatedText;
  const stale = edited !== null && edited.base !== generatedText;
  const lineCount = shownText === "" ? 0 : toClipboardText(shownText).split("\n").length;
  const canEdit = result.lines.length > 0 || edited !== null;
  const canCopy = toClipboardText(shownText) !== "";

  function handleEdit(value: string) {
    // 自動生成の結果と同じ文字に戻したら、「編集済み」ではなくなる
    setEdited(value === generatedText ? null : { text: value, base: generatedText });
    setCopyState("idle");
  }

  function flashCopy(state: "copied" | "failed") {
    setCopyState(state);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), state === "copied" ? 2000 : 6000);
  }

  async function handleCopy() {
    if (!canCopy) return;
    // 画面の結果欄に表示されている文字（手動編集を含む）をそのままコピーする。入力から作り直したりしない
    const text = toClipboardText(resultRef.current?.value ?? shownText);
    try {
      await navigator.clipboard.writeText(text);
      flashCopy("copied");
    } catch {
      resultRef.current?.focus();
      resultRef.current?.select();
      flashCopy("failed");
    }
  }

  // テンプレートの問題は、テンプレート欄の近くに出す。結果欄の下には、入力の問題だけを出す
  const templateError = result.errorKind === "template" ? result.error : null;
  const message = result.errorKind === "input" ? result.error : templateError ? "テンプレートを直すと、結果が表示されます" : null;
  const showMessage = message !== null && !edited;

  return (
    <PreviewSplitLayout
      preview={
        <div className="flex flex-col gap-3" data-testid="tool-preview">
          <label htmlFor="seq-result" className="flex flex-wrap items-baseline justify-between gap-1 text-sm font-medium">
            <span>生成結果</span>
            <span data-testid="seq-count" className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {lineCount}行
            </span>
          </label>
          <textarea
            id="seq-result"
            ref={resultRef}
            data-testid="seq-result"
            value={shownText}
            readOnly={!canEdit}
            onChange={(e) => handleEdit(e.target.value)}
            rows={12}
            wrap="off"
            spellCheck={false}
            placeholder="入力すると、ここに結果が表示されます"
            className="w-full min-w-0 rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
          />

          {showMessage && (
            <p data-testid="seq-message" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              {message}
            </p>
          )}
          {!showMessage && result.skippedBlankLines > 0 && mode === "multiple" && (
            <p data-testid="seq-blank-note" className="text-xs text-neutral-500 dark:text-neutral-400">
              空行{result.skippedBlankLines}行は無視しました（番号は進みません）。
            </p>
          )}
          {edited && (
            <div data-testid="seq-edited-note" className="flex flex-col gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:bg-blue-950 dark:text-blue-100">
              <p>
                {stale
                  ? "入力・テンプレート・設定が変わりましたが、手動で編集した結果はそのまま残しています。最新の入力で作り直すには、下のボタンを押してください（編集内容は上書きされます）。"
                  : "手動で編集した結果です。入力・テンプレート・設定を変えても、この結果は自動では上書きされません。"}
              </p>
              <button
                type="button"
                data-testid="seq-reset"
                onClick={() => {
                  setEdited(null);
                  setCopyState("idle");
                }}
                className="self-start rounded-lg bg-white px-3 py-1.5 font-semibold text-blue-800 hover:bg-blue-100 dark:bg-blue-900 dark:text-blue-50 dark:hover:bg-blue-800"
              >
                入力から作り直す
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="seq-copy"
              onClick={handleCopy}
              disabled={!canCopy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copyState === "copied" ? "コピーしました" : "すべてコピー"}
            </button>
          </div>
          {copyState === "failed" && (
            <p data-testid="seq-copy-failed" role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
              コピーできませんでした。結果欄の文字を選択しました。Ctrl+C（Macは⌘+C）でコピーしてください。
            </p>
          )}
        </div>
      }
    >
      <div role="tablist" aria-label="生成のしかた" className="grid grid-cols-2 gap-2">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="tab"
            id={`seq-tab-${m.value}`}
            aria-selected={mode === m.value}
            aria-controls="seq-panel"
            data-testid={`seq-mode-${m.value}`}
            onClick={() => {
              setMode(m.value);
              setCopyState("idle");
            }}
            className={`flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left ${
              mode === m.value
                ? "border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-950"
                : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
            }`}
          >
            <span className="text-sm font-semibold">{m.label}</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{m.hint}</span>
          </button>
        ))}
      </div>

      <div id="seq-panel" role="tabpanel" aria-labelledby={`seq-tab-${mode}`} className="flex flex-col gap-4">
        {mode === "single" ? (
          <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <label htmlFor="seq-item" className="flex flex-col gap-1.5 text-sm">
              項目名
              <input
                id="seq-item"
                data-testid="seq-item"
                type="text"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="例: 英語"
                className={fieldClass}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label htmlFor="seq-start" className="flex flex-col gap-1.5 text-sm">
                開始番号
                <input
                  id="seq-start"
                  data-testid="seq-start"
                  type="text"
                  inputMode="numeric"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className={fieldClass}
                />
              </label>
              <label htmlFor="seq-end" className="flex flex-col gap-1.5 text-sm">
                終了番号
                <input
                  id="seq-end"
                  data-testid="seq-end"
                  type="text"
                  inputMode="numeric"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className={fieldClass}
                />
              </label>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">開始番号は終了番号以下（0〜9999）。最大{SEQUENCE_MAX_LINES.toLocaleString("ja-JP")}行まで。</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <label htmlFor="seq-multi-input" className="flex flex-col gap-1.5 text-sm">
              項目（1行に1つ。同じ項目は何度書いても構いません）
              <textarea
                id="seq-multi-input"
                data-testid="seq-multi-input"
                value={multiText}
                onChange={(e) => setMultiText(e.target.value)}
                rows={8}
                wrap="off"
                placeholder={"英語\n英語\n国語\n英語\n数学\n国語"}
                className={`${fieldClass} font-mono`}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              入力した順に、項目ごとの番号（1から）を付けます。空行は無視します。項目名の前後の空白は取り除き、同じ文字の項目を同じ項目として数えます。
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-2">
            <label htmlFor="seq-template" className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200">
              1行の書き方（テンプレート）
              <input
                id="seq-template"
                data-testid="seq-template"
                type="text"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                maxLength={TEMPLATE_MAX_LENGTH + 50}
                spellCheck={false}
                aria-invalid={templateError !== null}
                aria-describedby="seq-template-help"
                placeholder="例: 第{n}回　{item}"
                className={`${fieldClass} font-mono ${templateError ? "border-red-400 focus:border-red-500 focus:ring-red-500/20 dark:border-red-700" : ""}`}
              />
            </label>
            <p id="seq-template-help" className="text-xs text-neutral-500 dark:text-neutral-400"><code>{"{n}"}</code> が連番、<code>{"{item}"}</code> が項目名に置き換わります。</p>
            {templateError && (
              <p data-testid="seq-template-error" role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
                {templateError}
              </p>
            )}
            {!templateError &&
              result.notes.map((note) => (
                <p key={note} data-testid="seq-template-note" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  {note}
                </p>
              ))}
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="テンプレートの例">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">例:</span>
              {TEMPLATE_EXAMPLES.map((ex, i) => (
                <button
                  key={ex}
                  type="button"
                  data-testid={`seq-template-example-${i}`}
                  aria-pressed={template === ex}
                  onClick={() => setTemplate(ex)}
                  className={`${optionClass(template === ex)} font-mono !text-xs`}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{"{n}"} の数字</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="数字の全角・半角">
              {SEQUENCE_WIDTHS.map((w) => (
                <button
                  key={w.value}
                  type="button"
                  data-testid={`seq-width-${w.value}`}
                  aria-pressed={width === w.value}
                  onClick={() => setWidth(w.value)}
                  className={optionClass(width === w.value)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </PreviewSplitLayout>
  );
}
