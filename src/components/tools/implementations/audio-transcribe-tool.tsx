"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { TranscribeAi, transcribeAiEnabled } from "@/components/tools/implementations/shared/transcribe-ai";
import { AUDIO_DROPZONE_MAX_MB, AUDIO_INPUT_ACCEPT } from "@/lib/audio/shared";
import { formatClockTime, toPlainText, toSrt, toTimestampedText, type TranscriptSegment } from "@/lib/transcribe/transcript";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/**
 * 文字起こし（プレミアム・AI）。音声や動画の話し声を、AI（OpenAI）で文字にする。
 *
 * - ファイルの読み込み・音声の変換・区切りは、ブラウザの中で行う。AIへ送るのは音声だけ（映像は送らない）。
 * - 結果は、時刻つきの文章・時刻なしの文章・字幕ファイル（SRT）で保存できる。画面で直してから保存できる。
 * - 時刻は、AIが返した文章を、声のある時間に文の長さで割り当てた目安（字幕に使うときは、動画字幕で微調整できる）。
 */

type TextKind = "timestamped" | "plain";

export function AudioTranscribeTool() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState(false);
  const [kind, setKind] = useState<TextKind>("timestamped");
  const [copied, setCopied] = useState(false);

  function handleSelect(files: File[]) {
    setFile(files[0] ?? null);
    setError(null);
    setSegments([]);
    setPartial(false);
  }

  function updateText(index: number, text: string) {
    setSegments((prev) => prev.map((s, i) => (i === index ? { ...s, text } : s)));
  }

  const usable = segments.filter((s) => s.text.trim() !== "");
  const output = kind === "timestamped" ? toTimestampedText(usable) : toPlainText(usable);
  const base = file ? stripExtension(file.name) : "文字起こし";

  async function copy() {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("コピーできませんでした。下の文字を選んでコピーしてください。");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={!!file}
        accept={AUDIO_INPUT_ACCEPT}
        maxSizeMB={AUDIO_DROPZONE_MAX_MB}
        label="音声・動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP3 / WAV / M4A / OGG / MP4 / MOV / WebM）"
        onFilesSelected={handleSelect}
        onError={setError}
      />
      {error && <ErrorMessage message={error} testId="transcribe-error" />}
      {file && <FileList files={[file]} onRemove={() => handleSelect([])} />}

      {/* AIの文字起こしは、課金システムがオンの間だけ提供する（動画字幕と同じ条件） */}
      {transcribeAiEnabled() ? (
        <TranscribeAi
          file={file}
          title="AIで文字起こしする"
          sub="会議・インタビュー・動画の話し声を、AIが文字にします。時刻つきの文章や字幕ファイル（SRT）で保存できます"
          runLabel="AIで文字起こしする"
          onSegments={(next, info) => {
            setSegments(next);
            setPartial(info.partial);
          }}
        />
      ) : (
        <p data-testid="transcribe-unavailable" className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-200">
          AIで文字起こしする機能は、現在ご利用いただけません。
        </p>
      )}

      {segments.length > 0 && (
        <section data-testid="transcribe-result" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold">文字起こしの結果（{usable.length}件）</h3>
            {partial && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">途中までの結果です</span>}
          </div>
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            AIの文字起こしには、聞き間違いが含まれることがあります。下の欄で直してから保存できます。時刻は目安です。
          </p>
          <ol data-testid="transcribe-segments" className="flex max-h-96 flex-col gap-1.5 overflow-auto">
            {segments.map((seg, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 shrink-0 font-mono text-xs text-neutral-500">{formatClockTime(seg.start)}</span>
                <textarea
                  data-testid="transcribe-segment"
                  value={seg.text}
                  rows={1}
                  onChange={(e) => updateText(i, e.target.value)}
                  className="min-h-8 flex-1 resize-y rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-neutral-700 dark:text-neutral-200">保存する文章：</span>
            <label className="flex items-center gap-1">
              <input type="radio" name="transcribe-kind" data-testid="transcribe-kind-timestamped" checked={kind === "timestamped"} onChange={() => setKind("timestamped")} />
              時刻つき
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="transcribe-kind" data-testid="transcribe-kind-plain" checked={kind === "plain"} onChange={() => setKind("plain")} />
              時刻なし（読みやすい文章）
            </label>
          </div>
          <pre data-testid="transcribe-output" className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-200 bg-neutral-50 p-2 font-sans text-xs dark:border-neutral-800 dark:bg-neutral-950">
            {output}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="transcribe-copy"
              onClick={() => void copy()}
              className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
            >
              {copied ? "コピーしました" : "文章をコピー"}
            </button>
            <button
              type="button"
              data-testid="transcribe-save-srt"
              onClick={() => downloadBlob(new Blob([toSrt(usable)], { type: "application/x-subrip" }), `${base}.srt`)}
              className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
            >
              字幕ファイル（.srt）を保存
            </button>
          </div>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(new Blob([output], { type: "text/plain;charset=utf-8" }), `${base}_文字起こし.txt`)}
            label="文章（.txt）をダウンロード"
          />
        </section>
      )}
    </div>
  );
}
