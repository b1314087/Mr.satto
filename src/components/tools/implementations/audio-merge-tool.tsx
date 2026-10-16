"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import {
  AudioBitratePicker,
  AudioFormatPicker,
  AudioIntro,
  AudioOutputPlayer,
  AudioResultCard,
  AudioRunBar,
  AudioSizeWarning,
} from "@/components/tools/implementations/shared/audio-ui";
import { AudioMergeProcessor } from "@/lib/processors/browser/audio-merge";
import {
  AUDIO_DROPZONE_MAX_MB,
  AUDIO_INPUT_ACCEPT,
  DEFAULT_AUDIO_BITRATE_KBPS,
  coerceAudioChoice,
  estimateLossyBytes,
  formatAudioTime,
  getAudioOutputOption,
  probeAudioFile,
  type AudioOutputChoice,
  type AudioOutputKind,
  type AudioProbe,
} from "@/lib/audio/shared";
import { useWritableAudioKinds } from "@/lib/audio/use-audio-preview";
import { useAudioJob } from "@/lib/audio/use-audio-job";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/**
 * 音声結合。複数の音声ファイルを、並べた順番に1つのファイルへつなげる。
 * 形式やサンプリング周波数が違うファイルも、自動でそろえて結合する。
 */
export function AudioMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [rawChoice, setChoice] = useState<AudioOutputChoice>("mp3");
  const [bitrate, setBitrate] = useState(DEFAULT_AUDIO_BITRATE_KBPS);
  const [probes, setProbes] = useState<Map<File, AudioProbe | null>>(new Map());
  const job = useAudioJob<Awaited<ReturnType<AudioMergeProcessor["process"]>>>();
  const writable = useWritableAudioKinds();
  const choice = coerceAudioChoice(rawChoice, writable);

  // 追加されたファイルを1つずつ調べる（長さの合計を出すため）。結果が入るたびに次のファイルへ進む
  useEffect(() => {
    const next = files.find((f) => !probes.has(f));
    if (!next) return;
    let canceled = false;
    void probeAudioFile(next).then((p) => {
      if (!canceled) setProbes((prev) => new Map(prev).set(next, p));
    });
    return () => {
      canceled = true;
    };
  }, [files, probes]);

  const kind: AudioOutputKind = choice === "original" ? "mp3" : choice;
  const opt = getAudioOutputOption(kind);
  const allProbed = files.length > 0 && files.every((f) => probes.has(f));
  const unreadable = files.filter((f) => probes.has(f) && probes.get(f) === null);
  const totalSec = files.reduce((sum, f) => sum + (probes.get(f)?.durationSec ?? 0), 0);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  function handleSelect(selected: File[]) {
    setFiles((prev) => [...prev, ...selected]);
    job.reset();
  }

  async function handleRun() {
    if (files.length < 2) return;
    await job.run(({ onProgress, cancelSignal }) =>
      new AudioMergeProcessor().process({
        files,
        kind,
        bitrateKbps: opt.lossy ? bitrate : undefined,
        onProgress,
        cancelSignal,
      })
    );
  }

  function handleDownload() {
    if (!job.result) return;
    downloadBlob(job.result.blob, `merged.${job.result.ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <AudioIntro>
        複数の音声ファイルを、並べた順番に1つのファイルへつなげます。形式やサンプリング周波数が違うファイルも、
        自動でそろえて結合します（結合後はステレオ・48kHzになります）。
      </AudioIntro>

      <FileDropzone
        accept={AUDIO_INPUT_ACCEPT}
        multiple
        maxSizeMB={AUDIO_DROPZONE_MAX_MB}
        label="音声ファイルをドラッグ&ドロップ（複数選択できます）"
        hint="またはタップして選択（MP3 / WAV / M4A / AAC / OGG / FLAC など）。追加で何度でも選べます"
        onFilesSelected={handleSelect}
        onError={job.setError}
      />
      {files.length < 2 && job.error && <ErrorMessage message={job.error} />}

      {files.length > 0 && (
        <ReorderableFileList
          files={files}
          onReorder={(next) => {
            setFiles(next);
            job.reset();
          }}
          onRemove={(i) => {
            setFiles((prev) => prev.filter((_, idx) => idx !== i));
            job.reset();
          }}
        />
      )}
      {totalBytes > 0 && <AudioSizeWarning sizeBytes={totalBytes} />}

      {files.length === 1 && (
        <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
          結合するには、あと1つ以上ファイルを追加してください。
        </p>
      )}
      {unreadable.length > 0 && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
          読み込めないファイルがあります：{unreadable.map((f) => f.name).join("、")}。
          一覧から削除するか、別のファイルに置き換えてください。
        </p>
      )}

      {files.length >= 1 && (
        <section
          data-testid="tool-preview"
          aria-label="結合の予定"
          className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合の予定</p>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-neutral-600 dark:text-neutral-300">
            {files.map((f, i) => {
              const p = probes.get(f);
              return (
                <li key={`${f.name}-${i}`} className="break-all">
                  {f.name}
                  <span className="ml-2 text-neutral-400">
                    {p ? formatAudioTime(p.durationSec) : probes.has(f) ? "（読み込めません）" : "確認中..."}
                  </span>
                </li>
              );
            })}
          </ol>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-900 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-neutral-500 dark:text-neutral-400">合計の長さ</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                {allProbed ? formatAudioTime(totalSec) : "計算中"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-neutral-500 dark:text-neutral-400">サイズの目安</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                {allProbed && opt.lossy
                  ? `約${formatBytes(estimateLossyBytes(totalSec, bitrate))}`
                  : `${formatBytes(totalBytes)} 以上`}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {files.length >= 2 && (
        <AudioFormatPicker
          name="audio-merge-format"
          legend="結合後の形式"
          value={choice}
          onChange={setChoice}
          writableKinds={writable}
        />
      )}
      {files.length >= 2 && opt.lossy && (
        <AudioBitratePicker name="audio-merge-bitrate" value={bitrate} onChange={setBitrate} />
      )}

      {files.length >= 2 && (
        <AudioRunBar
          runLabel="結合する"
          onRun={handleRun}
          runDisabled={unreadable.length > 0 || writable === null}
          status={job.status}
          progress={job.progress}
          canceling={job.canceling}
          wasCanceled={job.wasCanceled}
          error={job.error}
          onCancel={job.cancel}
          processingLabel="結合中"
          successLabel="結合が完了しました"
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
          <AudioOutputPlayer url={job.result.url} label="結合後の音声（再生して確認できます）" />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </AudioResultCard>
      )}
    </div>
  );
}
