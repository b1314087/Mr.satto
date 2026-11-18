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
import { BOARD_FPS, BOARD_MAX_SECONDS, BOARD_MAX_VIDEOS, boardDuration, localTime, type BoardEndBehavior, type BoardPlacement } from "@/lib/video/board-layout";

/**
 * 動画ホワイトボード（2026-11-19）。複数の動画をキャンバスに自由に置き、同時に再生した1本の動画に書き出す。
 *
 * 仕組み（すべてブラウザの中。ファイルは送信しない。ほかの動画ツールと同じ mediabunny（WebCodecs））：
 * - 映像：1秒30コマで、各コマの時刻の、それぞれの動画の場面を取り出し、置いた位置・大きさ・角度でキャンバスに描いて作り直す。
 *   長さは、いちばん長い動画の長さ。短い動画は、最後の場面で止めるか、最初からくり返す（選べる）。
 * - 音声：すべての動画の音を、動画ごとの音量で混ぜる（48kHz・ステレオ）。大きな音が重なって割れないよう、リミッターを通す。
 *   どの動画にも音がない（または全部の音量が0）のときは、音声なしの動画にする。
 * - 書き出しは少しずつ（StreamTarget）。MP4は書き出し後に moov を先頭へ移し、読み直して映像（と音声）があることを確かめる。
 */

export interface BoardVideoItem extends BoardPlacement {
  file: File;
  /** 音量（0〜1） */
  volume: number;
}

export interface VideoBoardInput {
  items: BoardVideoItem[];
  width: number;
  height: number;
  background: string;
  endBehavior: BoardEndBehavior;
  container: OutputContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoBoardOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
}

const OUT_RATE = 48_000;
const OUT_CHANNELS = 2;

interface Opened {
  item: BoardVideoItem;
  input: MB.Input;
  videoTrack: MB.InputVideoTrack;
  audioTrack: MB.InputAudioTrack | null;
  durationSec: number;
}

/** 1つの動画の音声を、すき間を無音で埋めて1つの AudioBuffer にまとめる（元のサンプリング周波数のまま） */
async function decodeWholeAudio(track: MB.InputAudioTrack, durationSec: number, isCanceled: () => boolean): Promise<AudioBuffer | null> {
  const mb = mediabunny();
  const rate = await track.getSampleRate();
  const channels = Math.min(2, Math.max(1, await track.getNumberOfChannels()));
  const length = Math.max(1, Math.ceil(durationSec * rate));
  const planes = Array.from({ length: channels }, () => new Float32Array(length));
  const sink = new mb.AudioBufferSink(track);
  let any = false;
  for await (const wrapped of sink.buffers(0, durationSec)) {
    if (isCanceled()) return null;
    const buf = wrapped.buffer;
    const at = Math.round(wrapped.timestamp * rate);
    for (let ch = 0; ch < channels; ch++) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      const from = Math.max(0, -at);
      const to = Math.min(src.length, length - at);
      if (to > from) planes[ch].set(src.subarray(from, to), at + from);
    }
    any = true;
  }
  if (!any) return null;
  const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
  planes.forEach((p, ch) => out.copyToChannel(p, ch));
  return out;
}

export class VideoBoardProcessor extends BrowserProcessor<VideoBoardInput, VideoBoardOutput> {
  async process({ items, width, height, background, endBehavior, container, onProgress, cancelSignal }: VideoBoardInput): Promise<VideoBoardOutput> {
    await ensureMediabunny();
    const mb = mediabunny();
    if (items.length === 0) throw new VideoUserFacingError("動画を1つ以上置いてください。");
    if (items.length > BOARD_MAX_VIDEOS) throw new VideoUserFacingError(`置ける動画は${BOARD_MAX_VIDEOS}本までです。`);
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

    let canceled = false;
    const onAbort = () => {
      canceled = true;
    };
    cancelSignal?.addEventListener("abort", onAbort);
    const checkCancel = () => {
      if (canceled || cancelSignal?.aborted) throw new VideoCanceledByUserError();
    };

    const opened: Opened[] = [];
    const { target, assembler } = createBlobStreamTarget();
    let succeeded = false;
    try {
      for (const item of items) {
        const info = await inspectVideoFile(item.file);
        const audioTrack = await info.input.getPrimaryAudioTrack().catch(() => null);
        opened.push({
          item,
          input: info.input,
          videoTrack: info.videoTrack,
          audioTrack: audioTrack && (await audioTrack.canDecode().catch(() => false)) ? audioTrack : null,
          durationSec: info.durationSec,
        });
        checkCancel();
      }
      const longest = Math.max(...opened.map((o) => o.durationSec));
      if (longest > BOARD_MAX_SECONDS + 0.5) {
        throw new VideoUserFacingError(`書き出せる長さは${BOARD_MAX_SECONDS / 60}分までです。長い動画は、動画カット・結合で短くしてからお試しください。`);
      }
      const total = boardDuration(opened.map((o) => o.durationSec));
      const W = Math.max(2, Math.round(width / 2) * 2);
      const H = Math.max(2, Math.round(height / 2) * 2);

      const format = outputFormatFor(container);
      const videoCodec = await mb.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width: W, height: H });
      if (!videoCodec) {
        throw new VideoUserFacingError(
          container === "mp4"
            ? "お使いのブラウザでは、この大きさのMP4の動画を作れません。WebMを選ぶか、別のブラウザでお試しください。"
            : "お使いのブラウザでは、この大きさのWebMの動画を作れません。MP4を選ぶか、別のブラウザでお試しください。"
        );
      }

