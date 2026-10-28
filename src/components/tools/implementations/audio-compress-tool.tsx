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
import { AudioCompressProcessor } from "@/lib/processors/browser/audio-compress";
import {
  AUDIO_DROPZONE_MAX_MB,
  AUDIO_INPUT_ACCEPT,
  estimateLossyBytes,
  coerceAudioChoice,
  formatAudioTime,
  getAudioOutputOption,
  type AudioOutputChoice,
} from "@/lib/audio/shared";
import { useAudioPreview, useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const COMPRESS_BITRATES = [192, 128, 96, 64, 48] as const;

/**
 * 音声圧縮。ビットレートを下げて再エンコードし、ファイルサイズを小さくする。
 * 音楽は128kbps前後、話し声（会議・講義・ボイスメモ）は64kbps前後が目安。
 */
export function AudioCompressTool() {
  const [file, setFile] = useState<File | null>(null);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("mp3");
  const [bitrate, setBitrate] = useState<number>(128);
  const [mono, setMono] = useState(false);
  const job = useAudioJob<Awaited<ReturnType<AudioCompressProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable, true);
  const { previewUrl, probe, probeDone } = useAudioPreview(file);

  const opt = choice === "original" ? null : getAudioOutputOption(choice);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    job.reset();
  }

  async function handleRun() {
    if (!file) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioCompressProcessor().process({
        file,
        choice,
        bitrateKbps: bitrate,
        mono,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!file || !job.result) return;
    downloadBlob(job.result.blob, `${stripExtension(file.name)}_compressed.${job.result.ext}`);
  }

  const estimate = probe
    ? Math.round(estimateLossyBytes(probe.durationSec, mono ? Math.max(32, Math.round(bitrate * 0.6)) : bitrate))
    : null;

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
        <AudioFormatPicker
          name="audio-compress-format"
          legend="圧縮後の形式"
          value={choice}
          onChange={setChoice}
          writableKinds={writable}
          allowOriginal
          originalLabel="元と同じ形式"
          sourceCodec={probe?.codec}
          onlyLossy
        />
      )}
      {file && (
        <AudioBitratePicker
          name="audio-compress-bitrate"
          value={bitrate}
          onChange={setBitrate}
          options={COMPRESS_BITRATES}
        />
      )}
      {file && (
        <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
          <input
            type="checkbox"
            checked={mono}
            onChange={(e) => setMono(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            モノラルにする
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">左右の音をまとめます（さらに小さくなります）</span>
          </span>
        </label>
      )}

      {file && (
        <AudioPreviewPanel
          file={file}
          previewUrl={previewUrl}
          probe={probe}
          probeDone={probeDone}
          outputTitle="圧縮後の予定"
          outputRows={[
            { label: "形式", value: opt ? opt.label : "元と同じ形式" },
            { label: "音質", value: `${bitrate}kbps${mono ? "・モノラル" : ""}` },
            { label: "長さ", value: probe ? formatAudioTime(probe.durationSec) : "元の音声と同じ" },
            { label: "サイズの目安", value: estimate !== null ? `約${formatBytes(estimate)}` : "計算中" },
          ]}
          outputNote="サイズは目安です。実際のサイズは圧縮後に表示されます。"
        />
      )}

      {file && (
        <AudioRunBar
          runDisabled={writable === null}
          runLabel="圧縮する"
          onRun={handleRun}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="圧縮中"
          successLabel="圧縮が完了しました"
        />
      )}

      {job.result && (
        <AudioResultCard
          summary={
            <>
              <span>
                サイズ: {formatBytes(job.result.inputSizeBytes)} → {formatBytes(job.result.sizeBytes)}
                {job.result.inputSizeBytes > 0 &&
                  `（${Math.round((job.result.sizeBytes / job.result.inputSizeBytes) * 100)}%）`}
              </span>
              <span>長さ: {formatAudioTime(job.result.durationSec)}</span>
            </>
          }
        >
          {job.result.sizeBytes >= job.result.inputSizeBytes && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">元のファイルより小さくなりませんでした。ビットレートを下げるか、モノラルをお試しください。</p>
          )}
          <AudioOutputPlayer url={job.result.url} label="圧縮後の音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
