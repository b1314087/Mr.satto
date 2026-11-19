"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { Switch } from "@/components/ui/switch";
import {
  AudioBitratePicker,
  AudioFormatPicker,
  AudioOutputPlayer,
  AudioResultCard,
  AudioRunBar,
} from "@/components/tools/implementations/shared/audio-ui";
import { AudioConvertProcessor } from "@/lib/processors/browser/audio-convert";
import { coerceAudioChoice, DEFAULT_AUDIO_BITRATE_KBPS, formatAudioTime, getAudioOutputOption, type AudioOutputChoice } from "@/lib/audio/shared";
import { useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes } from "@/lib/utils/format";
import { clearMediaReloadFlag, ensureMediaFeaturesAllowed } from "@/lib/media/permissions-policy";
import { featureFlags } from "@/lib/config/features";
import { TRANSCRIBE_LANGUAGES, TRANSCRIBE_MAX_TERMS_CHARS, estimateTranscribeAiTokens, type TranscribeLanguage } from "@/lib/ai/transcribe";
import { formatAiTokens } from "@/lib/ai/pricing";
import { browserSpeechSupported, startAiLiveTranscriber, startBrowserLiveTranscriber, type LiveTranscriber } from "@/lib/transcribe/live";
import { formatClockTime, toSrt, toTimestampedText, type TranscriptSegment } from "@/lib/transcribe/transcript";
import { AiUnavailableNotice, ConsentBox, type AiUsage } from "@/components/tools/implementations/shared/ai-panel-parts";
import {
  AUDIO_RECORD_TYPES,
  extensionForType,
  formatClock,
  friendlyMediaError,
  pickRecordType,
  RecordingClock,
  stopStream,
  timestampName,
} from "@/lib/media/recorder";

/**
 * 録音（2026-11-18）。パソコン・スマホのマイクで録音し、MP3・WAV・M4A などで保存する。
 * 録音した音声はブラウザのメモリの中だけにあり、サーバーへは送らない。ページを閉じると消える。
 * 録音のあと、保存する形式に変換してダウンロードする（変換もブラウザの中で行う）。
 *
 * 2026-11-19：リアルタイム文字起こし（オン・オフを選べる。既定はオフ）。src/lib/transcribe/live.ts
 * - かんたん（無料）：ブラウザの音声認識。話すとすぐ文字になる（音声はブラウザの会社の音声認識サービスに送られる）。
 * - 高精度（プレミアム）：約30秒ごとに、音声をAI（OpenAI）に送って文字起こしする。録音の前に同意してもらう。
 */

type Phase = "idle" | "recording" | "paused" | "done";
type LiveMode = "browser" | "ai";
type LiveUsage = { status: "loading" } | ({ status: "available" } & AiUsage) | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

