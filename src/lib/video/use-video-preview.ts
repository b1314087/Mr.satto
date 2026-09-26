"use client";

import { useEffect, useMemo, useState } from "react";

export interface VideoPreviewMeta {
  durationSec: number;
  width: number;
  height: number;
}

/**
 * 選択された動画ファイルのブラウザ内プレビュー用URLを管理する共通フック
 * （開発指示書 32章）。
 *
 * URL.createObjectURL(file) を使い、動画を一切サーバーへ送信せずに
 * <video> でのプレビュー・duration/dimensions取得を可能にする。
 * ファイルが変わった時・コンポーネントがunmountされた時に、必ず
 * URL.revokeObjectURL() で解放する（開発指示書 14章・32章）。
 *
 * previewUrlはuseMemoで導出する（Effect内でのsetStateによる連鎖的な
 * 再レンダリングを避けるため）。実際に解放が必要なタイミング（fileが
 * 変わった／unmountされた）でのみEffectを使い、cleanup関数としてrevokeする。
 *
 * durationやwidth/heightは実際に処理へ渡す値としては使わない
 * （Processor側は mediabunny の inspectVideoFile() で厳密に取得し直す）。
 * ここでの値はあくまでUI表示・プリセットの初期絞り込み用の参考値。
 */
export function useVideoPreview(file: File | null) {
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const [meta, setMeta] = useState<VideoPreviewMeta | null>(null);
  // fileが変わったタイミングで古いdurationやwidth/heightを持ち越さないよう、
  // レンダー中に直接リセットする（Reactの推奨パターン：Effectを使わず
  // レンダー中にstateを調整する。react-hooks/set-state-in-effect を避けるため）。
  const [trackedFile, setTrackedFile] = useState(file);
  if (file !== trackedFile) {
    setTrackedFile(file);
    setMeta(null);
  }

  function handleLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const video = e.currentTarget;
    setMeta({
      durationSec: video.duration || 0,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }

  return { previewUrl, meta, handleLoadedMetadata };
}

/**
 * Processorが生成したObject URL（結果の動画/画像）を、値が変わった時・
 * unmount時に確実にrevokeする（開発指示書 14-15章：ダウンロード後cleanup。
 * ただし「同じ結果を再度ダウンロードできる」UXは壊さないため、次の変換を
 * 開始する・ページを離れる、いずれかのタイミングでのみ解放する）。
 */
export function useRevokeObjectUrlOnChange(url: string | null | undefined) {
  useEffect(() => {
    // このEffectのcleanupは「urlが次の値に変わる直前」と「unmount時」の
    // 両方で実行される（Reactの仕様）。そのどちらのタイミングでも、
    // その時点のurlを解放すれば十分で、前の値を別途trackする必要はない。
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
}
