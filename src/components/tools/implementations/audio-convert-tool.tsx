"use client";

import { useState } from "react";
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
import { AudioConvertProcessor } from "@/lib/processors/browser/audio-convert";
import {
  AUDIO_DROPZONE_MAX_MB,
  AUDIO_INPUT_ACCEPT,
  DEFAULT_AUDIO_BITRATE_KBPS,
  audioCodecLabel,
  coerceAudioChoice,
  estimateLossyBytes,
  estimateWavBytes,
  formatAudioTime,
  getAudioOutputOption,
  type AudioOutputChoice,
} from "@/lib/audio/shared";
import { useAudioPreview, useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 音声形式変換。MP3 / WAV / M4A（AAC） / OGG（Opus） / FLAC の相互変換。
 * M4A→MP3 などもここで行う。すべてブラウザ内で処理する。
 */
export function AudioConvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("mp3");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  const job = useAudioJob<Awaited<ReturnType<AudioConvertProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable);
  const { previewUrl, probe, probeDone } = useAudioPreview(file);

  const opt = choice === "original" ? null : getAudioOutputOption(choice);
  const lossy = opt?.lossy ?? false;

  function handleSelect(files: File[]) {
    setFile(files[0]);
    job.reset();
  }

  async function handleRun() {
    if (!file) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioConvertProcessor().process({
        file,
        choice,
        bitrateKbps: lossy ? bitrate : undefined,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!file || !job.result) return;
    downloadBlob(job.result.blob, `${stripExtension(file.name)}.${job.result.ext}`);
  }

  function estimateSize(): string {
    if (!probe) return "計算中";
    if (!opt) return `${formatBytes(file?.size ?? 0)} 前後`;
    if (opt.lossy) return `約${formatBytes(estimateLossyBytes(probe.durationSec, bitrate))}`;
    const wav = estimateWavBytes(probe.durationSec, probe.sampleRate, Math.min(2, probe.channels));
    return opt.kind === "wav" ? `約${formatBytes(wav)}` : `約${formatBytes(Math.round(wav * 0.6))}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <AudioIntro>
        音声ファイル（MP3 / WAV / M4A / AAC / OGG / FLAC など）を、MP3・WAV・M4A・OGG・FLACのいずれかの形式に変換します。
        M4AからMP3への変換もできます。
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
        <AudioFormatPicker
          name="audio-convert-format"
          value={choice}
          onChange={setChoice}
          writableKinds={writable}
        />
      )}
      {file && lossy && <AudioBitratePicker name="audio-convert-bitrate" value={bitrate} onChange={setBitrate} />}

      {file && (
        <AudioPreviewPanel
          file={file}
          previewUrl={previewUrl}
          probe={probe}
          probeDone={probeDone}
          outputRows={[
            { label: "形式", value: `${probe ? audioCodecLabel(probe.codec) : "元の形式"} → ${opt?.label ?? ""}` },
            { label: "長さ", value: probe ? formatAudioTime(probe.durationSec) : "元の音声と同じ" },
            { label: "サイズの目安", value: estimateSize() },
          ]}
          outputNote="サイズは目安です。実際のサイズは変換後に表示されます。"
        />
      )}

      {file && (
        <AudioRunBar
          runDisabled={writable === null}
          runLabel="変換する"
          onRun={handleRun}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="変換中"
          successLabel="変換が完了しました"
        />
      )}

      {job.result && (
        <AudioResultCard
          summary={
            <>
              <span>
                サイズ: {formatBytes(job.result.inputSizeBytes)} → {formatBytes(job.result.sizeBytes)}
              </span>
              <span>長さ: {formatAudioTime(job.result.durationSec)}</span>
            </>
          }
        >
          <AudioOutputPlayer url={job.result.url} label="変換後の音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
