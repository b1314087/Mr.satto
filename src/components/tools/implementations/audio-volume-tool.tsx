"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  AudioBitratePicker,
  AudioFormatPicker,
  AudioOutputPlayer,
  AudioPreviewPanel,
  AudioResultCard,
  AudioRunBar,
  AudioSizeWarning,
} from "@/components/tools/implementations/shared/audio-ui";
import { AudioVolumeProcessor, type VolumeMode } from "@/lib/processors/browser/audio-volume";
import {
  AUDIO_DROPZONE_MAX_MB,
  AUDIO_INPUT_ACCEPT,
  DEFAULT_AUDIO_BITRATE_KBPS,
  dbToGain,
  coerceAudioChoice,
  formatAudioTime,
  getAudioOutputOption,
  resolveOriginalKind,
  type AudioOutputChoice,
} from "@/lib/audio/shared";
import { useAudioPreview, useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const NORMALIZE_TARGETS = [-0.1, -1, -3, -6] as const;

function fmtDb(db: number): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}dB`;
}

/**
 * 音量調整・ノーマライズ。
 * 「音量を上げ下げ」は指定したdB分だけ全体を大きく／小さくする。
 * 「ノーマライズ」は音声全体の最大音量を調べ、一番大きい部分が目標値になるよう自動で揃える
 * （音割れさせずに、できるだけ音を大きくしたいときに使う）。
 */
export function AudioVolumeTool() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<VolumeMode>("gain");
  const [gainDb, setGainDb] = useState(6);
  const [targetPeakDb, setTargetPeakDb] = useState<number>(-1);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("original");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  const job = useAudioJob<Awaited<ReturnType<AudioVolumeProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable);
  const { previewUrl, probe, probeDone } = useAudioPreview(file);

  const originalInfo = probe ? resolveOriginalKind(probe.codec) : null;
  const originalPossible = !probe || originalInfo !== null;
  const effectiveChoice: AudioOutputChoice = choice === "original" && !originalPossible ? "mp3" : choice;
  const outKind = effectiveChoice === "original" ? originalInfo?.kind : effectiveChoice;
  const lossy = outKind ? getAudioOutputOption(outKind).lossy : true;

  function handleSelect(files: File[]) {
    setFile(files[0]);
    job.reset();
  }

  async function handleRun() {
    if (!file) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioVolumeProcessor().process({
        file,
        mode,
        gainDb,
        targetPeakDb,
        choice: effectiveChoice,
        bitrateKbps: lossy ? bitrate : undefined,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!file || !job.result) return;
    downloadBlob(job.result.blob, `${stripExtension(file.name)}_volume.${job.result.ext}`);
  }

  const chip = (selected: boolean) =>
    `cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
      selected
        ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
        : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
    }`;

  return (
    <div className="flex flex-col gap-6">

      <FileDropzone
        accept={AUDIO_INPUT_ACCEPT}
        maxSizeMB={AUDIO_DROPZONE_MAX_MB}
        label="音声ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP3 / WAV / M4A / AAC / OGG / FLAC）"
        onFilesSelected={handleSelect}
        onError={job.setError}
      />
      {!file && job.error && <ErrorMessage message={job.error} />}

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && <AudioSizeWarning sizeBytes={file.size} />}

      {file && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">調整のしかた</legend>
          <div className="flex flex-wrap gap-2">
            <label className={chip(mode === "gain")}>
              <input
                type="radio"
                name="audio-volume-mode"
                value="gain"
                checked={mode === "gain"}
                onChange={() => setMode("gain")}
                className="sr-only"
              />
              音量を上げ下げする
            </label>
            <label className={chip(mode === "normalize")}>
              <input
                type="radio"
                name="audio-volume-mode"
                value="normalize"
                checked={mode === "normalize"}
                onChange={() => setMode("normalize")}
                className="sr-only"
              />
              ノーマライズ（最大音量を揃える）
            </label>
          </div>

          {mode === "gain" ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
                音量の変更：<span className="font-semibold">{fmtDb(gainDb)}</span>
                （約{dbToGain(gainDb).toFixed(2)}倍）
                <input
                  type="range"
                  min={-20}
                  max={20}
                  step={0.5}
                  value={gainDb}
                  onChange={(e) => setGainDb(Number(e.target.value))}
                  aria-label="音量の変更量（dB）"
                  className="w-full"
                />
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">+6dBで約2倍、−6dBで約半分の音量です。</p>
              {gainDb > 0 && (
                <p role="status" className="text-xs text-amber-700 dark:text-amber-400">音が割れる可能性があります。処理後に再生して確認してください。</p>
              )}
            </div>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm text-neutral-700 dark:text-neutral-200">最大音量の目標</legend>
              <div className="flex flex-wrap gap-2">
                {NORMALIZE_TARGETS.map((t) => (
                  <label key={t} className={chip(targetPeakDb === t)}>
                    <input
                      type="radio"
                      name="audio-volume-target"
                      value={t}
                      checked={targetPeakDb === t}
                      onChange={() => setTargetPeakDb(t)}
                      className="sr-only"
                    />
                    {t === -0.1 ? "最大（−0.1dB）" : t === -1 ? "標準（−1dB）" : `${t}dB`}
                  </label>
                ))}
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">全体の最大音量を、この値に揃えます。</p>
            </fieldset>
          )}
        </fieldset>
      )}

      {file && (
        <AudioFormatPicker
          name="audio-volume-format"
          legend="保存する形式"
          value={effectiveChoice}
          onChange={setChoice}
          writableKinds={writable}
          allowOriginal
          originalLabel="元と同じ形式"
          sourceCodec={probe?.codec}
        />
      )}
      {file && lossy && <AudioBitratePicker name="audio-volume-bitrate" value={bitrate} onChange={setBitrate} />}

      {file && (
        <AudioPreviewPanel
          file={file}
          previewUrl={previewUrl}
          probe={probe}
          probeDone={probeDone}
          outputRows={[
            {
              label: "調整",
              value: mode === "gain" ? `音量 ${fmtDb(gainDb)}` : `最大音量を${targetPeakDb}dBに揃える`,
            },
            { label: "長さ", value: probe ? formatAudioTime(probe.durationSec) : "元の音声と同じ" },
          ]}
          outputNote="音量を変えるため、音声は再エンコードされます（非可逆形式では、わずかに音質が変わります）。"
        />
      )}

      {file && (
        <AudioRunBar
          runDisabled={writable === null}
          runLabel="音量を調整する"
          onRun={handleRun}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="調整中"
          successLabel="音量の調整が完了しました"
        />
      )}

      {job.result && (
        <AudioResultCard
          summary={
            <>
              <span>
                サイズ: {formatBytes(job.result.inputSizeBytes)} → {formatBytes(job.result.sizeBytes)}
              </span>
              <span>音量の変更: {fmtDb(job.result.appliedGainDb)}</span>
              {job.result.originalPeakDb !== null && (
                <span>元の最大音量: {job.result.originalPeakDb.toFixed(1)}dB</span>
              )}
            </>
          }
        >
          <AudioOutputPlayer url={job.result.url} label="調整後の音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
