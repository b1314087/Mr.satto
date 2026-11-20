"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 話して探す（ツール検索のマイクのボタン。2026-11-20・無料）。
 * ブラウザの音声認識（Web Speech API）で、話した言葉を検索欄に入れる。
 * - 音声認識に対応していないブラウザ（Firefox など）では、ボタンを出さない。
 * - Chrome などでは、音声がブラウザの会社の音声認識サービスに送られて文字になる（このサイトのサーバーには送らない）。
 * - 1回話すと止まる（話し終えたら、そのまま検索する）。
 */

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "マイクが許可されていません。ブラウザの設定でマイクを許可してください。",
  "service-not-allowed": "このブラウザでは、話して探す機能を使えません。",
  "audio-capture": "マイクが見つかりませんでした。",
  network: "音声認識サービスに接続できませんでした。",
  "no-speech": "声が聞き取れませんでした。もう一度お試しください。",
};

export function VoiceSearchButton({
  onResult,
  onInterim,
  className = "",
  testId = "voice-search",
}: {
  /** 話し終えた言葉（ここで検索する） */
  onResult: (text: string) => void;
  /** 話している途中の言葉（検索欄に途中経過を出す） */
  onInterim?: (text: string) => void;
  className?: string;
  testId?: string;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(recognitionCtor() !== null);
    return () => recRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0]?.transcript ?? "";
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      onInterim?.((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      setMessage(ERROR_TEXT[e.error] ?? "うまく聞き取れませんでした。もう一度お試しください。");
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      const text = finalText.trim();
      if (text) onResult(text);
    };
    recRef.current = rec;
    setMessage(null);
    try {
      rec.start();
      setListening(true);
    } catch {
      setMessage("話して探す機能を始められませんでした。");
    }
  }

  return (
    <span className={`absolute top-1/2 -translate-y-1/2 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-label={listening ? "聞き取りをやめる" : "話して探す"}
        aria-pressed={listening}
        title={listening ? "聞き取りをやめる" : "話して探す（マイク）"}
        data-testid={testId}
        className={`ms-focus-ring flex h-8 w-8 items-center justify-center rounded-full ${listening ? "animate-pulse bg-red-600 text-white" : "text-ms-muted hover:bg-ms-hover-tint hover:text-ms-text"}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
      {(listening || message) && (
        <span
          role="status"
          data-testid={`${testId}-status`}
          className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-ms-border bg-ms-strong px-3 py-2 text-xs text-ms-text shadow-[var(--ms-shadow-lift)]"
        >
          {listening ? "聞き取っています…やりたいことを話してください（例：PDFを小さくしたい）" : message}
        </span>
      )}
    </span>
  );
}
