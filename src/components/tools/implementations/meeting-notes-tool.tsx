"use client";

import { useMemo, useState } from "react";
import {
  KIND_OPTIONS,
  SECTION_LABEL,
  createDefaultMeeting,
  generateMeetingNotes,
  type MeetingInput,
  type MeetingKind,
  type MeetingSectionId,
  type NotesFormat,
} from "@/lib/meeting/notes";
import { downloadBlob } from "@/lib/utils/format";

const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

const ALL_SECTIONS = Object.keys(SECTION_LABEL) as MeetingSectionId[];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

function todayString(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 議事録テンプレート生成。入力すると右(下)のプレビューにひな形がその場で反映される。
 * 処理はブラウザ内の文字列組み立てのみで、入力内容はどこにも送信されない。
 */
export function MeetingNotesTool() {
  const [input, setInput] = useState<MeetingInput>(() => createDefaultMeeting(""));
  const [format, setFormat] = useState<NotesFormat>("text");
  const [notice, setNotice] = useState<string | null>(null);

  const output = useMemo(() => generateMeetingNotes(input, format), [input, format]);

  function patch(p: Partial<MeetingInput>) {
    setInput((cur) => ({ ...cur, ...p }));
  }

  function changeKind(kind: MeetingKind) {
    const opt = KIND_OPTIONS.find((o) => o.value === kind);
    patch({ kind, sections: opt ? opt.defaultSections : input.sections });
  }

  function toggleSection(id: MeetingSectionId) {
    patch({ sections: input.sections.includes(id) ? input.sections.filter((s) => s !== id) : [...input.sections, id] });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(output);
      setNotice("コピーしました");
    } catch {
      setNotice("コピーできませんでした。プレビューを選択して手動でコピーしてください");
    }
    setTimeout(() => setNotice(null), 2000);
  }

  function download() {
    const base = (input.title.trim() || "議事録").replace(/[\\/:*?"<>|]/g, "_");
    const ext = format === "markdown" ? "md" : "txt";
    downloadBlob(new Blob([output], { type: "text/plain;charset=utf-8" }), `${base}_議事録.${ext}`);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Field label="会議の種類">
          <select aria-label="会議の種類" value={input.kind} onChange={(e) => changeKind(e.target.value as MeetingKind)} className={inputClass}>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="会議名">
          <input type="text" aria-label="会議名" value={input.title} onChange={(e) => patch({ title: e.target.value })} placeholder="例: 週次営業会議" className={inputClass} />
        </Field>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="日付">
            <input type="date" aria-label="日付" value={input.date} onChange={(e) => patch({ date: e.target.value })} className={inputClass} />
          </Field>
          <button type="button" onClick={() => patch({ date: todayString() })} className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200">
            今日
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="開始">
            <input type="time" aria-label="開始時刻" value={input.startTime} onChange={(e) => patch({ startTime: e.target.value })} className={inputClass} />
          </Field>
          <Field label="終了">
            <input type="time" aria-label="終了時刻" value={input.endTime} onChange={(e) => patch({ endTime: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <Field label="場所・オンラインURL">
          <input type="text" aria-label="場所" value={input.place} onChange={(e) => patch({ place: e.target.value })} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="司会(任意)">
            <input type="text" aria-label="司会" value={input.facilitator} onChange={(e) => patch({ facilitator: e.target.value })} className={inputClass} />
          </Field>
          <Field label="記録(任意)">
            <input type="text" aria-label="記録" value={input.recorder} onChange={(e) => patch({ recorder: e.target.value })} className={inputClass} />
          </Field>
        </div>
        <Field label="出席者(「、」か改行で区切る)">
          <textarea aria-label="出席者" rows={2} value={input.attendees} onChange={(e) => patch({ attendees: e.target.value })} className={inputClass} />
        </Field>
        <Field label="欠席者(任意)">
          <input type="text" aria-label="欠席者" value={input.absentees} onChange={(e) => patch({ absentees: e.target.value })} className={inputClass} />
        </Field>
        <Field label="議題(1行に1件)">
          <textarea aria-label="議題" rows={4} value={input.agenda} onChange={(e) => patch({ agenda: e.target.value })} placeholder={"前回の振り返り\n今月の目標\nその他"} className={inputClass} />
        </Field>

        <fieldset className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
          <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">含める項目</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {ALL_SECTIONS.map((id) => (
              <label key={id} className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-200">
                <input type="checkbox" checked={input.sections.includes(id)} onChange={() => toggleSection(id)} />
                {SECTION_LABEL[id]}
              </label>
            ))}
          </div>
          {input.sections.includes("todos") && (
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              ToDo欄の行数
              <input
                type="number"
                min={0}
                max={30}
                aria-label="ToDo欄の行数"
                value={input.todoRows}
                onChange={(e) => patch({ todoRows: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                className="w-20 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
        </fieldset>
      </div>

      <section aria-labelledby="meeting-preview" className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="meeting-preview" className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            プレビュー
          </h2>
          <div className="flex gap-1" role="group" aria-label="出力形式">
            {(["text", "markdown"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format === f}
                onClick={() => setFormat(f)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${format === f ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"}`}
              >
                {f === "text" ? "テキスト" : "Markdown"}
              </button>
            ))}
          </div>
        </div>
        <pre data-testid="meeting-preview" className="max-h-[32rem] min-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          {output}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={copy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            コピー
          </button>
          <button type="button" onClick={download} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900">
            ファイルで保存
          </button>
          {notice && (
            <span role="status" className="text-xs text-green-700 dark:text-green-400">
              {notice}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
