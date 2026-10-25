"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { calendarDateRange, sanitizeEventText } from "@/lib/calendar/events";
import { parseWeekdayText, weekdayMismatchMessage } from "@/lib/calendar/event-import";
import type { FiscalCalendar } from "@/lib/calendar/model";
import type { PreparedImage } from "@/lib/calendar/event-image";
import { CONSENT_VERSION, isValidIsoDate, type AssistImageSource, type ImageSuggestion } from "@/lib/ai/calendar-assist";
import type { AiModelTier } from "@/lib/ai/pricing";
import {
  AI_PANEL_CLASS,
  AiPanelHeader,
  AiProgress,
  AiRunButton,
  AiUnavailableNotice,
  AiUsageMeter,
  ConsentBox,
  StepLabel,
  TierPicker,
  type AiUsage,
} from "./ai-panel-parts";

/**
 * 画像・スキャンPDFを、AIで読み取る。結果は「提案」で、利用者が内容を確認・修正してから、カレンダーに反映する。
 *
 * - AIへ送るのは、この画面に表示している（縮小した）画像だけ。送る内容を確認し、毎回同意してから実行する。
 * - 送った画像も読み取り結果も、このサービスには保存しない（ブラウザの画面の中だけで保持する）。
 * - 推測した日付・確度の低い予定・曜日が合わない予定は目立たせ、最初から反映の対象にしない。
 */

export interface ImageDraft {
  /** 通し番号（AIが読み取った順） */
  id: number;
  date: string;
  title: string;
  startTime: string;
  endTime: string;
  confidence: ImageSuggestion["confidence"];
  inferred: boolean;
  note: string;
  sourceText: string;
  page: number | null;
  weekday: string | null;
  adopt: boolean;
}

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "画像やスキャンPDFの読み取りには、ログインが必要です。",
  not_premium: "画像やスキャンPDFの読み取り（AI）は、プレミアムプランの機能です。",
  unavailable: "AIによる読み取りは、現在ご利用いただけません。Excel・CSV・文字のPDFは、そのまま読み込めます。",
};

