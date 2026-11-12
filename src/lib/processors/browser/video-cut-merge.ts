import type * as MB from "mediabunny";
import { BrowserProcessor } from "../types";
import { ensureMediabunny, mediabunny } from "@/lib/media/mediabunny-loader";
import {
  VideoCanceledByUserError,
  VideoUserFacingError,
  inspectVideoFile,
  mimeTypeFor,
  outputFormatFor,
  toFriendlyVideoError,
  verifyOutput,
  type OutputContainer,
} from "@/lib/video/shared";
import { createBlobStreamTarget, moveMoovToFront } from "@/lib/video/stream-output";

/**
 * 動画カット・結合（次期機能追加 3）。
 *
 * 「残したい区間」を順番に並べ、1本の動画として書き出す。
 * - 1本の動画から不要な部分を削除する：同じ動画の、残したい区間（いくつでも）を、指定した順につなぐ。
 * - 複数の動画を結合する：動画ごとに、最初から最後までを1つの区間として、並べた順につなぐ。
 *
 * 仕組み（すべてブラウザの中。ファイルは送信しない。ffmpeg 等の WASM は使わず、ほかの動画ツールと同じ mediabunny（WebCodecs））：
 * - 映像：区間ごとに、元の動画の映像を1コマずつ取り出し、出力の大きさの画面（キャンバス）に描いて、作り直す（エンコード）。
 *   出力の大きさは、最初の区間の動画の大きさ（向きの情報を反映した見た目の大きさ）。大きさや縦横比が違う動画は、
 *   縦横比を保ったまま中央に置き、余った部分を黒くする（引き伸ばし・切り抜きはしない）。
 *   コマの時刻は元の動画のまま使うので、フレームレートが違う動画をつないでも、再生の速さは変わらない。
 * - 音声：区間ごとに取り出し、出力の音声（最初に音声がある動画のサンプリング周波数・最大2チャンネル）に合わせてから作り直す。
 *   区間の長さぴったりになるよう、足りない分は無音で埋め、多い分は切る（つなぐたびに映像と音声がずれていかないようにする）。
 *   音声のない動画の区間は無音にする。どの動画にも音声がないときは、音声なしの動画にする。
 * - 書き出しは少しずつ（StreamTarget）。MP4は書き出し後に moov を先頭へ移し、読み直して映像・音声があることを確かめる。
 * - キャンセルすると、途中のデータを捨てて止める。読み込んだ動画は、終わったら必ず閉じる。
 */

export interface VideoClip {
  file: File;
  /** 残す区間の開始・終了（秒） */
  start: number;
  end: number;
}

export interface VideoCutMergeInput {
  clips: VideoClip[];
  container: OutputContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoCutMergeOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  /** 大きさ・縦横比の違う動画があり、黒い余白を付けて合わせたか */
  letterboxed: boolean;
}

export const MAX_CLIPS = 50;
/** 区間の最短の長さ（秒）。これより短い区間はつながない */
export const MIN_CLIP_SEC = 0.1;
/** 音声の作り直しを、この長さ（秒）ごとにまとめて行う */
const AUDIO_CHUNK_SEC = 4;

