import type * as MB from "mediabunny";
import { BrowserProcessor } from "../types";
import {
  VideoAudioWouldBeLostError,
  VideoCanceledByUserError,
  VideoUserFacingError,
  inspectVideoFile,
  toFriendlyVideoError,
} from "@/lib/video/shared";
import { createBlobStreamTarget } from "@/lib/video/stream-output";
import { buildWebVtt, type ResolvedCue, type SubtitleLanguage, SUBTITLE_LANGUAGE_OPTIONS } from "@/lib/video/subtitles";
import { drawSubtitles, type SubtitleBackground } from "@/lib/video/subtitle-render";
import { runConversion, type OutputContainer } from "@/lib/video/shared";
import { ensureMediabunny, mediabunny } from "@/lib/media/mediabunny-loader";

/**
 * 動画字幕追加：字幕を、動画とは別の字幕トラック（WebVTT）として入れた動画を書き出す。
 *
 * ■ 出力形式（調査で確認した結果）
 *   - MKV（Matroska）：どの動画でも映像・音声をそのまま（再エンコードせずに）入れられる。字幕トラックは
 *     「S_TEXT/WEBVTT」。VLC で字幕のON・OFF、表示位置・文字色・背景・文字サイズの反映を確認した。
 *   - WebM：元の動画が WebM（VP8・VP9・AV1 と Opus・Vorbis）のときだけ選べる（それ以外は映像の作り直しが要るため出さない）。
 *   - MP4：字幕データ（wvtt）は正しく入るが、確認できた再生アプリ（VLC・Chrome）で表示されなかったため、選択肢に出さない。
 *   ※ ブラウザ（Chrome・Edge など）の動画再生や、動画投稿サイト・SNS は、動画の中の字幕トラックを表示しない。
 *     そのため、字幕だけのファイル（.vtt・.srt）も保存できるようにしている（画面側）。
 *
 * ■ 処理
 *   mediabunny の Conversion を「composable」（出力の開始・終了をこちらで行う形）で使い、映像・音声は
 *   コピー（作り直さない）を優先して流し込む。字幕トラックは TextSubtitleSource で WebVTT の文字を渡す。
 *   出力は StreamTarget で少しずつ受け取り、Blob の小片として持つ（動画全体を1つの配列に読み込まない）。
 *
 * ■ 字幕の時間のずれを防ぐ
 *   MKV・WebM は、時間がマイナスのデータ（AAC音声の先頭など）をそのまま入れられないため、映像・音声を
 *   まとめて少しだけ後ろへずらす（copy.shiftTolerance）。そのぶん、字幕の時間も同じだけずらして、映像との
 *   ずれが出ないようにする（subtitleShiftFor）。
 */

export type SubtitleContainer = "mkv" | "webm";

export const SUBTITLE_CONTAINER_OPTIONS: { value: SubtitleContainer; label: string; ext: string; mime: string }[] = [
  { value: "mkv", label: "MKV", ext: "mkv", mime: "video/x-matroska" },
  { value: "webm", label: "WebM", ext: "webm", mime: "video/webm" },
];

/** 映像・音声をそのまま入れるために、ずらしてよい時間の上限（秒）。AAC の先頭（約0.02〜0.05秒）に足りる長さ */
const COPY_SHIFT_TOLERANCE_SEC = 0.5;

const WEBM_VIDEO_CODECS = ["vp8", "vp9", "av1"];
const WEBM_AUDIO_CODECS = ["opus", "vorbis"];

/** 選んだ動画の、字幕の書き出しに必要な情報 */
export interface SubtitleSourceProbe {
  durationSec: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  /** 書き出せる形式（映像・音声を作り直さずに入れられる形式だけ） */
  containers: SubtitleContainer[];
}

/** WebM に、映像・音声を作り直さずに入れられるか */
export function canCopyIntoWebm(videoCodec: string | null, audioCodec: string | null, hasAudio: boolean): boolean {
  if (!videoCodec || !WEBM_VIDEO_CODECS.includes(videoCodec)) return false;
  if (hasAudio && (!audioCodec || !WEBM_AUDIO_CODECS.includes(audioCodec))) return false;
  return true;
}