export function VoiceRecorderTool() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [policyBlocked, setPolicyBlocked] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [recorded, setRecorded] = useState<File | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("mp3");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  // リアルタイム文字起こし
  const [liveOn, setLiveOn] = useState(false);
  const [liveMode, setLiveMode] = useState<LiveMode>("browser");
  const [liveLanguage, setLiveLanguage] = useState<TranscribeLanguage>("ja");
  const [liveTerms, setLiveTerms] = useState("");
  const [aiConsent, setAiConsent] = useState(false);
  const [liveUsage, setLiveUsage] = useState<LiveUsage>({ status: "loading" });
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [liveInterim, setLiveInterim] = useState("");
  const [livePending, setLivePending] = useState(0);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveUsed, setLiveUsed] = useState<LiveMode | null>(null);
  const [liveCopied, setLiveCopied] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const liveRef = useRef<LiveTranscriber | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const clockRef = useRef(new RecordingClock());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const job = useAudioJob<Awaited<ReturnType<AudioConvertProcessor["process"]>>>();
  const writable = useWritableAudioKinds(recorded !== null);
  const choice = coerceAudioChoice(rawChoice, writable);
  const opt = choice === "original" ? null : getAudioOutputOption(choice);

  // このページでマイクを使えるか確かめる（ほかのページから移ってきたときは、読み込み直して使えるようにする）
  useEffect(() => {
    if (ensureMediaFeaturesAllowed(["microphone"])) clearMediaReloadFlag();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setPolicyBlocked(true);
  }, []);

  // かんたん文字起こし（ブラウザの音声認識）が使えるか
  useEffect(() => {
    const ok = browserSpeechSupported();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpeechSupported(ok);
    if (!ok) setLiveMode("ai");
  }, []);

  // 高精度（AI）を選んだら、利用状況を取得する（AIは呼ばない）
  useEffect(() => {
    if (!liveOn || liveMode !== "ai") return;
    let cancelled = false;
    fetch("/api/ai/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.available && data.usage) setLiveUsage({ status: "available", ...data.usage });
        else setLiveUsage({ status: "unavailable", reason: data?.reason === "login_required" || data?.reason === "not_premium" ? data.reason : "unavailable" });
      })
      .catch(() => {
        if (!cancelled) setLiveUsage({ status: "unavailable", reason: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [liveOn, liveMode]);

  // 片付け：ページを離れるときは、マイクと文字起こしを止める
  useEffect(() => {
    return () => {
      liveRef.current?.abort();
      stopStream(streamRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void audioCtxRef.current?.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

  // 録っている時間を表示する
  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setElapsed(clockRef.current.elapsedSec()), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
    } catch {
      setDevices([]);
    }
  }

  function startMeter(stream: MediaStream) {
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // 音の大きさの表示ができなくても、録音はできる
    }
  }

  function stopMeter() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setLevel(0);
  }

  /** 録音を始めるときに、リアルタイム文字起こしも始める（失敗しても録音は続ける） */
  function startLive(stream: MediaStream) {
    setLiveSegments([]);
    setLiveInterim("");
    setLivePending(0);
    setLiveError(null);
    setLiveUsed(null);
    if (!liveOn) return;
    try {
      if (liveMode === "browser") {
        liveRef.current = startBrowserLiveTranscriber({
          language: liveLanguage,
          clock: () => clockRef.current.elapsedSec(),
          onUpdate: (u) => {
            setLiveSegments(u.segments);
            setLiveInterim(u.interim);
          },
          onError: setLiveError,
        });
      } else {
        liveRef.current = startAiLiveTranscriber({
          stream,
          language: liveLanguage,
          terms: liveTerms,
          onUpdate: (u) => {
            setLiveSegments(u.segments);
            setLivePending(u.pending);
          },
          onUsage: (u) => setLiveUsage((prev) => (prev.status === "available" ? { ...prev, ...(u as Partial<AiUsage>) } : prev)),
          onError: setLiveError,
        });
        // 同意は録音1回ごと
        setAiConsent(false);
      }
      setLiveUsed(liveMode);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : "文字起こしを始められませんでした（録音は続いています）。");
    }
  }

  async function handleStart() {
    setError(null);
    job.reset();
    if (liveOn && liveMode === "ai") {
      if (liveUsage.status !== "available") {
        setError("高精度の文字起こしは、プレミアムプランでログインしているときに使えます。文字起こしをオフにするか、かんたんを選んでください。");
        return;
      }
      if (!aiConsent) {
        setError("高精度の文字起こしを使うには、録音を始める前に、AIに音声を送ることへの同意にチェックしてください。");
        return;
      }
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("このブラウザは録音に対応していません。Chrome・Edge・Safari の新しいものでお試しください。");
      return;
    }
    const type = pickRecordType(AUDIO_RECORD_TYPES);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, noiseSuppression, echoCancellation, autoGainControl: true },
      });
    } catch (e) {
      setError(friendlyMediaError(e, "マイク"));
      return;
    }
    streamRef.current = stream;
    void refreshDevices();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const mime = recorder.mimeType || type || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime });
      const file = new File([blob], `${timestampName("録音")}.${extensionForType(mime)}`, { type: mime });
      setRecorded(file);
      setRecordedUrl(URL.createObjectURL(blob));
      setPhase("done");
      stopMeter();
      stopStream(streamRef.current);
      streamRef.current = null;
    };
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecorded(null);
    setRecordedUrl(null);
    clockRef.current.reset();
    clockRef.current.start();
    setElapsed(0);
    // 1秒ごとにデータを区切って受け取る（長い録音でも、止めたときにまとめて作る量を減らす）
    recorder.start(1000);
    setPhase("recording");
    startMeter(stream);
    startLive(stream);
  }

  function handlePause() {
    const r = recorderRef.current;
    if (!r || r.state !== "recording") return;
    r.pause();
    liveRef.current?.pause();
    clockRef.current.pause();
    setElapsed(clockRef.current.elapsedSec());
    setPhase("paused");
  }

  function handleResume() {
    const r = recorderRef.current;
    if (!r || r.state !== "paused") return;
    r.resume();
    liveRef.current?.resume();
    clockRef.current.start();
    setPhase("recording");
  }

  function handleStop() {
    const r = recorderRef.current;
    if (!r || r.state === "inactive") return;
    clockRef.current.pause();
    setElapsed(clockRef.current.elapsedSec());
    const live = liveRef.current;
    liveRef.current = null;
    void live?.stop();
    r.stop();
  }

  async function copyLive() {
    try {
      await navigator.clipboard.writeText(toTimestampedText(liveSegments));
      setLiveCopied(true);
      setTimeout(() => setLiveCopied(false), 2000);
    } catch {
      setLiveError("コピーできませんでした。文字を選んでコピーしてください。");
    }
  }

  function liveBaseName() {
    return recorded ? recorded.name.replace(/\.[^.]+$/, "") : timestampName("録音");
  }

  async function handleConvert() {
    if (!recorded) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioConvertProcessor().process({
        file: recorded,
        choice,
        bitrateKbps: opt?.lossy ? bitrate : undefined,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!recorded || !job.result) return;
    const base = recorded.name.replace(/\.[^.]+$/, "");
    downloadBlob(job.result.blob, `${base}.${job.result.ext}`);
  }

  if (policyBlocked) {
    return <ErrorMessage message="このページでマイクを使えませんでした。ページを読み込み直してから、もう一度お試しください。" />;
  }

  const recording = phase === "recording" || phase === "paused";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800" data-testid="recorder-panel">
        <div className="text-4xl font-semibold tabular-nums" data-testid="recorder-time" aria-live="off">
          {formatClock(elapsed)}
        </div>
        <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" aria-hidden="true">
          <div className="h-full bg-green-500 transition-[width] duration-75" style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="recorder-phase" data-phase={phase}>
          {phase === "recording" ? "● 録音中" : phase === "paused" ? "一時停止中" : phase === "done" ? "録音が終わりました" : "「録音を始める」を押すと、マイクの使用の確認が出ます"}
        </span>
        <div className="flex flex-wrap justify-center gap-2">
          {!recording && (
            <button type="button" onClick={() => void handleStart()} data-testid="recorder-start" className="rounded-full bg-red-600 px-6 py-3 text-sm font-semibold text-white">
              ● {phase === "done" ? "録音し直す" : "録音を始める"}
            </button>
          )}
          {phase === "recording" && (
            <button type="button" onClick={handlePause} data-testid="recorder-pause" className="rounded-full border border-neutral-300 px-5 py-3 text-sm dark:border-neutral-700">
              ❚❚ 一時停止
            </button>
          )}
          {phase === "paused" && (
            <button type="button" onClick={handleResume} data-testid="recorder-resume" className="rounded-full border border-neutral-300 px-5 py-3 text-sm dark:border-neutral-700">
              ● 再開
            </button>
          )}
          {recording && (
            <button type="button" onClick={handleStop} data-testid="recorder-stop" className="rounded-full bg-neutral-800 px-6 py-3 text-sm font-semibold text-white dark:bg-neutral-200 dark:text-neutral-900">
              ■ 録音を終える
            </button>
          )}
        </div>
      </div>

      {error && <ErrorMessage message={error} />}

      {!recording && (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800" data-testid="live-settings">
          <Switch checked={liveOn} onChange={setLiveOn} label="リアルタイム文字起こし（録音しながら文字にする）" testId="live-toggle" />
          {liveOn && (
            <div className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">文字起こしの方法</legend>
                <label className={`flex items-start gap-2 ${speechSupported ? "" : "opacity-50"}`}>
                  <input type="radio" name="live-mode" data-testid="live-mode-browser" checked={liveMode === "browser"} disabled={!speechSupported} onChange={() => setLiveMode("browser")} className="mt-1" />
                  <span>
                    <span className="font-medium">かんたん（無料）</span>
                    <span className="block text-xs text-neutral-600 dark:text-neutral-300">
                      話すとすぐ文字になります（精度は目安）。お使いのブラウザの音声認識を使うため、音声はブラウザの会社（Chromeなら Google）の音声認識サービスに送られます。
                      {!speechSupported && "このブラウザでは使えません（Chrome・Edge・Safari で使えます）。"}
                    </span>
                  </span>
                </label>
                {featureFlags.billing && (
                  <label className="flex items-start gap-2">
                    <input type="radio" name="live-mode" data-testid="live-mode-ai" checked={liveMode === "ai"} onChange={() => setLiveMode("ai")} className="mt-1" />
                    <span>
                      <span className="font-medium">高精度（プレミアム・AI）</span>
                      <span className="block text-xs text-neutral-600 dark:text-neutral-300">
                        約30秒ごとに、音声をAI（OpenAI）に送って文字起こしします（少し遅れて文字が出ます）。句読点つきで、そのまま議事録に使いやすい文章になります。利用枠の目安：1分あたり約{formatAiTokens(estimateTranscribeAiTokens(60), "ceil")} AIトークン（話し声のない部分は使いません）。
                      </span>
                    </span>
                  </label>
                )}
              </fieldset>
              <label className="flex flex-wrap items-center gap-2">
                話す言語
                <select
                  data-testid="live-language"
                  value={liveLanguage}
                  onChange={(e) => setLiveLanguage(e.target.value as TranscribeLanguage)}
                  className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
                >
                  {TRANSCRIBE_LANGUAGES.filter((l) => l.value !== "auto" || liveMode === "ai").map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              {liveMode === "ai" && (
                <div className="flex flex-col gap-2" data-testid="live-ai-settings">
                  {liveUsage.status === "loading" && <p className="text-xs text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
                  {liveUsage.status === "unavailable" && (
                    <AiUnavailableNotice
                      reason={liveUsage.reason}
                      text={liveUsage.reason === "login_required" ? "高精度の文字起こしには、ログインが必要です。" : liveUsage.reason === "not_premium" ? "高精度の文字起こしは、プレミアムプランの機能です。" : "高精度の文字起こしは、現在ご利用いただけません。"}
                      loginNext="/tools/voice-recorder"
                    />
                  )}
                  {liveUsage.status === "available" && (
                    <>
                      <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="live-ai-remaining">
                        今期の残り：約{formatAiTokens(liveUsage.remainingAiTokens, "floor")} AIトークン（約{Math.floor(liveUsage.remainingAiTokens / estimateTranscribeAiTokens(60))}分の文字起こし）
                      </p>
                      <label className="flex flex-col gap-1">
                        <span>人名・社名・専門用語（任意）</span>
                        <input
                          type="text"
                          data-testid="live-terms"
                          value={liveTerms}
                          maxLength={TRANSCRIBE_MAX_TERMS_CHARS}
                          onChange={(e) => setLiveTerms(e.target.value)}
                          placeholder="例：Mr.Satto、山田、見積書"
                          className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
                        />
                      </label>
                      <ConsentBox testId="live-ai-consent" checked={aiConsent} onChange={setAiConsent}>
                        録音する音声を、AI（OpenAI）に送って文字起こしすることに同意します
                      </ConsentBox>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {liveUsed && (
        <section className="flex flex-col gap-2 rounded-lg border border-violet-200 bg-violet-50/50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950/20" data-testid="live-panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">
              文字起こし（{liveUsed === "browser" ? "かんたん" : "高精度・AI"}）
            </h3>
            {liveUsed === "ai" && livePending > 0 && (
              <span role="status" data-testid="live-pending" className="text-xs text-violet-800 dark:text-violet-200">
                AIが文字起こししています…
              </span>
            )}
          </div>
          <div data-testid="live-lines" className="flex max-h-72 flex-col gap-1 overflow-auto rounded bg-white p-2 dark:bg-neutral-950" aria-live="polite">
            {liveSegments.length === 0 && !liveInterim && (
              <p className="text-xs text-neutral-500">
                {recording ? (liveUsed === "browser" ? "話すと、ここに文字が出ます。" : "約30秒ごとに、ここに文字が足されていきます。") : "文字起こしできた言葉はありませんでした。"}
              </p>
            )}
            {liveSegments.map((seg, i) => (
              <p key={i} data-testid="live-line" className="flex gap-2">
                <span className="shrink-0 font-mono text-xs text-neutral-500">{formatClockTime(seg.start)}</span>
                <span>{seg.text}</span>
              </p>
            ))}
            {liveInterim && (
              <p data-testid="live-interim" className="text-neutral-400">
                {liveInterim}
              </p>
            )}
          </div>
          {liveError && <ErrorMessage message={liveError} testId="live-error" />}
          {!recording && liveSegments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" data-testid="live-copy" onClick={() => void copyLive()} className="rounded-lg bg-white px-3 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700">
                {liveCopied ? "コピーしました" : "文章をコピー"}
              </button>
              <button
                type="button"
                data-testid="live-save-txt"
                onClick={() => downloadBlob(new Blob([toTimestampedText(liveSegments)], { type: "text/plain;charset=utf-8" }), `${liveBaseName()}_文字起こし.txt`)}
                className="rounded-lg bg-white px-3 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700"
              >
                文章（.txt）を保存
              </button>
              <button
                type="button"
                data-testid="live-save-srt"
                onClick={() => downloadBlob(new Blob([toSrt(liveSegments)], { type: "application/x-subrip" }), `${liveBaseName()}.srt`)}
                className="rounded-lg bg-white px-3 py-1.5 text-xs text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700"
              >
                字幕ファイル（.srt）を保存
              </button>
            </div>
          )}
          {liveUsed === "browser" && !recording && liveSegments.length > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">もっと正確な文章にしたいときは、録音を保存して「文字起こし（AI）」ツールに渡すと、AIで文字起こしし直せます（プレミアム）。</p>
          )}
        </section>
      )}

      {!recording && (
        <details className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <summary className="cursor-pointer font-medium">マイクと音の設定</summary>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              使うマイク
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                onFocus={() => void refreshDevices()}
                data-testid="recorder-device"
                className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="">いつものマイク（ブラウザの設定どおり）</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `マイク ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <Switch checked={noiseSuppression} onChange={setNoiseSuppression} label="雑音を減らす" />
            <Switch checked={echoCancellation} onChange={setEchoCancellation} label="スピーカーの音の回り込みを減らす" />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">楽器の演奏など、元の音をそのまま録りたいときは、2つともオフにしてください。</p>
          </div>
        </details>
      )}

      {recorded && recordedUrl && (
        <section className="flex flex-col gap-4" data-testid="recorder-result">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">録音した音声（{formatAudioTime(elapsed)}・{formatBytes(recorded.size)}）</span>
            <audio controls src={recordedUrl} className="w-full" data-testid="recorder-preview" />
          </div>
          <AudioFormatPicker
            name="voice-recorder-format"
            legend="保存する形式"
            value={choice}
            onChange={setChoice}
            writableKinds={writable}
            allowOriginal
            originalLabel={`録音したままの形式（.${extensionForType(recorded.type)}）`}
          />
          {opt?.lossy && <AudioBitratePicker name="voice-recorder-bitrate" value={bitrate} onChange={setBitrate} />}
          <AudioRunBar
            runLabel="保存用のファイルを作る"
            onRun={handleConvert}
            runDisabled={writable === null}
            status={job.status}
            progress={job.progress}
            canceling={job.canceling}
            wasCanceled={job.wasCanceled}
            error={job.error}
            onCancel={job.cancel}
            processingLabel="ファイルを作っています"
            successLabel="保存用のファイルができました"
          />
          {job.result && (
            <AudioResultCard
              summary={
                <>
                  <span>サイズ: {formatBytes(job.result.sizeBytes)}</span>
                  <span>長さ: {formatAudioTime(job.result.durationSec)}</span>
                </>
              }
            >
              <AudioOutputPlayer url={job.result.url} label="保存する音声（再生して確認できます）" />
              <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
            </AudioResultCard>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            録音した音声は、このページの中だけにあります（リアルタイム文字起こしを使ったとき以外は、どこにも送りません）。ページを閉じると消えるので、必要なものはダウンロードしてください。
          </p>
        </section>
      )}
    </div>
  );
}
