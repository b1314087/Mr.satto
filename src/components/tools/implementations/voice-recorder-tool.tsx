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
 */

type Phase = "idle" | "recording" | "paused" | "done";

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

  // 片付け：ページを離れるときは、マイクを止める
  useEffect(() => {
    return () => {
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

  async function handleStart() {
    setError(null);
    job.reset();
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
  }

  function handlePause() {
    const r = recorderRef.current;
    if (!r || r.state !== "recording") return;
    r.pause();
    clockRef.current.pause();
    setElapsed(clockRef.current.elapsedSec());
    setPhase("paused");
  }

  function handleResume() {
    const r = recorderRef.current;
    if (!r || r.state !== "paused") return;
    r.resume();
    clockRef.current.start();
    setPhase("recording");
  }

  function handleStop() {
    const r = recorderRef.current;
    if (!r || r.state === "inactive") return;
    clockRef.current.pause();
    setElapsed(clockRef.current.elapsedSec());
    r.stop();
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
            録音した音声は、このページの中だけにあります（サーバーには送りません）。ページを閉じると消えるので、必要なものはダウンロードしてください。
          </p>
        </section>
      )}
    </div>
  );
}
