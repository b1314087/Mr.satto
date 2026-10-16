"use client";

import { useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  AudioBitratePicker,
  AudioFormatPicker,
  AudioIntro,
  AudioOutputPlayer,
  AudioPreviewPanel,
  AudioResultCard,
  AudioRunBar,
  AudioSizeWarning,
} from "@/components/tools/implementations/shared/audio-ui";
import { AudioTrimProcessor } from "@/lib/processors/browser/audio-trim";
import {
  AUDIO_DROPZONE_MAX_MB,
  AUDIO_INPUT_ACCEPT,
  DEFAULT_AUDIO_BITRATE_KBPS,
  estimateLossyBytes,
  coerceAudioChoice,
  formatAudioTime,
  getAudioOutputOption,
  parseAudioTime,
  resolveOriginalKind,
  type AudioOutputChoice,
} from "@/lib/audio/shared";
import { useAudioPreview, useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

function TimeField({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft === null) return;
    const v = parseAudioTime(draft);
    if (v !== null) onCommit(Math.min(Math.max(0, v), max));
    setDraft(null);
  }
  return (
    <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? formatAudioTime(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-32 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        aria-describedby={undefined}
      />
    </label>
  );
}

/**
 * 音声カット。音声の必要な部分（開始〜終了）だけを切り出す。
 * 元の形式のままなら再エンコードせずに切り出すため、音質は劣化しない。
 */
export function AudioTrimTool() {
  const [file, setFile] = useState<File | null>(null);
  const [startSec, setStartSec] = useState(0);
  const [endSecInput, setEndSecInput] = useState<number | null>(null);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("original");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  const job = useAudioJob<Awaited<ReturnType<AudioTrimProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable);
  const { previewUrl, probe, probeDone } = useAudioPreview(file);
  const mediaRef = useRef<HTMLMediaElement>(null);

  const duration = probe?.durationSec ?? 0;
  const endSec = Math.min(endSecInput ?? duration, duration || Infinity);
  const originalPossible = !probe || resolveOriginalKind(probe.codec) !== null;
  const effectiveChoice: AudioOutputChoice = choice === "original" && !originalPossible ? "mp3" : choice;
  const opt = effectiveChoice === "original" ? null : getAudioOutputOption(effectiveChoice);
  const lossy = opt?.lossy ?? false;
  const cutLength = Math.max(0, endSec - startSec);
  const rangeValid = !!probe && endSec > startSec;

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setStartSec(0);
    setEndSecInput(null);
    job.reset();
  }

  function setStart(v: number) {
    setStartSec(Math.min(v, Math.max(0, endSec - 0.1)));
  }
  function setEnd(v: number) {
    setEndSecInput(Math.max(v, startSec + 0.1));
  }

  async function handleRun() {
    if (!file || !rangeValid) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioTrimProcessor().process({
        file,
        startSec,
        endSec,
        choice: effectiveChoice,
        bitrateKbps: lossy ? bitrate : undefined,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!file || !job.result) return;
    downloadBlob(job.result.blob, `${stripExtension(file.name)}_cut.${job.result.ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <AudioIntro>
        音声ファイルの必要な部分だけを切り出します。開始位置と終了位置を指定して、再生しながら確認できます。
      </AudioIntro>

      <FileDropzone
        accept={AUDIO_INPUT_ACCEPT}
        maxSizeMB={AUDIO_DROPZONE_MAX_MB}
        label="音声ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP3 / WAV / M4A / AAC / OGG / FLAC など。サイズの上限はありません）"
        onFilesSelected={handleSelect}
        onError={job.setError}
      />
      {!file && job.error && <ErrorMessage message={job.error} />}

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && <AudioSizeWarning sizeBytes={file.size} />}

      {file && (
        <AudioPreviewPanel
          file={file}
          previewUrl={previewUrl}
          probe={probe}
          probeDone={probeDone}
          audioRef={mediaRef}
          outputTitle="切り出す範囲"
          outputRows={[
            { label: "開始", value: formatAudioTime(startSec) },
            { label: "終了", value: probe ? formatAudioTime(endSec) : "-" },
            { label: "切り出す長さ", value: probe ? formatAudioTime(cutLength) : "-" },
            {
              label: "サイズの目安",
              value:
                opt && opt.lossy && probe
                  ? `約${formatBytes(estimateLossyBytes(cutLength, bitrate))}`
                  : probe && probe.durationSec > 0
                    ? `約${formatBytes(Math.round((file.size * cutLength) / probe.durationSec))}`
                    : "-",
            },
          ]}
        />
      )}

      {file && probe && (
        <fieldset className="flex flex-col gap-4">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">切り出す範囲を指定</legend>
          <div className="flex flex-wrap items-end gap-4">
            <TimeField label="開始位置" value={startSec} max={duration} onCommit={setStart} />
            <button
              type="button"
              onClick={() => setStart(mediaRef.current?.currentTime ?? 0)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
            >
              今の再生位置を開始にする
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={startSec}
            onChange={(e) => setStart(Number(e.target.value))}
            aria-label="開始位置のスライダー"
            className="w-full"
          />
          <div className="flex flex-wrap items-end gap-4">
            <TimeField label="終了位置" value={endSec} max={duration} onCommit={setEnd} />
            <button
              type="button"
              onClick={() => setEnd(mediaRef.current?.currentTime ?? duration)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
            >
              今の再生位置を終了にする
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={endSec}
            onChange={(e) => setEnd(Number(e.target.value))}
            aria-label="終了位置のスライダー"
            className="w-full"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            時間は「1:23.4」（1分23.4秒）や「83.4」（秒）の形式で入力できます。
          </p>
        </fieldset>
      )}

      {file && (
        <AudioFormatPicker
          name="audio-trim-format"
          legend="保存する形式"
          value={effectiveChoice}
          onChange={setChoice}
          writableKinds={writable}
          allowOriginal
          sourceCodec={probe?.codec}
        />
      )}
      {file && lossy && <AudioBitratePicker name="audio-trim-bitrate" value={bitrate} onChange={setBitrate} />}

      {file && (
        <AudioRunBar
          runLabel="切り出す"
          onRun={handleRun}
          runDisabled={!rangeValid || writable === null}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="切り出し中"
          successLabel="切り出しが完了しました"
        />
      )}

      {job.result && (
        <AudioResultCard
          summary={
            <>
              <span>サイズ: {formatBytes(job.result.sizeBytes)}</span>
              <span>長さ: {formatAudioTime(job.result.durationSec)}</span>
            </>
          }
        >
          <AudioOutputPlayer url={job.result.url} label="切り出した音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
