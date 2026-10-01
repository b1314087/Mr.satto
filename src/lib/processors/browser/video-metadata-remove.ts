import { WEBM } from "mediabunny";
import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  inspectVideoFile,
  runConversion,
  type OutputContainer,
} from "@/lib/video/shared";

export interface VideoMetadataRemoveInput {
  file: File;
  onProgress?: (progress: number) => void;
}

export interface VideoMetadataRemoveOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  outputContainer: OutputContainer;
}

/**
 * 動画メタデータ削除。
 *
 * 入力動画を再マルチプレクス（必要な場合のみ再エンコード）し、出力に
 * メタデータタグを一切引き継がない（`runConversion` に `tags: {}` を
 * 明示的に渡す）。mediabunnyの既定動作では入力のメタデータタグが
 * そのまま出力にコピーされるため、単なるコンテナ変換・リネームでは
 * メタデータは消えない。本ツールはこの既定動作を明示的に上書きする
 * ことで、タイトル・作成者・コメント等の記述系メタデータ
 * （MP4/MOVの場合はudtaアトム内の生データを含む。GPS位置情報の多くは
 * ここに格納される）を除去する。
 *
 * 映像・音声そのものは `video` / `audio` オプションを指定しないことで、
 * 既存の変換系ツールと同様に「コーデックが変換先コンテナでそのまま
 * 使える場合は再エンコードなしでコピーする」mediabunnyの既定動作に
 * 委ね、不要な画質劣化を避ける。出力コンテナはユーザーに選ばせず、
 * 入力コンテナから自動判定する（WebM入力→WebM出力、それ以外（MP4/MOV）
 * →MP4出力）ことで、最もロスレスな変換経路を自動的に選択する。
 *
 * 回転・反転表示用のメタデータ（allowTransformationMetadata /
 * allowRotationMetadata）は個人情報ではないため既定値（true）のまま
 * 保持し、縦撮り動画が横倒しで出力されることを防ぐ。
 *
 * 注意：コンテナ形式・エンコーダの実装によっては、すべてのメタデータ
 * フィールドの除去を100%保証できるわけではない（詳細はSEO/UI文言を
 * 参照）。本ツールが確実に除去するのは、mediabunnyが正規化して
 * 読み書きする記述系メタデータタグ（タイトル・作成者・コメント・
 * 日付等、およびMP4/MOVのudtaアトム内の生メタデータ）である。
 */
export class VideoMetadataRemoveProcessor extends BrowserProcessor<
  VideoMetadataRemoveInput,
  VideoMetadataRemoveOutput
> {
  async process({ file, onProgress }: VideoMetadataRemoveInput): Promise<VideoMetadataRemoveOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.metadataRemove * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.metadataRemove}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const inputFormat = await info.input.getFormat();
      const outputContainer: OutputContainer = inputFormat === WEBM ? "webm" : "mp4";

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
        tags: {},
        onProgress,
      });

      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        width: info.displayWidth,
        height: info.displayHeight,
        outputContainer,
      };
    } finally {
      info.input.dispose();
    }
  }
}