      // ① 音声を混ぜる（音のある動画が1つもなければ、音声なし）
      const withSound = opened.filter((o) => o.audioTrack && o.item.volume > 0);
      let mixed: AudioBuffer | null = null;
      if (withSound.length > 0) {
        const ctx = new OfflineAudioContext(OUT_CHANNELS, Math.max(1, Math.ceil(total * OUT_RATE)), OUT_RATE);
        // 大きな音が重なって割れないように、軽いリミッターを通す
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        limiter.connect(ctx.destination);
        let sources = 0;
        for (const [i, o] of withSound.entries()) {
          const buffer = await decodeWholeAudio(o.audioTrack!, o.durationSec, () => canceled);
          checkCancel();
          onProgress?.(0.05 * ((i + 1) / withSound.length));
          if (!buffer) continue;
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          if (endBehavior === "loop" && o.durationSec < total) {
            node.loop = true;
            node.loopEnd = o.durationSec;
          }
          const gain = ctx.createGain();
          gain.gain.value = Math.max(0, Math.min(1, o.item.volume));
          node.connect(gain).connect(limiter);
          node.start(0);
          sources++;
        }
        if (sources > 0) mixed = await ctx.startRendering();
        checkCancel();
      }

      let audioCodec: MB.AudioCodec | null = null;
      if (mixed) {
        audioCodec = await mb.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: OUT_CHANNELS, sampleRate: OUT_RATE });
        if (!audioCodec) throw new VideoUserFacingError("お使いのブラウザでは、音声を書き出せません。別の形式（MP4・WebM）か、別のブラウザでお試しください。");
      }

      // ② 映像を1コマずつ描いて、音声と交互に書き出す
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new VideoUserFacingError("動画を描く準備ができませんでした。");
      const videoSource = new mb.CanvasSource(canvas, { codec: videoCodec, quality: mb.QUALITY_HIGH });
      const audioSource = mixed && audioCodec ? new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH }) : null;
      const output = new mb.Output({ format, target });
      output.addVideoTrack(videoSource, { frameRate: BOARD_FPS });
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start();

      const frames = Math.max(1, Math.round(total * BOARD_FPS));
      const scaleX = W / width;
      const scaleY = H / height;
      // 動画ごとに、コマの時刻の場面を順番に取り出す（置いた大きさに縮めて取り出し、描く手間を減らす）
      const streams = opened.map((o) => {
        const w = Math.max(2, Math.round(o.item.w * scaleX));
        const h = Math.max(2, Math.round(o.item.h * scaleY));
        const sink = new mb.CanvasSink(o.videoTrack, { width: w, height: h, fit: "fill", poolSize: 2 });
        const times = function* () {
          for (let f = 0; f < frames; f++) yield localTime(f / BOARD_FPS, o.durationSec, endBehavior);
        };
        return sink.canvasesAtTimestamps(times())[Symbol.asyncIterator]();
      });

      let audioWritten = 0;
      const writeAudioUntil = async (sec: number) => {
        if (!audioSource || !mixed) return;
        const until = Math.min(mixed.length, Math.round(sec * OUT_RATE));
        if (until <= audioWritten) return;
        const n = until - audioWritten;
        const part = new AudioBuffer({ length: n, numberOfChannels: OUT_CHANNELS, sampleRate: OUT_RATE });
        for (let ch = 0; ch < OUT_CHANNELS; ch++) part.copyToChannel(mixed.getChannelData(ch).subarray(audioWritten, until), ch);
        await audioSource.add(part);
        audioWritten = until;
      };

      for (let f = 0; f < frames; f++) {
        checkCancel();
        const t = f / BOARD_FPS;
        const results = await Promise.all(streams.map((s) => s.next()));
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, W, H);
        results.forEach((r, i) => {
          const wrapped = r.done ? null : r.value;
          if (!wrapped) return;
          const it = opened[i].item;
          ctx.save();
          ctx.translate(it.cx * scaleX, it.cy * scaleY);
          ctx.rotate((it.rotation * Math.PI) / 180);
          ctx.drawImage(wrapped.canvas, (-it.w * scaleX) / 2, (-it.h * scaleY) / 2, it.w * scaleX, it.h * scaleY);
          ctx.restore();
        });
        await videoSource.add(t, 1 / BOARD_FPS);
        // 音声は、映像より1秒先まで書いておく（どちらかだけがたまらないように）
        if (f % BOARD_FPS === 0) await writeAudioUntil(t + 1);
        onProgress?.(0.05 + 0.93 * ((f + 1) / frames));
      }
      await writeAudioUntil(total + 1);
      await Promise.all(streams.map((s) => s.return?.(undefined)));
      checkCancel();
      await output.finalize();
      checkCancel();
      if (assembler.size === 0) throw new VideoUserFacingError("動画の生成に失敗しました。もう一度お試しください。");

      let blob = assembler.toBlob(mimeTypeFor(container));
      if (container === "mp4") blob = await moveMoovToFront(blob);
      await verifyOutput(blob, container, audioSource !== null);
      onProgress?.(1);
      succeeded = true;
      return { blob, url: URL.createObjectURL(blob), sizeBytes: blob.size, width: W, height: H, durationSec: total, hasAudio: audioSource !== null };
    } catch (e) {
      if (e instanceof VideoCanceledByUserError || canceled) throw new VideoCanceledByUserError();
      throw toFriendlyVideoError(e);
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
      for (const o of opened) o.input.dispose();
      if (!succeeded) assembler.clear();
    }
  }
}