/** 区間の確かめ（画面とProcessorで共通）。問題があれば日本語のメッセージ */
export function validateClips(clips: { start: number; end: number; durationSec: number }[]): string | null {
  if (clips.length === 0) return "残したい区間（または結合する動画）を1つ以上指定してください。";
  if (clips.length > MAX_CLIPS) return `つなげる区間は${MAX_CLIPS}個までです。`;
  for (const [i, c] of clips.entries()) {
    if (![c.start, c.end].every(Number.isFinite)) return `${i + 1}番目の区間の時間が正しくありません。`;
    if (c.start < 0 || c.end > c.durationSec + 0.05) return `${i + 1}番目の区間が、動画の長さ（${c.durationSec.toFixed(1)}秒）を超えています。`;
    if (c.end - c.start < MIN_CLIP_SEC) return `${i + 1}番目の区間は、終了を開始より後にしてください（${MIN_CLIP_SEC}秒以上）。`;
  }
  return null;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

interface OpenedFile {
  input: MB.Input;
  videoTrack: MB.InputVideoTrack;
  audioTrack: MB.InputAudioTrack | null;
  width: number;
  height: number;
  durationSec: number;
}

export class VideoCutMergeProcessor extends BrowserProcessor<VideoCutMergeInput, VideoCutMergeOutput> {
  async process({ clips, container, onProgress, cancelSignal }: VideoCutMergeInput): Promise<VideoCutMergeOutput> {
    await ensureMediabunny();
    const mb = mediabunny();
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

    // 動画ごとに1回だけ開く（同じ動画の区間をいくつ並べても、読み込みは1回）
    const opened = new Map<File, OpenedFile>();
    const { target, assembler } = createBlobStreamTarget();
    let output: MB.Output | null = null;
    let succeeded = false;
    let canceled = false;
    const onAbort = () => {
      canceled = true;
    };
    cancelSignal?.addEventListener("abort", onAbort);
    const checkCancel = () => {
      if (canceled || cancelSignal?.aborted) throw new VideoCanceledByUserError();
    };

    try {
      for (const clip of clips) {
        if (opened.has(clip.file)) continue;
        const info = await inspectVideoFile(clip.file);
        const audioTrack = await info.input.getPrimaryAudioTrack().catch(() => null);
        opened.set(clip.file, {
          input: info.input,
          videoTrack: info.videoTrack,
          audioTrack: audioTrack && (await audioTrack.canDecode().catch(() => false)) ? audioTrack : null,
          width: info.displayWidth,
          height: info.displayHeight,
          durationSec: info.durationSec,
        });
        checkCancel();
      }
      const problem = validateClips(clips.map((c) => ({ start: c.start, end: c.end, durationSec: opened.get(c.file)!.durationSec })));
      if (problem) throw new VideoUserFacingError(problem);

      // 出力の大きさ：最初の区間の動画の見た目の大きさ（偶数にそろえる）
      const first = opened.get(clips[0].file)!;
      const width = even(first.width);
      const height = even(first.height);
      const letterboxed = clips.some((c) => {
        const o = opened.get(c.file)!;
        return Math.abs(o.width / o.height - width / height) > 0.01;
      });

      const format = outputFormatFor(container);
      const videoCodec = await mb.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width, height });
      if (!videoCodec) {
        throw new VideoUserFacingError(
          container === "mp4"
            ? "お使いのブラウザでは、この大きさのMP4の動画を作れません。WebMを選ぶか、別のブラウザでお試しください。"
            : "お使いのブラウザでは、この大きさのWebMの動画を作れません。MP4を選ぶか、別のブラウザでお試しください。"
        );
      }

      // 音声：最初に音声がある動画に合わせる（最大2チャンネル）
      const firstAudio = clips.map((c) => opened.get(c.file)!.audioTrack).find((t) => t !== null) ?? null;
      let audioConfig: { sampleRate: number; channels: number; codec: MB.AudioCodec } | null = null;
      if (firstAudio) {
        const sampleRate = await firstAudio.getSampleRate();
        const channels = Math.min(2, Math.max(1, await firstAudio.getNumberOfChannels()));
        const audioCodec = await mb.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: channels, sampleRate });
        if (!audioCodec) {
          throw new VideoUserFacingError("お使いのブラウザでは、この動画の音声を書き出せません。別の形式（MP4・WebM）か、別のブラウザでお試しください。");
        }
        audioConfig = { sampleRate, channels, codec: audioCodec };
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new VideoUserFacingError("動画を描く準備ができませんでした。");
      const videoSource = new mb.CanvasSource(canvas, { codec: videoCodec, quality: mb.QUALITY_HIGH });
      const audioSource = audioConfig ? new mb.AudioBufferSource({ codec: audioConfig.codec, quality: mb.QUALITY_HIGH }) : null;

      output = new mb.Output({ format, target });
      output.addVideoTrack(videoSource);
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start();

      const total = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
      let offset = 0;
      let writtenAudioFrames = 0;

      for (const clip of clips) {
        checkCancel();
        const src = opened.get(clip.file)!;
        const segDur = clip.end - clip.start;
        const segOffset = offset;

        const videoTask = (async () => {
          const sink = new mb.VideoSampleSink(src.videoTrack);
          for await (const sample of sink.samples(clip.start, clip.end)) {
            try {
              if (canceled) break;
              const ts = sample.timestamp;
              const dur = sample.duration > 0 ? sample.duration : 1 / 30;
              if (ts >= clip.end) break;
              if (ts + dur <= clip.start) continue; // 区間より前のコマ
              const rel = Math.max(0, ts - clip.start);
              const relEnd = Math.min(segDur, ts + dur - clip.start);
              if (relEnd <= rel) continue;
              ctx.fillStyle = "#000000";
              ctx.fillRect(0, 0, width, height);
              sample.drawWithFit(ctx, { fit: "contain" });
              await videoSource.add(segOffset + rel, relEnd - rel);
              onProgress?.(Math.min(0.99, (segOffset + relEnd) / total));
            } finally {
              sample.close();
            }
          }
        })();

        const audioTask = (async () => {
          if (!audioSource || !audioConfig) return;
          const { sampleRate: outRate, channels: outCh } = audioConfig;
          const targetEnd = Math.round((segOffset + segDur) * outRate);
          // 区間の音声を、出力の音声に合わせて書き出す（targetEnd を超えないように切る）
          const writeFrames = async (planes: Float32Array[], rate: number) => {
            if (planes.length === 0 || planes[0].length === 0) return;
            let buffer = new AudioBuffer({ length: planes[0].length, numberOfChannels: planes.length, sampleRate: rate });
            planes.forEach((p, ch) => buffer.copyToChannel(new Float32Array(p), ch));
            if (rate !== outRate || planes.length !== outCh) {
              const length = Math.max(1, Math.round((planes[0].length / rate) * outRate));
              const off = new OfflineAudioContext(outCh, length, outRate);
              const node = off.createBufferSource();
              node.buffer = buffer;
              node.connect(off.destination);
              node.start();
              buffer = await off.startRendering();
            }
            const room = targetEnd - writtenAudioFrames;
            if (room <= 0) return;
            if (buffer.length > room) {
              const cut = new AudioBuffer({ length: room, numberOfChannels: buffer.numberOfChannels, sampleRate: outRate });
              for (let ch = 0; ch < buffer.numberOfChannels; ch++) cut.copyToChannel(buffer.getChannelData(ch).subarray(0, room), ch);
              buffer = cut;
            }
            await audioSource.add(buffer);
            writtenAudioFrames += buffer.length;
          };
          const writeSilence = async (frames: number) => {
            let left = frames;
            while (left > 0 && !canceled) {
              const n = Math.min(left, outRate * AUDIO_CHUNK_SEC);
              await audioSource.add(new AudioBuffer({ length: n, numberOfChannels: outCh, sampleRate: outRate }));
              writtenAudioFrames += n;
              left -= n;
            }
          };

          // 区間の開始位置まで、前の区間の分が足りなければ無音で埋める
          const startFrame = Math.round(segOffset * outRate);
          if (writtenAudioFrames < startFrame) await writeSilence(startFrame - writtenAudioFrames);

          if (src.audioTrack) {
            const sink = new mb.AudioBufferSink(src.audioTrack);
            let pending: Float32Array[][] = [];
            let pendingFrames = 0;
            let pendingRate = 0;
            let expectedStart = clip.start; // 次に来るはずの音の時刻（すき間があれば無音で埋める）
            const flush = async () => {
              if (pendingFrames === 0) return;
              const ch = pending[0].length;
              const planes = Array.from({ length: ch }, (_, c) => {
                const out = new Float32Array(pendingFrames);
                let at = 0;
                for (const part of pending) {
                  out.set(part[c], at);
                  at += part[c].length;
                }
                return out;
              });
              pending = [];
              pendingFrames = 0;
              await writeFrames(planes, pendingRate);
            };
            for await (const wrapped of sink.buffers(clip.start, clip.end)) {
              if (canceled) break;
              const buf = wrapped.buffer;
              const rate = buf.sampleRate;
              if (pendingRate !== 0 && rate !== pendingRate) await flush();
              pendingRate = rate;
              // 区間の中の部分だけを取り出す
              const from = Math.max(0, Math.round((clip.start - wrapped.timestamp) * rate));
              const to = Math.min(buf.length, Math.round((clip.end - wrapped.timestamp) * rate));
              if (to <= from) continue;
              // 前の音とのすき間（音の途切れ）は無音で埋める
              const partStart = wrapped.timestamp + from / rate;
              const gap = Math.round((partStart - expectedStart) * rate);
              if (gap > 0) {
                pending.push(Array.from({ length: buf.numberOfChannels }, () => new Float32Array(gap)));
                pendingFrames += gap;
              }
              pending.push(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(from, to)));
              pendingFrames += to - from;
              expectedStart = wrapped.timestamp + to / rate;
              if (pendingFrames >= rate * AUDIO_CHUNK_SEC) await flush();
            }
            await flush();
          }
          // 区間の終わりまで足りなければ無音で埋める（映像と音声の長さをそろえる）
          if (!canceled && writtenAudioFrames < targetEnd) await writeSilence(targetEnd - writtenAudioFrames);
        })();

        await Promise.all([videoTask, audioTask]);
        checkCancel();
        offset += segDur;
      }

      checkCancel();
      await output.finalize();
      checkCancel();
      if (assembler.size === 0) throw new VideoUserFacingError("動画の生成に失敗しました。もう一度お試しください。");

      let blob = assembler.toBlob(mimeTypeFor(container));
      if (container === "mp4") blob = await moveMoovToFront(blob);
      await verifyOutput(blob, container, audioSource !== null);
      onProgress?.(1);
      succeeded = true;
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes: blob.size,
        width,
        height,
        durationSec: total,
        hasAudio: audioSource !== null,
        letterboxed,
      };
    } catch (e) {
      if (canceled || cancelSignal?.aborted || e instanceof VideoCanceledByUserError) throw new VideoCanceledByUserError();
      throw toFriendlyVideoError(e);
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
      if (!succeeded) {
        if (output && output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => undefined);
        assembler.clear();
      }
      for (const o of opened.values()) o.input.dispose();
    }
  }
}