const CONFIDENCE_LABEL: Record<ImageSuggestion["confidence"], string> = { high: "確度: 高", medium: "確度: 中", low: "確度: 低" };
const TIME_OK = /^([01]\d|2[0-3]):[0-5]\d$/;

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function FiscalCalendarImageAssist({
  calendar,
  source,
  images,
  fileName,
  note,
  onApply,
}: {
  calendar: FiscalCalendar;
  source: AssistImageSource;
  images: PreparedImage[];
  fileName: string;
  /** 画像にする前の案内（先頭のページだけを読むなど） */
  note?: string | null;
  /** 確認・修正した予定を、カレンダーの取り込みへ渡す */
  onApply: (drafts: ImageDraft[]) => void;
}) {
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [tier, setTier] = useState<AiModelTier>("standard");
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ImageDraft[] | null>(null);
  const [rejectedCount, setRejectedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const range = useMemo(() => calendarDateRange(calendar), [calendar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
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
  }, []);

  // 読み取り中の経過時間（待っていることが分かるように）
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const canRun = usage.status === "available" && !running && consent && images.length > 0;

  async function run() {
    // 二重実行の防止: ボタンの無効化に加えて、処理中かどうかを同期的にも確認する
    if (!canRun || runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 130_000);
    setElapsed(0);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/calendar-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          mode: "image",
          source,
          requestId: newRequestId(),
          model: tier,
          rangeStart: range.start,
          rangeEnd: range.end,
          images: images.map((im) => ({ mediaType: im.mediaType, base64: im.base64 })),
          consent: { accepted: true, version: CONSENT_VERSION },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(typeof data?.message === "string" ? data.message : res.status === 413 ? "送る画像が大きすぎます。枚数（ページ数）を減らしてください。" : "AIによる読み取りに失敗しました。");
        if (data?.usage) setUsage((u) => (u.status === "available" ? { ...u, ...data.usage } : u));
        return;
      }
      const incoming: ImageDraft[] = (data.suggestions as ImageSuggestion[]).map((s) => {
        const inRange = !!s.date && s.date >= range.start && s.date <= range.end;
        const weekdayOk = !s.date || weekdayMismatchMessage(s.date, parseWeekdayText(s.weekday)) === null;
        return {
          id: s.row,
          date: s.date ?? "",
          title: s.title ?? "",
          startTime: s.startTime ?? "",
          endTime: s.endTime ?? "",
          confidence: s.confidence,
          inferred: s.inferred,
          note: s.note,
          sourceText: s.sourceText,
          page: s.page,
          weekday: s.weekday,
          // 確実で、推測が入っておらず、対象年度内で、曜日も合うものだけ、最初から反映の候補にする
          adopt: s.confidence === "high" && !s.inferred && !!s.date && !!s.title && inRange && weekdayOk,
        };
      });
      setDrafts(incoming.sort((a, b) => a.id - b.id));
      setRejectedCount(typeof data.rejected === "number" ? data.rejected : 0);
      if (data.usage) setUsage({ status: "available", ...data.usage });
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "読み取りを中止しました（または、AIの応答を待つ時間を超えました）。利用枠が消費されている場合があります。"
          : "通信に失敗しました。",
      );
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      runningRef.current = false;
      setRunning(false);
      // 同意は毎回確認する（実行のたびに外れる）
      setConsent(false);
    }
  }

  function update(id: number, patch: Partial<ImageDraft>) {
    setDrafts((prev) => (prev ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function problem(d: ImageDraft): string | null {
    if (!d.date || !isValidIsoDate(d.date)) return "日付を入力してください";
    if (d.date < range.start || d.date > range.end) return "対象年度外の日付です";
    if (sanitizeEventText(d.title) === "") return "予定名を入力してください";
    return null;
  }

  const chosen = (drafts ?? []).filter((d) => d.adopt && !problem(d));
  const sameDayCount = (date: string) => (drafts ?? []).filter((d) => d.adopt && d.date === date).length;

  const isPdf = source === "scanned-pdf";

  return (
    <div data-testid="image-assist" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title={isPdf ? "AIでスキャンPDFを読み取る" : "AIで画像を読み取る"}
        sub={isPdf ? "文字情報のないPDFなので、画像として読み取ります" : "予定表の画像から、予定を取り出します"}
      />
      {note && (
        <p data-testid="image-note" className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          {note}
        </p>
      )}

      {usage.status === "loading" && <p data-testid="ai-usage-loading" className="text-xs text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
      {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools/fiscal-calendar" />}
      {usage.status === "available" && <AiUsageMeter usage={usage} />}

      <div className="flex flex-col gap-2" data-testid="image-send-preview">
        <StepLabel n={1}>送る画像</StepLabel>
        <ul className="flex flex-wrap gap-2">
          {images.map((im, i) => (
            <li key={i} className="flex w-24 flex-col gap-0.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- 送る画像そのもの(data URL)の確認用の表示 */}
              <img data-testid="image-thumb" src={`data:${im.mediaType};base64,${im.base64}`} alt={`AIに送る画像：${im.label}`} className="h-24 w-24 rounded-lg border border-violet-200 bg-white object-contain shadow-sm dark:border-violet-800" />
              <span className="break-all text-[11px] text-neutral-600 dark:text-neutral-300">{im.label}</span>
            </li>
          ))}
        </ul>
        <p data-testid="image-send-count" className="text-xs text-neutral-700 dark:text-neutral-200">
          送る画像：{images.length}枚（{fileName}を縮小したもの）。元のファイルは送りません。
        </p>
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span aria-hidden="true" className="shrink-0 font-bold">!</span>
          画像に写る文字は、すべてAIに送られます。個人情報が写っていないか確認してください。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <StepLabel n={2}>読み取りの種類</StepLabel>
        <TierPicker
          name="image-ai-tier"
          value={tier}
          onChange={setTier}
          standardTestId="image-tier-standard"
          advancedTestId="image-tier-advanced"
          advancedHint="細かい表・手書き向け"
        />
      </div>

      <div className="flex flex-col gap-2">
        <StepLabel n={3}>同意して実行</StepLabel>
        <ConsentBox testId="image-consent" checked={consent} onChange={setConsent}>
          上の画像（{images.length}枚）を、AI（OpenAI）に送って読み取ることに同意します
        </ConsentBox>
        <AiRunButton
          testId="image-run"
          cancelTestId="image-cancel"
          disabled={!canRun}
          running={running}
          label={drafts ? "もう一度AIで読み取る" : "AIで読み取る"}
          consentGiven={consent}
          onClick={() => void run()}
          onCancel={() => abortRef.current?.abort()}
        />
      </div>
      {running && <AiProgress testId="image-progress" seconds={elapsed} />}

      {error && (
        <p role="alert" data-testid="image-error" className="rounded-lg bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {drafts && (
        <div data-testid="image-results" className="flex flex-col gap-3 border-t border-violet-200 pt-4 dark:border-violet-800">
          <StepLabel n={4} hint="AIは読み間違えることがあります。画像と見比べてください">
            読み取り結果
          </StepLabel>
          {rejectedCount > 0 && <p className="text-xs text-amber-800 dark:text-amber-300">形式が正しくなかった{rejectedCount}件は、使わずに捨てました。</p>}
          {drafts.length === 0 && <p data-testid="image-empty" className="text-sm">予定を読み取れませんでした。画像が鮮明か、予定表が写っているかご確認ください。</p>}
          <ul className="flex flex-col gap-2">
            {drafts.map((d) => {
              const p = problem(d);
              const weekdayProblem = d.date ? weekdayMismatchMessage(d.date, parseWeekdayText(d.weekday)) : null;
              const sameDay = d.date ? sameDayCount(d.date) : 0;
              const checked = d.adopt && !p;
              return (
                <li
                  key={d.id}
                  data-testid="image-result"
                  data-id={d.id}
                  className={`@container flex flex-col gap-2 rounded-xl border-2 p-3 text-xs ${checked ? "border-violet-400 bg-white dark:border-violet-600 dark:bg-neutral-950" : "border-neutral-200 bg-white/70 dark:border-neutral-700 dark:bg-neutral-950"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-sm font-semibold">
                      <input type="checkbox" data-testid="image-result-adopt" checked={checked} disabled={!!p} onChange={(e) => update(d.id, { adopt: e.target.checked })} className="h-4 w-4 accent-violet-700" />
                      <span className="font-mono">{d.id}</span>
                      {d.page !== null && images.length > 1 && <span className="text-xs font-normal text-neutral-500">（{d.page}枚目）</span>}
                    </label>
                    {d.inferred && (
                      <span data-testid="image-badge-inferred" className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                        AIが推測した日付
                      </span>
                    )}
                    <span
                      data-testid="image-badge-confidence"
                      className={`rounded-full px-2 py-0.5 ${d.confidence === "high" ? "bg-green-100 text-green-900 dark:bg-green-900 dark:text-green-100" : "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100"}`}
                    >
                      {CONFIDENCE_LABEL[d.confidence]}
                    </span>
                    {p && (
                      <span data-testid="image-badge-problem" className="rounded-full bg-red-100 px-2 py-0.5 text-red-900 dark:bg-red-900 dark:text-red-100">
                        {p}
                      </span>
                    )}
                    {weekdayProblem && (
                      <span data-testid="image-badge-weekday" className="rounded-full bg-red-100 px-2 py-0.5 text-red-900 dark:bg-red-900 dark:text-red-100">
                        曜日が合いません：{weekdayProblem}。日付を確認してください
                      </span>
                    )}
                    {sameDay > 1 && (
                      <span data-testid="image-badge-sameday" className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                        同じ日に{sameDay}件の予定があります
                      </span>
                    )}
                  </div>
                  {d.sourceText && <p className="break-all text-neutral-600 dark:text-neutral-300">画像上の文字：{d.sourceText}</p>}
                  {d.note && (
                    <p data-testid="image-note-ai" className="break-all text-neutral-700 dark:text-neutral-200">
                      AIのメモ：{d.note}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                    <label className="col-span-2 flex flex-col gap-0.5 text-neutral-600 @md:col-span-1 dark:text-neutral-300">
                      日付
                      <input
                        type="date"
                        data-testid="image-edit-date"
                        value={d.date}
                        onChange={(e) => update(d.id, { date: e.target.value })}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                      />
                    </label>
                    <label className="col-span-2 flex flex-col gap-0.5 text-neutral-600 @md:col-span-1 dark:text-neutral-300">
                      予定名
                      <input
                        type="text"
                        data-testid="image-edit-title"
                        value={d.title}
                        maxLength={200}
                        onChange={(e) => update(d.id, { title: e.target.value })}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-neutral-600 dark:text-neutral-300">
                      開始
                      <input
                        type="time"
                        data-testid="image-edit-start"
                        value={d.startTime}
                        onChange={(e) => update(d.id, { startTime: e.target.value })}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-neutral-600 dark:text-neutral-300">
                      終了
                      <input
                        type="time"
                        data-testid="image-edit-end"
                        value={d.endTime}
                        onChange={(e) => update(d.id, { endTime: e.target.value })}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              data-testid="image-apply"
              disabled={chosen.length === 0}
              onClick={() =>
                onApply(
                  chosen.map((d) => ({
                    ...d,
                    title: sanitizeEventText(d.title),
                    startTime: TIME_OK.test(d.startTime) ? d.startTime : "",
                    endTime: TIME_OK.test(d.endTime) ? d.endTime : "",
                  })),
                )
              }
              className="w-full rounded-xl bg-violet-700 px-5 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit"
            >
              チェックした{chosen.length}件をカレンダーに反映する
            </button>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">チェックしなかった予定は、カレンダーに入りません。</p>
          </div>
        </div>
      )}
    </div>
  );
}
