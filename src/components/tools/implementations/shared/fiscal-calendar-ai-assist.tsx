"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { calendarDateRange, sanitizeEventText, type CalendarEvent } from "@/lib/calendar/events";
import { cellText, columnLabels, weekdayHintForRow, weekdayMismatchMessage, type EventCellValue, type ImportResult } from "@/lib/calendar/event-import";
import type { FiscalCalendar } from "@/lib/calendar/model";
import {
  CONSENT_VERSION,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_HEADER_CHARS,
  MAX_ROWS,
  isValidIsoDate,
  type AssistSuggestion,
} from "@/lib/ai/calendar-assist";
import type { AiModelTier } from "@/lib/ai/pricing";
import {
  AI_PANEL_CLASS,
  AiPanelHeader,
  AiRunButton,
  AiUnavailableNotice,
  AiUsageMeter,
  ConsentBox,
  StepLabel,
  TierPicker,
  type AiUsage,
} from "./ai-panel-parts";

/**
 * 日付などを通常の読み取りで認識できなかった行を、AIで読み取る補助。
 *
 * - 通常の年度カレンダー作成には影響しない（このパネルを開かなくても、すべて今までどおり動く）。
 * - AIへ送るのは、利用者が画面で選んだ行・列の文字だけ。送る内容を確認し、毎回同意してから実行する。
 * - AIの結果は「提案」。推測した日付・不確かな行は目立たせ、利用者が直してから採用する。
 */

const CANDIDATE_KINDS = new Set(["bad-date", "empty-title"]);
const PREVIEW_ROWS = 8;

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

interface Draft {
  row: number;
  date: string;
  title: string;
  startTime: string;
  endTime: string;
  confidence: AssistSuggestion["confidence"];
  inferred: boolean;
  note: string;
  adopt: boolean;
}

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "AIによる読み取り補助を使うには、ログインが必要です。",
  not_premium: "AIによる読み取り補助は、プレミアムプランの機能です。",
  unavailable: "AIによる読み取り補助は、現在ご利用いただけません。通常の読み取り結果はそのまま使えます。",
};

const CONFIDENCE_LABEL: Record<AssistSuggestion["confidence"], string> = { high: "確度: 高", medium: "確度: 中", low: "確度: 低" };

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 日付ごとの既存の予定の件数（採用前に「同じ日にすでに予定がある」ことを知らせるため） */
function countByDate(events: readonly CalendarEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.date, (m.get(e.date) ?? 0) + 1);
  return m;
}

