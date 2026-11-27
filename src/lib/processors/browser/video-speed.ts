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
import { timeStretch } from "@/lib/audio/time-stretch";
import { SPEED_MAX_SOURCE_SECONDS, isValidSpeed, speedOutputFps } from "@/lib/video/speed";

export interface VideoSpeedInput {
  file: File;
  /** 速さ（2 なら2倍速、0.5 ならゆっくり） */
  speed: number;
  /** 音の高さを保つか（false のときは、テープを速く回したように高さも変わる） */
  keepPitch: boolean;
  /** 音声を消すか */
  muted: boolean;
  container: OutputContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoSpeedOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  outputContainer: OutputContainer;
  width: number;
  height: number;
  fps: number;
  inputDurationSec: number;
  durationSec: number;
  hasAudio: boolean;
}

const OUT_RATE = 48_000;

/** 動画の音声を、すき間を無音で埋めて、チャンネルごとの配列にまとめる（元のサンプリング周波数のまま） */
async function decodeAudio(track: MB.InputAudioTrack, durationSec: number, isCanceled: () => boolean): Promise<{ planes: Float32Array[]; rate: number } | null> {
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
  return any ? { planes, rate } : null;
}

/** 配列の音声を、書き出し用（48kHz・2チャンネル）の AudioBuffer にする。keepPitch が false のときは、ここで速さも変える */
async function toOutputBuffer(planes: Float32Array[], rate: number, playbackRate: number): Promise<AudioBuffer> {
  const src = new AudioBuffer({ length: planes[0].length, numberOfChannels: planes.length, sampleRate: rate });
  planes.forEach((p, ch) => src.copyToChannel(p as Float32Array<ArrayBuffer>, ch));
  const outLength = Math.max(1, Math.ceil((planes[0].length / rate / playbackRate) * OUT_RATE));
  const ctx = new OfflineAudioContext(2, outLength, OUT_RATE);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.playbackRate.value = playbackRate;
  node.connect(ctx.destination);
  node.start(0);
  return ctx.startRendering();
}

/**
 * 動画の再生速度を変える（2026-11-27）。
 * 映像：書き出すコマごとに、元の動画の「コマの時刻 × 速さ」の場面を取り出して描き直す（速くするとコマを間引き、ゆっくりにすると同じ場面を続ける）。
 * 音声：音の高さを保つときは、タイムストレッチ（src/lib/audio/time-stretch.ts）で長さだけを変える。保たないときは、再生の速さごと変える。
 * 動画はブラウザの中だけで処理し、サーバーへは送らない。
 */
export class VideoSpeedProcessor extends BrowserProcessor<VideoSpeedInput, VideoSpeedOutput> {
  async process({ file, speed, keepPitch, muted, container, onProgress, cancelSignal }: VideoSpeedInput): Promise<VideoSpeedOutput> {
    if (!isValidSpeed(speed)) throw new VideoUserFacingError("速さの指定が正しくありません。");
    await ensureMediabunny();
    const mb = mediabunny();
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

    let canceled = false;
    const onAbort = () => {
      canceled = true;
    };
    cancelSignal?.addEventListener("abort", onAbort);
    const checkCancel = () => {
      if (canceled || cancelSignal?.aborted) throw new VideoCanceledByUserError();
    };

    const info = await inspectVideoFile(file);
    const { target, assembler } = createBlobStreamTarget();
    let succeeded = false;
    try {
      if (info.durationSec > SPEED_MAX_SOURCE_SECONDS + 0.5) {
        throw new VideoUserFacingError(`変えられる動画の長さは${SPEED_MAX_SOURCE_SECONDS / 60}分までです。長い動画は、動画カット・結合で短くしてからお試しください。`);
      }
      const inDur = info.durationSec;
      const outDur = inDur / speed;
      const fps = speedOutputFps(info.bestGuessFrameRate);
      const W = Math.max(2, Math.round(info.displayWidth / 2) * 2);
      const H = Math.max(2, Math.round(info.displayHeight / 2) * 2);

      const format = outputFormatFor(container);
      const videoCodec = await mb.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width: W, height: H });
      if (!videoCodec) {
        throw new VideoUserFacingError(
          container === "mp4"
            ? "お使いのブラウザでは、この大きさのMP4の動画を作れません。WebMを選ぶか、別のブラウザでお試しください。"
            : "お使いのブラウザでは、この大きさのWebMの動画を作れません。MP4を選ぶか、別のブラウザでお試しください。"
        );
      }

