"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ErrorMessage } from "@/components/common/error-message";
import { featureFlags } from "@/lib/config/features";
import { probeAudioFile } from "@/lib/audio/shared";
import {
  TRANSCRIBE_LANGUAGES,
  TRANSCRIBE_MAX_TERMS_CHARS,
  TRANSCRIBE_MAX_TOTAL_SECONDS,
  estimateTranscribeAiTokens,
  type TranscribeLanguage,
} from "@/lib/ai/transcribe";
import { formatAiTokens } from "@/lib/ai/pricing";
import { formatClockTime, type TranscriptSegment } from "@/lib/transcribe/transcript";
import { TranscribeCanceledError, TranscribeRunError, prepareTranscriptionAudio, runTranscription } from "@/lib/transcribe/run-transcription";
import { AI_PANEL_CLASS, AiPanelHeader, AiRunButton, AiUnavailableNotice, AiUsageMeter, ConsentBox, StepLabel, type AiUsage } from "./ai-panel-parts";

/**
 * AIによる文字起こし（プレミアム）。文字起こしツールと動画字幕で共通の部品。
 *
 * - 送るのは、選んだファイルの音声だけ（ブラウザで16kHz・モノラルに変換し、約40秒ずつ送る。映像は送らない）。
 * - 実行のたびに同意してもらう。ファイルを変えたら、前の同意は使わない。
 * - 話し声がない部分は送らない（利用枠を使わない）。
 * - 途中で止まったときは、できた分だけを渡す（どこまでできたかを表示する）。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

type Phase = { kind: "idle" } | { kind: "preparing"; progress: number } | { kind: "sending"; done: number; total: number };

const UNAVAILABLE_TEXT: Record<"login_required" | "not_premium" | "unavailable", string> = {
  login_required: "AIで文字起こしするには、ログインが必要です。",
  not_premium: "AIで文字起こしする機能は、プレミアムプランの機能です。",
  unavailable: "AIで文字起こしする機能は、現在ご利用いただけません。",
};

/** AIの文字起こしを、画面に出すか（課金システムがオンの間だけ） */
export function transcribeAiEnabled(): boolean {
  return featureFlags.billing;
}

