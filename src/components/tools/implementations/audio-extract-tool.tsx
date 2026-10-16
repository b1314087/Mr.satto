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
  DEFAULT_AUDIO_BITRATE_KBPS,
  VIDEO_TO_AUDIO_INPUT_ACCEPT,
  audioCodecLabel,
  coerceAudioChoice,
  estimateLossyBytes,
  formatAudioTime,
  getAudioOutputOption,
  resolveOriginalKind,
  type AudioOutputChoice,
} from "@/lib/audio/shared";
import { useAudioPreview, useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画から音声を抽出。MP4 / MOV / WebM の動画から音声だけを取り出す。
 * 既定は「元の形式のまま」で、再エンコードしないため音質が劣化せず、処理も速い。
 */
export function AudioExtractTool() {
  const [file, setFile] = useState<File | null>(null);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("original");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  const job = useAudioJob<Awaited<ReturnType<AudioConvertProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable);
  const { previewUrl, probe, probeDone } = useAudioPreview(file);

  // 元の形式のままでは出せない音声（AC-3など）の動画では、自動でMP3に切り替える
  const originalPossible = !probe || resolveOriginalKind(probe.codec) !== null;
  const effectiveChoice: AudioOutputChoice = choice === "original" && !originalPossible ? "mp3" : choice;
  const opt = effectiveChoice === "original" ? null : getAudioOutputOption(effectiveChoice);
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
        choice: effectiveChoice,
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

  return (
    <div className="flex flex-col gap-6">
      <AudioIntro>
        動画ファイル（MP4 / MOV / WebM）から、音声だけを取り出して保存します。「元の形式のまま」を選ぶと、音質を落とさず短時間で取り出せます。
      </AudioIntro>

      <FileDropzone
        accept={VIDEO_TO_AUDIO_INPUT_ACCEPT}
        maxSizeMB={AUDIO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM。サイズの上限はありません）"
        onFilesSelected={handleSelect}
        onError={job.setError}
      />
      {!file && job.error && <ErrorMessage message={job.error} />}

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && <AudioSizeWarning sizeBytes={file.size} />}

      {file && (
        <AudioFormatPicker
          name="audio-extract-format"
          legend="取り出す形式"
          value={effectiveChoice}
          onChange={setChoice}
          writableKinds={writable}
          allowOriginal
          sourceCodec={probe?.codec}
        />
      )}
      {file && lossy && <AudioBitratePicker name="audio-extract-bitrate" value={bitrate} onChange={setBitrate} />}

      {file && (
        <AudioPreviewPanel
          file={file}
          previewUrl={previewUrl}
          probe={probe}
          probeDone={probeDone}
          isVideo
          outputTitle="取り出す音声の予定"
          outputRows={[
            {
              label: "形式",
              value: opt
                ? `${probe ? audioCodecLabel(probe.codec) : "元の形式"} → ${opt.label}`
                : `${probe ? audioCodecLabel(probe.codec) : "元の形式"}（そのまま）`,
            },
            { label: "長さ", value: probe ? formatAudioTime(probe.durationSec) : "元の動画と同じ" },
            {
              label: "サイズの目安",
              value: opt && opt.lossy && probe ? `約${formatBytes(estimateLossyBytes(probe.durationSec, bitrate))}` : "動画より小さくなります",
            },
          ]}
        />
      )}

      {file && (
        <AudioRunBar
          runDisabled={writable === null}
          runLabel="音声を取り出す"
          onRun={handleRun}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="取り出し中"
          successLabel="音声を取り出しました"
        />
      )}

      {job.result && (
        <AudioResultCard
          summary={
            <>
              <span>
                サイズ: {formatBytes(job.result.inputSizeBytes)}（動画）→ {formatBytes(job.result.sizeBytes)}
              </span>
              <span>長さ: {formatAudioTime(job.result.durationSec)}</span>
            </>
          }
        >
          <AudioOutputPlayer url={job.result.url} label="取り出した音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
