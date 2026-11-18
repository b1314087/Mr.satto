"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { VideoH264Processor } from "@/lib/processors/browser/video-h264";
import { downloadBlob, formatBytes } from "@/lib/utils/format";
import { clearMediaReloadFlag, ensureMediaFeaturesAllowed } from "@/lib/media/permissions-policy";
import {
  extensionForType,
  formatClock,
  friendlyMediaError,
  pickRecordType,
  RecordingClock,
  stopStream,
  timestampName,
  VIDEO_RECORD_TYPES,
} from "@/lib/media/recorder";

/**
 * 画面録画（2026-11-18）。パソコンの画面（画面全体・ウィンドウ・ブラウザのタブ）を録画する。
 * - マイクの声・パソコンの音（共有の画面で「音声を共有」を選んだとき）を一緒に録れる。
 * - カメラの映像を、画面の隅に小さく重ねられる。
 * 録画した動画はブラウザのメモリの中だけにあり、サーバーへは送らない。スマホのブラウザは画面の録画に対応していない。
 *
 * カメラを重ねるときは、画面とカメラを1枚の絵（canvas）に描いて録る。録画中は別の画面を見ていて、このタブが
 * 裏に回ることが多い。裏のタブではタイマーや描画の合図が遅くなるため、合図は Web Worker から送る（裏でも遅くならない）。
 */

type Phase = "idle" | "recording" | "paused" | "done";
type CamCorner = "br" | "bl" | "tr" | "tl";
type CamSize = "s" | "m" | "l";

const CAM_SIZE_RATIO: Record<CamSize, number> = { s: 0.16, m: 0.22, l: 0.3 };
const FPS = 30;