/** 動画を調べ、書き出せる形式を返す（ファイルを選んだときに使う） */
export async function probeSubtitleSource(file: File): Promise<SubtitleSourceProbe> {
  await ensureMediabunny();
  const info = await inspectVideoFile(file);
  try {
    const audio = await info.input.getPrimaryAudioTrack().catch(() => null);
    const audioCodec = audio ? await audio.getCodec().catch(() => null) : null;
    const containers: SubtitleContainer[] = ["mkv"];
    if (canCopyIntoWebm(info.codec, audioCodec, audio !== null)) containers.push("webm");
    return { durationSec: info.durationSec, hasAudio: audio !== null, videoCodec: info.codec, audioCodec, containers };
  } finally {
    info.input.dispose();
  }
}

/**
 * MKV・WebM へコピーするときに、映像・音声がずらされる時間（秒）。字幕も同じだけずらす。
 * いちばん早いデータの時間がマイナスなら、それが0になるようにずらされる（上限 COPY_SHIFT_TOLERANCE_SEC）。
 */
export function subtitleShiftFor(firstTimestamps: (number | null)[]): number {
  const known = firstTimestamps.filter((t): t is number => t !== null && Number.isFinite(t));
  if (known.length === 0) return 0;
  const min = Math.min(...known);
  if (min >= 0) return 0;
  return -min <= COPY_SHIFT_TOLERANCE_SEC ? -min : 0;
}

async function firstPacketTimestamp(track: MB.InputTrack | null): Promise<number | null> {
  if (!track) return null;
  try {
    const sink = new (mediabunny().EncodedPacketSink)(track);
    const packet = await sink.getFirstPacket({ metadataOnly: true });
    return packet ? packet.timestamp : null;
  } catch {
    return null;
  }
}

function shiftCues(cues: ResolvedCue[], shift: number): ResolvedCue[] {
  if (shift === 0) return cues;
  return cues.map((c) => ({ ...c, startSec: c.startSec + shift, endSec: c.endSec + shift }));
}