export function TranscribeAi({
  file,
  onSegments,
  title,
  sub,
  runLabel,
  collapsible = false,
  testIdPrefix = "tr-ai",
}: {
  /** 文字起こしする音声・動画 */
  file: File | null;
  /** 結果（途中で止まったときは、できた分。partial が true） */
  onSegments: (segments: TranscriptSegment[], info: { partial: boolean }) => void;
  title: string;
  sub: string;
  runLabel: string;
  /** 「使ってみる」で開く形にする（ほかの機能の画面に添えるとき） */
  collapsible?: boolean;
  testIdPrefix?: string;
}) {
  const id = (s: string) => `${testIdPrefix}-${s}`;
  const loginNext = usePathname() ?? "/tools";
  const [open, setOpen] = useState(!collapsible);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [duration, setDuration] = useState<{ file: File; sec: number | null } | null>(null);
  const [language, setLanguage] = useState<TranscribeLanguage>("ja");
  const [terms, setTerms] = useState("");
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 開いたときに、利用状況を取得する（AIは呼ばない）
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

  // ファイルが変わったら、長さを調べ直し、前の同意は使わない
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(false);
    setError(null);
    setNotice(null);
    if (!file) return;
    let cancelled = false;
    probeAudioFile(file).then((p) => {
      if (!cancelled) setDuration({ file, sec: p ? p.durationSec : null });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const running = phase.kind !== "idle";
  const sec = duration && duration.file === file ? duration.sec : undefined;
  const tooLong = typeof sec === "number" && sec > TRANSCRIBE_MAX_TOTAL_SECONDS;
  const noAudio = sec === null;
  const estimate = typeof sec === "number" ? estimateTranscribeAiTokens(sec) : null;
  const overQuota = usage.status === "available" && estimate !== null && estimate > usage.remainingAiTokens;
  const canRun = usage.status === "available" && file !== null && typeof sec === "number" && !tooLong && !overQuota && consent && !running;

  async function run() {
    if (!canRun || !file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setNotice(null);
    setPhase({ kind: "preparing", progress: 0 });
    try {
      const audio = await prepareTranscriptionAudio(file, { signal: controller.signal, onProgress: (p) => setPhase({ kind: "preparing", progress: p }) });
      const segments = await runTranscription(audio, {
        language,
        terms,
        signal: controller.signal,
        onProgress: (done, total) => setPhase({ kind: "sending", done, total }),
        onUsage: (u) => setUsage((prev) => (prev.status === "available" ? { ...prev, ...(u as Partial<AiUsage>) } : prev)),
      });
      if (segments.length === 0) setNotice("話し声が見つかりませんでした。音量が小さすぎないか確かめてください。");
      onSegments(segments, { partial: false });
    } catch (e) {
      if (e instanceof TranscribeCanceledError) {
        setNotice("中止しました。");
      } else if (e instanceof TranscribeRunError) {
        setError(e.message);
        if (e.partial.length > 0) {
          const last = e.partial[e.partial.length - 1];
          setNotice(`${formatClockTime(last.end)} までの分（${e.partial.length}件）は、結果に入れました。`);
          onSegments(e.partial, { partial: true });
        }
      } else {
        setError(e instanceof Error ? e.message : "文字起こしに失敗しました。");
      }
    } finally {
      abortRef.current = null;
      setPhase({ kind: "idle" });
      setConsent(false);
    }
  }

  return (
    <div data-testid={id("panel")} className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title={title}
        sub={sub}
        action={
          collapsible ? (
            <button
              type="button"
              data-testid={id("toggle")}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="rounded-lg border border-violet-400 bg-white px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-50 dark:border-violet-600 dark:bg-neutral-900 dark:text-violet-100 dark:hover:bg-violet-950"
            >
              {open ? "閉じる" : "使ってみる"}
            </button>
          ) : undefined
        }
      />
      {open && (
        <>
          {usage.status === "loading" && <p className="text-sm text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
          {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext={loginNext} />}
          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />
              <div className="flex flex-col gap-1" data-testid={id("preview")}>
                <StepLabel n={1} hint="選んだファイルの音声だけをAIに送ります（映像は送りません）">送る内容の確認</StepLabel>
                {!file ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">先にファイルを選んでください。</p>
                ) : sec === undefined ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">音声の長さを調べています…</p>
                ) : noAudio ? (
                  <p data-testid={id("no-audio")} className="text-sm font-semibold text-red-700 dark:text-red-300">このファイルの音声を読み込めませんでした。</p>
                ) : (
                  <div className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                    <p className="break-all">{file.name}</p>
                    <p data-testid={id("estimate")} className="text-xs text-neutral-700 dark:text-neutral-200">
                      長さ {formatClockTime(sec)}・使う利用枠の目安 約{formatAiTokens(estimate ?? 0, "ceil")} AIトークン（話し声のない部分は使いません）
                    </p>
                    {tooLong && (
                      <p data-testid={id("too-long")} className="mt-1 text-xs font-semibold text-red-700 dark:text-red-300">
                        1回で文字起こしできるのは{TRANSCRIBE_MAX_TOTAL_SECONDS / 60}分までです。音声カットで分けてからお試しください。
                      </p>
                    )}
                    {overQuota && (
                      <p data-testid={id("over-quota")} className="mt-1 text-xs font-semibold text-red-700 dark:text-red-300">
                        今期の残りの利用枠では足りません。音声カットで短くしてからお試しください。
                      </p>
                    )}
                  </div>
                )}
              </div>
              {file && typeof sec === "number" && !tooLong && (
                <>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={2}>話している言語と用語</StepLabel>
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      言語
                      <select
                        data-testid={id("language")}
                        value={language}
                        disabled={running}
                        onChange={(e) => setLanguage(e.target.value as TranscribeLanguage)}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        {TRANSCRIBE_LANGUAGES.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span>
                        人名・社名・専門用語（任意）
                        <span className="ml-1 text-xs text-neutral-600 dark:text-neutral-300">書いておくと、その表記で文字起こししやすくなります</span>
                      </span>
                      <input
                        type="text"
                        data-testid={id("terms")}
                        value={terms}
                        maxLength={TRANSCRIBE_MAX_TERMS_CHARS}
                        disabled={running}
                        onChange={(e) => setTerms(e.target.value)}
                        placeholder="例：Mr.Satto、山田、見積書"
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      />
                    </label>
                  </div>
                  <div className="flex flex-col gap-2">
                    <StepLabel n={3}>同意して実行</StepLabel>
                    <ConsentBox testId={id("consent")} checked={consent} onChange={setConsent}>
                      このファイルの音声を、AI（OpenAI）に送って文字起こしすることに同意します
                    </ConsentBox>
                    <AiRunButton
                      testId={id("run")}
                      cancelTestId={id("cancel")}
                      disabled={!canRun}
                      running={running}
                      label={runLabel}
                      runningLabel="文字起こし中…"
                      consentGiven={consent}
                      onClick={() => void run()}
                      onCancel={() => abortRef.current?.abort()}
                    />
                    {phase.kind === "preparing" && (
                      <p role="status" data-testid={id("progress")} className="rounded-lg bg-white px-3 py-2 text-sm text-violet-900 dark:bg-neutral-900 dark:text-violet-100">
                        音声を準備しています…（{Math.round(phase.progress * 100)}%）
                      </p>
                    )}
                    {phase.kind === "sending" && (
                      <div role="status" data-testid={id("progress")} className="flex flex-col gap-1 rounded-lg bg-white px-3 py-2 text-sm text-violet-900 dark:bg-neutral-900 dark:text-violet-100">
                        <span>
                          AIが文字起こししています…（{phase.done} / {phase.total}）
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900">
                          <span className="block h-full bg-violet-600" style={{ width: `${phase.total > 0 ? (phase.done / phase.total) * 100 : 0}%` }} />
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
              {error && <ErrorMessage message={error} testId={id("error")} />}
              {notice && (
                <p data-testid={id("notice")} role="status" className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
                  {notice}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