/** 裏のタブでも遅くならない合図（Worker のタイマー） */
function createTicker(onTick: () => void, fps: number): () => void {
  const src = `let id=setInterval(()=>postMessage(0),${Math.round(1000 / fps)});onmessage=()=>{clearInterval(id);close();};`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = onTick;
  return () => {
    worker.postMessage("stop");
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

function playVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  return v.play().then(() => v);
}

export function ScreenRecorderTool() {
  const [supported, setSupported] = useState(true);
  const [policyBlocked, setPolicyBlocked] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [withMic, setWithMic] = useState(true);
  const [withSystemAudio, setWithSystemAudio] = useState(true);
  const [withCamera, setWithCamera] = useState(false);
  const [camCorner, setCamCorner] = useState<CamCorner>("br");
  const [camSize, setCamSize] = useState<CamSize>("m");
  const [elapsed, setElapsed] = useState(0);
  const [recorded, setRecorded] = useState<File | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [converted, setConverted] = useState<{ blob: Blob; url: string } | null>(null);

  const streamsRef = useRef<MediaStream[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const clockRef = useRef(new RecordingClock());
  const cleanupRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    const ok = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(ok);
    if (!ok) return;
    if (ensureMediaFeaturesAllowed(["display-capture", "microphone", "camera"])) clearMediaReloadFlag();
    else setPolicyBlocked(true);
  }, []);

  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((f) => f());
      streamsRef.current.forEach(stopStream);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

  useEffect(() => {
    return () => {
      if (converted) URL.revokeObjectURL(converted.url);
    };
  }, [converted]);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setElapsed(clockRef.current.elapsedSec()), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  function releaseAll() {
    cleanupRef.current.forEach((f) => f());
    cleanupRef.current = [];
    streamsRef.current.forEach(stopStream);
    streamsRef.current = [];
  }

  async function handleStart() {
    setError(null);
    setNotice(null);
    setConverted(null);
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: withSystemAudio });
    } catch (e) {
      setError(friendlyMediaError(e, "画面"));
      return;
    }
    streamsRef.current = [display];
    let mic: MediaStream | null = null;
    if (withMic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streamsRef.current.push(mic);
      } catch (e) {
        setNotice(`${friendlyMediaError(e, "マイク")}（マイクの声なしで録画します）`);
      }
    }
    let cam: MediaStream | null = null;
    if (withCamera) {
      try {
        cam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        streamsRef.current.push(cam);
      } catch (e) {
        setNotice(`${friendlyMediaError(e, "カメラ")}（カメラなしで録画します）`);
      }
    }
    if (withSystemAudio && display.getAudioTracks().length === 0) {
      setNotice((n) => n ?? "パソコンの音は録れていません（共有する画面を選ぶときに「音声を共有」を選ぶと録れます。Mac の画面全体では録れないことがあります）。");
    }

    // 映像：カメラを重ねるときは、画面とカメラを1枚の絵に描いて録る
    let videoTrack: MediaStreamTrack = display.getVideoTracks()[0];
    if (cam) {
      const screenVideo = await playVideo(new MediaStream([display.getVideoTracks()[0]]));
      const camVideo = await playVideo(cam);
      const settings = display.getVideoTracks()[0].getSettings();
      const canvas = document.createElement("canvas");
      canvas.width = settings.width ?? screenVideo.videoWidth ?? 1280;
      canvas.height = settings.height ?? screenVideo.videoHeight ?? 720;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        if (screenVideo.videoWidth && (canvas.width !== screenVideo.videoWidth || canvas.height !== screenVideo.videoHeight)) {
          canvas.width = screenVideo.videoWidth;
          canvas.height = screenVideo.videoHeight;
        }
        ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
        const w = Math.round(canvas.width * CAM_SIZE_RATIO[camSize]);
        const h = Math.round((w * (camVideo.videoHeight || 3)) / (camVideo.videoWidth || 4));
        const m = Math.round(canvas.width * 0.02);
        const x = camCorner.endsWith("r") ? canvas.width - w - m : m;
        const y = camCorner.startsWith("b") ? canvas.height - h - m : m;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.round(w * 0.06));
        ctx.clip();
        ctx.drawImage(camVideo, x, y, w, h);
        ctx.restore();
      };
      draw();
      cleanupRef.current.push(createTicker(draw, FPS));
      videoTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    }

    // 音：マイクとパソコンの音を1本にまとめる
    const audioSources = [display, mic].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    let audioTracks: MediaStreamTrack[] = [];
    if (audioSources.length === 1) audioTracks = audioSources[0].getAudioTracks();
    else if (audioSources.length > 1) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const s of audioSources) ctx.createMediaStreamSource(s).connect(dest);
      audioTracks = dest.stream.getAudioTracks();
      cleanupRef.current.push(() => void ctx.close());
    }

    const type = pickRecordType(VIDEO_RECORD_TYPES);
    const recorder = new MediaRecorder(new MediaStream([videoTrack, ...audioTracks]), type ? { mimeType: type } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const mime = (recorder.mimeType || type || "video/webm").split(";")[0];
      const blob = new Blob(chunksRef.current, { type: mime });
      const file = new File([blob], `${timestampName("画面録画")}.${extensionForType(mime)}`, { type: mime });
      setRecorded(file);
      setRecordedUrl(URL.createObjectURL(blob));
      setPhase("done");
      releaseAll();
    };
    // 共有をブラウザの「共有を停止」で止めたときも、録画を終える
    display.getVideoTracks()[0].addEventListener("ended", () => {
      if (recorder.state !== "inactive") {
        clockRef.current.pause();
        setElapsed(clockRef.current.elapsedSec());
        recorder.stop();
      }
    });
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecorded(null);
    setRecordedUrl(null);
    clockRef.current.reset();
    clockRef.current.start();
    setElapsed(0);
    recorder.start(1000);
    setPhase("recording");
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

  async function handleConvertMp4() {
    if (!recorded) return;
    setConverting(true);
    setError(null);
    try {
      const out = await new VideoH264Processor().process({ file: recorded, quality: "high" });
      setConverted({ blob: out.blob, url: out.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "MP4に変換できませんでした");
    } finally {
      setConverting(false);
    }
  }

  if (!supported) {
    return (
      <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="screen-unsupported">
        このブラウザは画面の録画に対応していません。パソコンの Chrome・Edge・Firefox・Safari でお試しください（スマホのブラウザでは使えません。スマホ本体の「画面収録」をお使いください）。
      </p>
    );
  }
  if (policyBlocked) {
    return <ErrorMessage message="このページで画面の録画を使えませんでした。ページを読み込み直してから、もう一度お試しください。" />;
  }

  const recording = phase === "recording" || phase === "paused";
  const isWebm = recorded?.type.includes("webm") ?? false;

  return (
    <div className="flex flex-col gap-5">
      {!recording && (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800" data-testid="screen-options">
          <Switch checked={withMic} onChange={setWithMic} label="マイクの声も録る" testId="screen-mic" />
          <Switch checked={withSystemAudio} onChange={setWithSystemAudio} label="パソコンの音も録る（画面を選ぶときに「音声を共有」を選ぶ）" testId="screen-system-audio" />
          <Switch checked={withCamera} onChange={setWithCamera} label="カメラの映像を隅に重ねる" testId="screen-camera" />
          {withCamera && (
            <div className="flex flex-wrap gap-4 pl-1">
              <Segmented
                label="置く場所"
                value={camCorner}
                onChange={setCamCorner}
                size="sm"
                options={[
                  { value: "br", label: "右下" },
                  { value: "bl", label: "左下" },
                  { value: "tr", label: "右上" },
                  { value: "tl", label: "左上" },
                ]}
              />
              <Segmented
                label="大きさ"
                value={camSize}
                onChange={setCamSize}
                size="sm"
                options={[
                  { value: "s", label: "小" },
                  { value: "m", label: "中" },
                  { value: "l", label: "大" },
                ]}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="text-4xl font-semibold tabular-nums" data-testid="screen-time">
          {formatClock(elapsed)}
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="screen-phase" data-phase={phase}>
          {phase === "recording"
            ? "● 録画中（録画したい画面に切り替えて操作してください）"
            : phase === "paused"
              ? "一時停止中"
              : phase === "done"
                ? "録画が終わりました"
                : "「録画を始める」を押すと、録画する画面を選ぶ画面が出ます"}
        </span>
        <div className="flex flex-wrap justify-center gap-2">
          {!recording && (
            <button type="button" onClick={() => void handleStart()} data-testid="screen-start" className="rounded-full bg-red-600 px-6 py-3 text-sm font-semibold text-white">
              ● {phase === "done" ? "録画し直す" : "録画を始める"}
            </button>
          )}
          {phase === "recording" && (
            <button type="button" onClick={handlePause} data-testid="screen-pause" className="rounded-full border border-neutral-300 px-5 py-3 text-sm dark:border-neutral-700">
              ❚❚ 一時停止
            </button>
          )}
          {phase === "paused" && (
            <button type="button" onClick={handleResume} data-testid="screen-resume" className="rounded-full border border-neutral-300 px-5 py-3 text-sm dark:border-neutral-700">
              ● 再開
            </button>
          )}
          {recording && (
            <button type="button" onClick={handleStop} data-testid="screen-stop" className="rounded-full bg-neutral-800 px-6 py-3 text-sm font-semibold text-white dark:bg-neutral-200 dark:text-neutral-900">
              ■ 録画を終える
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" role="status" data-testid="screen-notice">
          {notice}
        </p>
      )}
      {error && <ErrorMessage message={error} />}

      {recorded && recordedUrl && (
        <section className="flex flex-col gap-4" data-testid="screen-result">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">
              録画した動画（{formatClock(elapsed)}・{formatBytes(recorded.size)}・.{extensionForType(recorded.type)}）
            </span>
            <video controls src={recordedUrl} className="max-h-[60vh] w-full rounded-lg bg-black" data-testid="screen-preview" />
          </div>
          <RewardedDownloadGate onDownload={() => downloadBlob(recorded, recorded.name)} label={`ダウンロード（.${extensionForType(recorded.type)}）`} />
          {isWebm && (
            <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <span>
                このブラウザでは WebM 形式で録画しました。スマホや Windows の動画アプリで開けないときは、MP4 に変換してから保存してください。
              </span>
              {!converted ? (
                <button
                  type="button"
                  onClick={() => void handleConvertMp4()}
                  disabled={converting}
                  data-testid="screen-convert-mp4"
                  className="self-start rounded-lg border border-blue-500 px-3 py-1.5 text-blue-700 disabled:opacity-50 dark:text-blue-300"
                >
                  {converting ? "MP4に変換しています…" : "MP4に変換する"}
                </button>
              ) : (
                <RewardedDownloadGate
                  onDownload={() => downloadBlob(converted.blob, recorded.name.replace(/\.[^.]+$/, ".mp4"))}
                  label="MP4をダウンロード"
                />
              )}
            </div>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            録画した動画は、このページの中だけにあります（サーバーには送りません）。ページを閉じると消えるので、必要なものはダウンロードしてください。
          </p>
        </section>
      )}
    </div>
  );
}