export function FiscalCalendarAiAssist({
  calendar,
  rows,
  headerRow,
  mapping,
  result,
  adopted,
  onAdoptedChange,
}: {
  calendar: FiscalCalendar;
  rows: EventCellValue[][];
  headerRow: number;
  mapping: { date: number | null; title: number | null; start: number | null; end: number | null };
  result: ImportResult;
  adopted: CalendarEvent[];
  onAdoptedChange: (next: CalendarEvent[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const labels = useMemo(() => columnLabels(rows, headerRow), [rows, headerRow]);

  const adoptedRows = useMemo(() => new Set(adopted.map((e) => e.sourceRow)), [adopted]);
  const candidates = useMemo(
    () => [...new Set(result.issues.filter((i) => CANDIDATE_KINDS.has(i.kind)).map((i) => i.row))].sort((a, b) => a - b),
    [result.issues],
  );
  const pending = useMemo(() => candidates.filter((r) => !adoptedRows.has(r)), [candidates, adoptedRows]);

  const defaultColumns = useMemo(
    () => [mapping.date, mapping.title, mapping.start, mapping.end].filter((c): c is number => c !== null).sort((a, b) => a - b),
    [mapping],
  );
  const [columns, setColumns] = useState<number[]>(defaultColumns);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [rejectedCount, setRejectedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 列の割り当て・シートが変わったときの選択のやり直しは、呼び出し側が key を変えて作り直すことで行う
  useEffect(() => () => abortRef.current?.abort(), []);

  // パネルを開いたときに、利用状況を取得する（AIは呼ばない）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/ai/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.available && data.usage) setUsage({ status: "available", ...data.usage });
        else setUsage({ status: "unavailable", reason: data?.reason === "login_required" || data?.reason === "not_premium" ? data.reason : "unavailable" });
      })
      .catch(() => {
        if (!cancelled) setUsage({ status: "unavailable", reason: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (candidates.length === 0 && adopted.length === 0) return null;

  const sendRows = pending.filter((r) => !excluded.has(r)).slice(0, MAX_ROWS);
  const sendColumns = columns.slice(0, MAX_COLUMNS);
  const headers = sendColumns.map((c) => sanitizeEventText(labels[c] ?? "").slice(0, MAX_HEADER_CHARS));
  const cellsOf = (row: number) => sendColumns.map((c) => sanitizeEventText(cellText(rows[row - 1]?.[c])).slice(0, MAX_CELL_CHARS));
  const sendable = sendRows.filter((r) => cellsOf(r).some((t) => t !== ""));
  const range = calendarDateRange(calendar);
  const existingByDate = countByDate([...result.events, ...adopted]);

  const canRun = usage.status === "available" && !running && consent && sendable.length > 0 && sendColumns.length > 0;

  async function run() {
    if (!canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 130_000);
    setRunning(true);
    setError(null);
    const sentRows = sendable;
    try {
      const res = await fetch("/api/ai/calendar-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          requestId: newRequestId(),
          model: tier,
          rangeStart: range.start,
          rangeEnd: range.end,
          headers,
          rows: sentRows.map((row) => ({ row, cells: cellsOf(row) })),
          consent: { accepted: true, version: CONSENT_VERSION },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(typeof data?.message === "string" ? data.message : "AIによる読み取りに失敗しました。通常の読み取り結果はそのまま使えます。");
        if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
        return;
      }
      const sentSet = new Set(sentRows);
      const incoming: Draft[] = (data.suggestions as AssistSuggestion[]).map((s) => {
        const inRange = !!s.date && s.date >= range.start && s.date <= range.end;
        // 元の行に曜日が書かれていて、AIの日付と合わない場合は、最初から採用の候補にしない（警告を出す）
        const weekdayOk = !s.date || weekdayMismatchMessage(s.date, weekdayHintForRow(rows, headerRow, mapping, s.row)) === null;
        return {
          row: s.row,
          date: s.date ?? "",
          title: s.title ?? "",
          startTime: s.startTime ?? "",
          endTime: s.endTime ?? "",
          confidence: s.confidence,
          inferred: s.inferred,
          note: s.note,
          // 確実で、推測が入っておらず、対象年度内のものだけ、最初から採用の候補にする
          adopt: s.confidence === "high" && !s.inferred && !!s.date && !!s.title && inRange && weekdayOk,
        };
      });
      // 今回送った行は新しい結果に置き換え、送っていない行の前回の結果は残す
      setDrafts((prev) => [...(prev ?? []).filter((d) => !sentSet.has(d.row)), ...incoming].sort((a, b) => a.row - b.row));
      setRejectedCount(typeof data.rejected === "number" ? data.rejected : 0);
      if (data.usage) setUsage({ status: "available", ...data.usage });
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "AIの応答を待つ時間を超えたため、中止しました。通常の読み取り結果はそのまま使えます。"
          : "通信に失敗しました。通常の読み取り結果はそのまま使えます。",
      );
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      setRunning(false);
      // 同意は毎回確認する（実行のたびに外れる）
      setConsent(false);
    }
  }

  function updateDraft(row: number, patch: Partial<Draft>) {
    setDrafts((prev) => (prev ?? []).map((d) => (d.row === row ? { ...d, ...patch } : d)));
  }

  function draftProblem(d: Draft): string | null {
    if (!d.date || !isValidIsoDate(d.date)) return "日付を入力してください";
    if (d.date < range.start || d.date > range.end) return "対象年度外の日付です";
    if (sanitizeEventText(d.title) === "") return "予定名を入力してください";
    return null;
  }

  function adoptSelected() {
    if (!drafts) return;
    const chosen = drafts.filter((d) => d.adopt && !draftProblem(d));
    if (chosen.length === 0) return;
    const events: CalendarEvent[] = chosen.map((d) => ({
      date: d.date,
      title: sanitizeEventText(d.title),
      startTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(d.startTime) ? d.startTime : null,
      endTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(d.endTime) ? d.endTime : null,
      sourceRow: d.row,
    }));
    const chosenRows = new Set(chosen.map((d) => d.row));
    onAdoptedChange([...adopted.filter((e) => !chosenRows.has(e.sourceRow)), ...events].sort((a, b) => a.sourceRow - b.sourceRow));
    setDrafts((prev) => (prev ?? []).filter((d) => !chosenRows.has(d.row)));
  }

  // 高精度での再確認の対象: 日付が読めなかった・確度が低い行（まだ採用していないもの）
  const unresolved = (drafts ?? []).filter((d) => !d.date || d.confidence === "low").map((d) => d.row);

  return (
    <div data-testid="ai-assist" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title="AIで読み取る（任意）"
        sub={pending.length > 0 ? `読み取れなかった${pending.length}行が対象です` : undefined}
        action={
          <button
            type="button"
            data-testid="ai-open"
            aria-expanded={open}
            onClick={() => {
              if (!open) setUsage({ status: "loading" });
              setOpen((v) => !v);
            }}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${open ? "border border-violet-400 bg-white text-violet-900 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-900 dark:text-violet-50" : "bg-violet-700 text-white shadow-sm hover:bg-violet-800"}`}
          >
            {open ? "閉じる" : "AIで読み取る"}
          </button>
        }
      />

      {adopted.length > 0 && (
        <div data-testid="ai-adopted" className="flex flex-col gap-1">
          <p className="text-violet-900 dark:text-violet-100">AIの提案から採用した予定：{adopted.length}件（カレンダーに反映されます）</p>
          <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
            {adopted.map((e) => (
              <li key={e.sourceRow} data-testid="ai-adopted-item" className="flex flex-wrap items-center justify-between gap-2 break-all">
                <span>
                  <span className="font-mono">{e.sourceRow}行目</span>：{e.date.replace(/-/g, "/")} {e.startTime ?? ""} {e.title}
                </span>
                <button
                  type="button"
                  data-testid="ai-adopted-remove"
                  onClick={() => onAdoptedChange(adopted.filter((x) => x.sourceRow !== e.sourceRow))}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  採用を取り消す
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-3">
          {usage.status === "loading" && <p data-testid="ai-usage-loading" className="text-xs text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
          {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools/fiscal-calendar" />}
          {usage.status === "available" && <AiUsageMeter usage={usage} />}

          {usage.status === "available" && pending.length === 0 && drafts === null && (
            <p data-testid="ai-no-pending">AIで読み取れる行は、もうありません。</p>
          )}

          {usage.status === "available" && pending.length > 0 && (
            <>
              <div className="flex flex-col gap-1" data-testid="ai-send-columns">
                <StepLabel n={1}>AIに送る列を選ぶ</StepLabel>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {labels.slice(0, 40).map((label, c) => (
                    <label key={c} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        data-testid={`ai-col-${c}`}
                        checked={columns.includes(c)}
                        onChange={(e) =>
                          setColumns((prev) => (e.target.checked ? [...prev, c].sort((a, b) => a - b) : prev.filter((x) => x !== c)))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {columns.length > MAX_COLUMNS && <p className="text-red-700 dark:text-red-300">送れるのは{MAX_COLUMNS}列までです（先頭の{MAX_COLUMNS}列だけを送ります）。</p>}
              </div>

              <div className="flex flex-col gap-1" data-testid="ai-send-rows">
                <StepLabel n={2} hint="読み取れなかった行">AIに送る行を選ぶ</StepLabel>
                <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
                  {pending.map((row) => (
                    <li key={row}>
                      <label className="flex items-start gap-2 break-all">
                        <input
                          type="checkbox"
                          data-testid={`ai-row-${row}`}
                          checked={!excluded.has(row)}
                          onChange={(e) =>
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(row);
                              else next.add(row);
                              return next;
                            })
                          }
                        />
                        <span>
                          <span className="font-mono">{row}行目</span>：{cellsOf(row).join(" / ") || "（送る列がすべて空です）"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {pending.length - excluded.size > MAX_ROWS && <p className="text-red-700 dark:text-red-300">一度に送れるのは{MAX_ROWS}行までです（先頭の{MAX_ROWS}行だけを送ります）。</p>}
              </div>

              <div className="flex flex-col gap-1" data-testid="ai-preview">
                <StepLabel n={3} hint="この文字だけをAIに送ります">送る内容の確認</StepLabel>
                <div className="overflow-x-auto rounded border border-violet-200 bg-white dark:border-violet-800 dark:bg-neutral-950">
                  <table className="min-w-full text-left">
                    <thead>
                      <tr>
                        <th className="px-2 py-1 font-medium">行</th>
                        {headers.map((h, i) => (
                          <th key={i} className="px-2 py-1 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sendable.slice(0, PREVIEW_ROWS).map((row) => (
                        <tr key={row} data-testid="ai-preview-row">
                          <td className="px-2 py-1 font-mono">{row}</td>
                          {cellsOf(row).map((t, i) => (
                            <td key={i} className="max-w-[16rem] break-all px-2 py-1">
                              {t}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p data-testid="ai-preview-count">
                  送る行：{sendable.length}行 ／ 送る列：{sendColumns.length}列
                  {sendable.length > PREVIEW_ROWS && `（上の表は先頭の${PREVIEW_ROWS}行。残りも同じ列だけを送ります）`}
                </p>
                <p className="text-xs text-neutral-600 dark:text-neutral-300">Excelファイルそのもの・選んでいない行や列は送りません。</p>
              </div>

              <div className="flex flex-col gap-2">
                <StepLabel n={4}>読み取りの種類</StepLabel>
                <TierPicker
                  name="ai-tier"
                  value={tier}
                  onChange={setTier}
                  standardTestId="ai-tier-standard"
                  advancedTestId="ai-tier-advanced"
                  advancedHint="標準で読めなかった行の再確認用"
                />
              </div>

              <div className="flex flex-col gap-2">
                <StepLabel n={5}>同意して実行</StepLabel>
                <ConsentBox testId="ai-consent" checked={consent} onChange={setConsent}>
                  上の内容（選んだ行・列の文字）を、AI（OpenAI）に送って読み取ることに同意します
                </ConsentBox>
                <AiRunButton
                  testId="ai-run"
                  cancelTestId="ai-cancel"
                  disabled={!canRun}
                  running={running}
                  label="AIで読み取る"
                  consentGiven={consent}
                  onClick={() => void run()}
                  onCancel={() => abortRef.current?.abort()}
                />
              </div>
            </>
          )}

          {error && (
            <p role="alert" data-testid="ai-error" className="rounded-lg bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-200">
              {error}
            </p>
          )}

          {drafts && (
            <div data-testid="ai-results" className="flex flex-col gap-2">
              <StepLabel n={6} hint="AIは読み間違えることがあります。確認してから採用してください">読み取り結果</StepLabel>
              {rejectedCount > 0 && <p className="text-amber-800 dark:text-amber-300">形式が正しくなかった{rejectedCount}行の結果は、使わずに捨てました。</p>}
              {drafts.length === 0 && <p>採用できる提案はありません。</p>}
              <ul className="flex flex-col gap-2">
                {drafts.map((d) => {
                  const problem = draftProblem(d);
                  const sameDay = d.date && existingByDate.get(d.date);
                  // 編集した日付でも照合する（日付を直すと、警告は消える）
                  const weekdayProblem = d.date ? weekdayMismatchMessage(d.date, weekdayHintForRow(rows, headerRow, mapping, d.row)) : null;
                  return (
                    <li key={d.row} data-testid="ai-result" data-row={d.row} className="@container flex flex-col gap-1 rounded border border-violet-200 bg-white p-2 dark:border-violet-800 dark:bg-neutral-950">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1 font-mono">
                          <input
                            type="checkbox"
                            data-testid="ai-result-adopt"
                            checked={d.adopt && !problem}
                            disabled={!!problem}
                            onChange={(e) => updateDraft(d.row, { adopt: e.target.checked })}
                          />
                          {d.row}行目
                        </label>
                        {d.inferred && (
                          <span data-testid="ai-badge-inferred" className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                            AIが推測した日付
                          </span>
                        )}
                        <span
                          data-testid="ai-badge-confidence"
                          className={`rounded px-2 py-0.5 ${d.confidence === "high" ? "bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100" : "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100"}`}
                        >
                          {CONFIDENCE_LABEL[d.confidence]}
                        </span>
                        {problem && (
                          <span data-testid="ai-badge-problem" className="rounded-full bg-red-100 px-2 py-0.5 text-red-900 dark:bg-red-900 dark:text-red-100">
                            {problem}
                          </span>
                        )}
                        {weekdayProblem && (
                          <span data-testid="ai-badge-weekday" className="rounded-full bg-red-100 px-2 py-0.5 text-red-900 dark:bg-red-900 dark:text-red-100">
                            曜日が合いません：{weekdayProblem}。日付を確認してください
                          </span>
                        )}
                        {sameDay ? (
                          <span data-testid="ai-badge-sameday" className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                            同じ日に予定が{sameDay}件あります
                          </span>
                        ) : null}
                      </div>
                      <p className="break-all text-neutral-600 dark:text-neutral-300">元の内容：{cellsOf(d.row).join(" / ")}</p>
                      {d.note && <p data-testid="ai-note" className="break-all text-neutral-700 dark:text-neutral-200">AIのメモ：{d.note}</p>}
                      <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                        <label className="col-span-2 flex flex-col gap-0.5 @md:col-span-1">
                          日付
                          <input
                            type="date"
                            data-testid="ai-edit-date"
                            value={d.date}
                            onChange={(e) => updateDraft(d.row, { date: e.target.value })}
                            className="rounded border border-neutral-300 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="col-span-2 flex flex-col gap-0.5 @md:col-span-1">
                          予定名
                          <input
                            type="text"
                            data-testid="ai-edit-title"
                            value={d.title}
                            maxLength={200}
                            onChange={(e) => updateDraft(d.row, { title: e.target.value })}
                            className="rounded border border-neutral-300 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex flex-col gap-0.5">
                          開始
                          <input
                            type="time"
                            data-testid="ai-edit-start"
                            value={d.startTime}
                            onChange={(e) => updateDraft(d.row, { startTime: e.target.value })}
                            className="rounded border border-neutral-300 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                        <label className="flex flex-col gap-0.5">
                          終了
                          <input
                            type="time"
                            data-testid="ai-edit-end"
                            value={d.endTime}
                            onChange={(e) => updateDraft(d.row, { endTime: e.target.value })}
                            className="rounded border border-neutral-300 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                          />
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="ai-adopt"
                  disabled={!drafts.some((d) => d.adopt && !draftProblem(d))}
                  onClick={adoptSelected}
                  className="rounded-xl bg-violet-700 px-5 py-3 text-base font-bold text-white shadow-sm hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  チェックした提案をカレンダーに採用する
                </button>
                {tier === "standard" && unresolved.length > 0 && (
                  <button
                    type="button"
                    data-testid="ai-rerun-advanced"
                    onClick={() => {
                      // 読み取れなかった行・確度が低い行だけを、高精度で再確認する（同意は、あらためて確認する）
                      setExcluded(new Set(pending.filter((r) => !unresolved.includes(r))));
                      setTier("advanced");
                      setConsent(false);
                    }}
                    className="rounded-lg border border-violet-400 px-3 py-2 text-sm hover:bg-violet-100 dark:border-violet-700 dark:hover:bg-violet-900"
                  >
                    読み取れなかった{unresolved.length}行を高精度で再確認する
                  </button>
                )}
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">採用しなかった提案は、カレンダーに入りません。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
