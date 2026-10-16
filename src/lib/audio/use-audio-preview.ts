"use client";

import { useEffect, useMemo, useState } from "react";
import { probeAudioFile, getWritableAudioKinds, type AudioOutputKind, type AudioProbe } from "@/lib/audio/shared";

/**
 * 選択された音声ファイルのプレビュー用URLと、軽く調べた情報（長さ・形式）を扱う共通フック。
 * URL.createObjectURL(file) を使うため、ファイルはサーバーへ送信されない。
 * ファイルが変わったとき・アンマウント時に必ずrevokeする。
 */
export function useAudioPreview(file: File | null) {
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // 解析結果は「どのファイルの結果か」と一緒に持つ。ファイルが変わった直後は
  // 古い結果を使わない（Effect内で同期的にsetStateしないため、導出で判定する）。
  const [probed, setProbed] = useState<{ file: File; probe: AudioProbe | null } | null>(null);

  useEffect(() => {
    if (!file) return;
    let canceled = false;
    void probeAudioFile(file).then((probe) => {
      if (!canceled) setProbed({ file, probe });
    });
    return () => {
      canceled = true;
    };
  }, [file]);

  const settled = probed !== null && probed.file === file;
  return {
    previewUrl,
    /** 解析が終わったか（読み込めないファイルでもtrue） */
    probeDone: settled,
    /** 解析結果。読み込めなかった場合はnull */
    probe: settled ? probed.probe : null,
  };
}

/** このブラウザで書き出せる出力形式の一覧（初回に1度だけ調べる） */
export function useWritableAudioKinds(): AudioOutputKind[] | null {
  const [kinds, setKinds] = useState<AudioOutputKind[] | null>(null);
  useEffect(() => {
    let canceled = false;
    void getWritableAudioKinds().then((k) => {
      if (!canceled) setKinds(k);
    });
    return () => {
      canceled = true;
    };
  }, []);
  return kinds;
}