/** ファイルの先頭（トラックの情報）に、WebVTT の字幕トラックがあるか（mediabunny は字幕トラックを読み込まないため、直接確かめる） */
export async function hasMatroskaWebVttTrack(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());
  const needle = new TextEncoder().encode("S_TEXT/WEBVTT");
  outer: for (let i = 0; i + needle.length <= head.length; i++) {
    for (let j = 0; j < needle.length; j++) if (head[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export interface VideoSubtitleInput {
  file: File;
  cues: ResolvedCue[];
  /** 字幕の背景（帯）。全体の設定 */
  background: SubtitleBackground;
  language: SubtitleLanguage;
  container: SubtitleContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoSubtitleOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  container: SubtitleContainer;
  cueCount: number;
  /** 映像・音声を作り直さずに入れたか */
  videoCopied: boolean;
  audioCopied: boolean | null;
  /** 字幕をずらした時間（秒）。映像・音声と同じだけずらしている */
  shiftSec: number;
}

export class VideoSubtitleProcessor extends BrowserProcessor<VideoSubtitleInput, VideoSubtitleOutput> {
  async process({ file, cues, background, language, container, onProgress, cancelSignal }: VideoSubtitleInput): Promise<VideoSubtitleOutput> {
    await ensureMediabunny();
    if (cues.length === 0) throw new VideoUserFacingError("字幕が1件も登録されていません。字幕を追加してから書き出してください。");
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

    const info = await inspectVideoFile(file);
    const { target, assembler } = createBlobStreamTarget();
    let succeeded = false;
    try {
      const audioTrack = await info.input.getPrimaryAudioTrack().catch(() => null);
      const audioCodec = audioTrack ? await audioTrack.getCodec().catch(() => null) : null;
      if (container === "webm" && !canCopyIntoWebm(info.codec, audioCodec, audioTrack !== null)) {
        throw new VideoUserFacingError("この動画は、WebM 形式では字幕を追加できません。MKV 形式を選んでください。");
      }

      const shiftSec = subtitleShiftFor([await firstPacketTimestamp(info.videoTrack), await firstPacketTimestamp(audioTrack)]);
      const format = container === "webm" ? new (mediabunny().WebMOutputFormat)() : new (mediabunny().MkvOutputFormat)();
      const output = new (mediabunny().Output)({ format, target });

      const conversion = await mediabunny().Conversion.init({
        input: info.input,
        output,
        composable: true,
        copy: { shiftTolerance: COPY_SHIFT_TOLERANCE_SEC },
        showWarnings: false,
      });
      const droppedVideo = conversion.discardedTracks.find((t) => t.track.type === "video");
      if (droppedVideo || !conversion.isValid) {
        throw new VideoUserFacingError("お使いのブラウザでは、この動画の映像を書き出せません。別のブラウザか、別の形式の動画でお試しください。");
      }
      const droppedAudio = conversion.discardedTracks.find((t) => t.track.type === "audio" && t.reason !== "discarded_by_user");
      if (droppedAudio) {
        throw new VideoAudioWouldBeLostError("お使いのブラウザでは、この動画の音声を残したまま字幕を追加できません。別のブラウザでお試しください。");
      }

      // 字幕トラック（映像・音声のあと＝3つ目のトラックとして入れる）
      const subtitleSource = new (mediabunny().TextSubtitleSource)("webvtt");
      const lang = SUBTITLE_LANGUAGE_OPTIONS.find((o) => o.value === language) ?? SUBTITLE_LANGUAGE_OPTIONS[0];
      output.addSubtitleTrack(subtitleSource, {
        languageCode: lang.value,
        name: lang.trackName,
        disposition: { default: true },
      });

      if (onProgress) conversion.onProgress = (p) => onProgress(p);
      let canceledByUser = false;
      const onAbort = () => {
        canceledByUser = true;
        void conversion.cancel();
      };
      cancelSignal?.addEventListener("abort", onAbort);
      try {
        if (cancelSignal?.aborted) throw new VideoCanceledByUserError();
        await output.start();
        await subtitleSource.add(buildWebVtt(shiftCues(cues, shiftSec), background));
        subtitleSource.close();
        await conversion.execute();
        if (canceledByUser || cancelSignal?.aborted) throw new VideoCanceledByUserError();
        await output.finalize();
      } catch (e) {
        if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => undefined);
        if (canceledByUser || e instanceof VideoCanceledByUserError) throw new VideoCanceledByUserError();
        throw toFriendlyVideoError(e);
      } finally {
        cancelSignal?.removeEventListener("abort", onAbort);
      }

      if (assembler.size === 0) throw new VideoUserFacingError("字幕つきの動画を作れませんでした。もう一度お試しください。");
      const option = SUBTITLE_CONTAINER_OPTIONS.find((o) => o.value === container)!;
      const blob = assembler.toBlob(option.mime);
      const copied = await verifySubtitleOutput(blob, container, info.videoTrack, audioTrack);
      // 書き出しのあとの確認中にキャンセルされた場合も、結果を使わない
      if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

      succeeded = true;
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes: blob.size,
        container,
        cueCount: cues.length,
        videoCopied: copied.video,
        audioCopied: audioTrack ? copied.audio : null,
        shiftSec,
      };
    } finally {
      if (!succeeded) assembler.clear();
      info.input.dispose();
    }
  }
}

/** 先頭のデータが元の動画と同じバイト列か（同じなら、作り直さずにそのまま入れた） */
async function samePacketData(a: MB.InputTrack, b: MB.InputTrack): Promise<boolean> {
  try {
    const [pa, pb] = await Promise.all([
      new (mediabunny().EncodedPacketSink)(a).getFirstPacket(),
      new (mediabunny().EncodedPacketSink)(b).getFirstPacket(),
    ]);
    if (!pa || !pb || pa.data.byteLength !== pb.data.byteLength) return false;
    for (let i = 0; i < pa.data.byteLength; i++) if (pa.data[i] !== pb.data[i]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 書き出したファイルを読み直し、映像・（あれば）音声・字幕トラックが入っていることを確かめる。
 * あわせて、映像・音声を作り直さずに入れたか（先頭のデータが同じか）を返す。
 */
async function verifySubtitleOutput(
  blob: Blob,
  container: SubtitleContainer,
  sourceVideo: MB.InputVideoTrack,
  sourceAudio: MB.InputAudioTrack | null
): Promise<{ video: boolean; audio: boolean }> {
  const copied = { video: false, audio: false };
  const check = new (mediabunny().Input)({
    source: new (mediabunny().BlobSource)(blob),
    formats: container === "webm" ? [mediabunny().WEBM] : [mediabunny().MATROSKA],
  });
  try {
    const video = await check.getPrimaryVideoTrack().catch(() => null);
    if (!video) throw new VideoUserFacingError("書き出した動画を確認できませんでした。もう一度お試しください。");
    copied.video = await samePacketData(sourceVideo, video);
    if (sourceAudio) {
      const audio = await check.getPrimaryAudioTrack().catch(() => null);
      if (!audio) throw new VideoAudioWouldBeLostError("書き出した動画に音声が入りませんでした。別のブラウザでお試しください。");
      copied.audio = await samePacketData(sourceAudio, audio);
    }
  } finally {
    check.dispose();
  }
  if (!(await hasMatroskaWebVttTrack(blob))) {
    throw new VideoUserFacingError("字幕トラックを書き出せませんでした。もう一度お試しください。");
  }
  return copied;
}

// ---------------------------------------------------------------------------
// 映像に焼き付ける（総合改修 11）
// ---------------------------------------------------------------------------

export interface VideoSubtitleBurnInput {
  file: File;
  cues: ResolvedCue[];
  background: SubtitleBackground;
  container: OutputContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
  /** 音声を書き出せないときに、音声なしで書き出す（利用者が選んだときだけ） */
  dropAudio?: boolean;
}

export interface VideoSubtitleBurnOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  container: OutputContainer;
  cueCount: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/**
 * 字幕を映像に焼き付けた動画を書き出す（見た目どおり。どの再生アプリ・SNSでも表示される）。
 * 1コマずつ、プレビューと同じ描画関数（drawSubtitles）で字幕を描き、映像を作り直す。音声はできるだけそのまま入れる。
 * フォント・縁取り・位置・フェードなど、字幕ごとの見た目がそのまま反映される。
 */
export class VideoSubtitleBurnProcessor extends BrowserProcessor<VideoSubtitleBurnInput, VideoSubtitleBurnOutput> {
  async process({ file, cues, background, container, onProgress, cancelSignal, dropAudio }: VideoSubtitleBurnInput): Promise<VideoSubtitleBurnOutput> {
    await ensureMediabunny();
    if (cues.length === 0) throw new VideoUserFacingError("字幕が1件も登録されていません。字幕を追加してから書き出してください。");
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();
    const info = await inspectVideoFile(file);
    try {
      const W = info.displayWidth;
      const H = info.displayHeight;
      let canvas: OffscreenCanvas | HTMLCanvasElement;
      if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(W, H);
      else {
        canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
      }
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("この環境では、字幕を焼き付けられません。");
      const process = (sample: MB.VideoSample) => {
        ctx.clearRect(0, 0, W, H);
        // 回転の情報（縦向きに撮った動画など）も反映して、表示の向きで描く
        sample.draw(ctx, 0, 0, W, H);
        drawSubtitles(ctx, W, H, cues, sample.timestamp, background);
        return canvas;
      };
      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container,
        video: { process, processedWidth: W, processedHeight: H, forceTranscode: true },
        onProgress,
        cancelSignal,
        dropAudio,
      });
      return { blob, url: URL.createObjectURL(blob), sizeBytes, container, cueCount: cues.length, width: W, height: H, hasAudio: info.hasAudio && !dropAudio };
    } catch (e) {
      if (e instanceof VideoCanceledByUserError || e instanceof VideoAudioWouldBeLostError) throw e;
      throw toFriendlyVideoError(e);
    } finally {
      info.input.dispose();
    }
  }
}