      // ① 音声（元の動画に音声があり、消さないとき）
      let audio: AudioBuffer | null = null;
      const audioTrack = muted ? null : await info.input.getPrimaryAudioTrack().catch(() => null);
      if (audioTrack && (await audioTrack.canDecode().catch(() => false))) {
        const decoded = await decodeAudio(audioTrack, inDur, () => canceled);
        checkCancel();
        onProgress?.(0.04);
        if (decoded) {
          if (keepPitch) {
            const stretched = timeStretch(decoded.planes, { speed, sampleRate: decoded.rate, isCanceled: () => canceled });
            checkCancel();
            audio = await toOutputBuffer(stretched, decoded.rate, 1);
          } else {
            audio = await toOutputBuffer(decoded.planes, decoded.rate, speed);
          }
          checkCancel();
        }
      }
      onProgress?.(0.08);

      let audioCodec: MB.AudioCodec | null = null;
      if (audio) {
        audioCodec = await mb.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: 2, sampleRate: OUT_RATE });
        if (!audioCodec) throw new VideoUserFacingError("お使いのブラウザでは、音声を書き出せません。「音声を消す」を選ぶか、別のブラウザでお試しください。");
      }

      // ② 映像を1コマずつ描いて、音声と交互に書き出す
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new VideoUserFacingError("動画を描く準備ができませんでした。");
      const videoSource = new mb.CanvasSource(canvas, { codec: videoCodec, quality: mb.QUALITY_HIGH });
      const audioSource = audio && audioCodec ? new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH }) : null;
      const output = new mb.Output({ format, target });
      output.addVideoTrack(videoSource, { frameRate: fps });
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start();

      const frames = Math.max(1, Math.round(outDur * fps));
      const lastTime = Math.max(0, inDur - 1 / Math.max(1, info.bestGuessFrameRate) / 2);
      const sink = new mb.CanvasSink(info.videoTrack, { width: W, height: H, fit: "fill", poolSize: 2 });
      const times = function* () {
        for (let f = 0; f < frames; f++) yield Math.min(lastTime, (f / fps) * speed);
      };
      const stream = sink.canvasesAtTimestamps(times())[Symbol.asyncIterator]();

      let audioWritten = 0;
      const writeAudioUntil = async (sec: number) => {
        if (!audioSource || !audio) return;
        const until = Math.min(audio.length, Math.round(sec * OUT_RATE));
        if (until <= audioWritten) return;
        const part = new AudioBuffer({ length: until - audioWritten, numberOfChannels: 2, sampleRate: OUT_RATE });
        for (let ch = 0; ch < 2; ch++) part.copyToChannel(audio.getChannelData(ch).subarray(audioWritten, until), ch);
        await audioSource.add(part);
        audioWritten = until;
      };

      let last: OffscreenCanvas | HTMLCanvasElement | null = null;
      for (let f = 0; f < frames; f++) {
        checkCancel();
        const t = f / fps;
        const r = await stream.next();
        const wrapped = r.done ? null : r.value;
        if (wrapped) last = wrapped.canvas;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        if (last) ctx.drawImage(last, 0, 0, W, H);
        await videoSource.add(t, 1 / fps);
        if (f % fps === 0) await writeAudioUntil(t + 1);
        onProgress?.(0.08 + 0.9 * ((f + 1) / frames));
      }
      await writeAudioUntil(outDur + 1);
      await stream.return?.(undefined);
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
        outputContainer: container,
        width: W,
        height: H,
        fps,
        inputDurationSec: inDur,
        durationSec: outDur,
        hasAudio: audioSource !== null,
      };
    } catch (e) {
      if (e instanceof VideoCanceledByUserError || canceled) throw new VideoCanceledByUserError();
      throw toFriendlyVideoError(e);
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
      info.input.dispose();
      if (!succeeded) assembler.clear();
    }
  }
}
