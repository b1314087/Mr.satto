"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { TrashIcon } from "@/components/ui/trash-icon";
import { applyReadings, pickDefaultVoice, sortVoices, splitForSpeech, type ReadingEntry } from "@/lib/tts/speech-text";

/**
 * 読み上げ（ブラウザの声。2026-11-18）。
 * パソコン・スマホにもともと入っている読み上げの声（Web Speech API）で、貼り付けた文章を読み上げる。
 *
 * - 最初は、端末の中だけで動く声（文章を外へ送らない声）を選んでおく。ネットを使う声（Chrome の「Google 日本語」など）を
 *   選んだときは、「文章がその声の提供元（Google など）に送られます」と知らせる。
 * - 文ごとに区切って順番に読む（長い文章を一度に渡すと、ブラウザによっては途中で止まるため）。読んでいる文に色を付ける。
 * - 読みの登録（例：「明日」→「あした」）で、読み間違いを直せる。登録した内容は保存しない（ページを閉じると消える）。
 * - 音声ファイルとしての保存はできない（ブラウザの読み上げには、音をファイルにする仕組みがないため）。
 */

type PlayState = "idle" | "playing" | "paused";

const SAMPLE_TEXT = "こんにちは。これは読み上げのテストです。読みにくい言葉は、下の「読みの登録」で直せます。";

function useVoices(): { voices: SpeechSynthesisVoice[]; supported: boolean } {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSupported(false);
      return;
    }
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);
  return { voices, supported };
}

export function TextToSpeechTool() {
  const { voices, supported } = useVoices();
  const [text, setText] = useState("");
  const [voiceUri, setVoiceUri] = useState<string>("");
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [readings, setReadings] = useState<ReadingEntry[]>([{ word: "", reading: "" }]);
  const [state, setState] = useState<PlayState>("idle");
  const [current, setCurrent] = useState<number | null>(null);
  const runIdRef = useRef(0);

  const sorted = useMemo(() => sortVoices(voices), [voices]);
  const defaultVoice = useMemo(() => pickDefaultVoice(voices), [voices]);
  const voice = sorted.find((v) => v.voiceURI === voiceUri) ?? defaultVoice;
  const chunks = useMemo(() => splitForSpeech(text), [text]);
  const usesNetwork = voice ? !voice.localService : false;

  // ページを離れるとき・閉じるときは、読み上げを止める
  useEffect(() => {
    const runId = runIdRef;
    return () => {
      runId.current++;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  function speakFrom(index: number) {
    if (!voice || chunks.length === 0) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const runId = ++runIdRef.current;
    const speakOne = (i: number) => {
      if (runId !== runIdRef.current) return;
      if (i >= chunks.length) {
        setState("idle");
        setCurrent(null);
        return;
      }
      const u = new SpeechSynthesisUtterance(applyReadings(chunks[i].text, readings));
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = rate;
      u.pitch = pitch;
      u.onstart = () => {
        if (runId === runIdRef.current) setCurrent(i);
      };
      u.onend = () => speakOne(i + 1);
      u.onerror = (e) => {
        // 止めた・次の読み上げに切り替えたときのエラーは、知らせない
        if (e.error === "canceled" || e.error === "interrupted") return;
        if (runId === runIdRef.current) speakOne(i + 1);
      };
      synth.speak(u);
    };
    setState("playing");
    setCurrent(index);
    speakOne(index);
  }

  function handlePlay() {
    if (state === "paused") {
      window.speechSynthesis.resume();
      setState("playing");
      return;
    }
    speakFrom(0);
  }

  function handlePause() {
    window.speechSynthesis.pause();
    setState("paused");
  }

  function handleStop() {
    runIdRef.current++;
    window.speechSynthesis.cancel();
    setState("idle");
    setCurrent(null);
  }

  function updateReading(i: number, patch: Partial<ReadingEntry>) {
    setReadings((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  if (!supported) {
    return (
      <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="tts-unsupported">
        このブラウザは読み上げに対応していません。Chrome・Edge・Safari の新しいものでお試しください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        読み上げる文章
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (state !== "idle") handleStop();
          }}
          rows={8}
          placeholder={SAMPLE_TEXT}
          data-testid="tts-text"
          className="rounded-lg border border-neutral-300 bg-white p-3 text-base font-normal leading-relaxed dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
          {text.length.toLocaleString()}文字・{chunks.length}文
          {text === "" && (
            <button type="button" onClick={() => setText(SAMPLE_TEXT)} className="ml-2 text-blue-600 underline dark:text-blue-400">
              例文を入れる
            </button>
          )}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="再生">
        {state !== "playing" ? (
          <button
            type="button"
            onClick={handlePlay}
            disabled={chunks.length === 0 || !voice}
            data-testid="tts-play"
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            ▶ {state === "paused" ? "続きを読む" : "読み上げる"}
          </button>
        ) : (
          <button type="button" onClick={handlePause} data-testid="tts-pause" className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">
            ❚❚ 一時停止
          </button>
        )}
        <button
          type="button"
          onClick={handleStop}
          disabled={state === "idle"}
          data-testid="tts-stop"
          className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          ■ 停止
        </button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="tts-state" data-state={state}>
          {state === "playing" && current !== null ? `${current + 1} / ${chunks.length} 文目を読んでいます` : state === "paused" ? "一時停止中" : ""}
        </span>
      </div>

      {chunks.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-3 text-sm leading-relaxed dark:border-neutral-800" data-testid="tts-chunks">
          <p className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">文を押すと、そこから読みます</p>
          {chunks.map((c, i) => (
            <button
              key={`${c.start}-${i}`}
              type="button"
              onClick={() => speakFrom(i)}
              data-testid="tts-chunk"
              data-current={current === i ? "true" : undefined}
              className={`mr-1 rounded px-0.5 text-left ${
                current === i ? "bg-amber-200 dark:bg-amber-800/60" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {c.text}
            </button>
          ))}
        </div>
      )}

      <SettingsStack>
        <SettingsSection title="声と速さ" n={1} summary={voice ? voice.name : undefined}>
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              声
              <select
                value={voice?.voiceURI ?? ""}
                onChange={(e) => {
                  setVoiceUri(e.target.value);
                  if (state !== "idle") handleStop();
                }}
                data-testid="tts-voice"
                className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
              >
                {sorted.length === 0 && <option value="">声を読み込んでいます…</option>}
                {sorted.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name}（{v.lang}）{v.localService ? "" : "・ネットを使う声"}
                  </option>
                ))}
              </select>
            </label>
            {usesNetwork && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" data-testid="tts-network-warning">
                この声は、読み上げる文章がその声の提供元（Google など）に送られます。外に出したくない文章は、「ネットを使う声」と書いていない声を選んでください。
              </p>
            )}
            <label className="flex flex-col gap-1">
              速さ：{rate.toFixed(1)}倍
              <input type="range" min={0.5} max={2} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} data-testid="tts-rate" />
            </label>
            <label className="flex flex-col gap-1">
              声の高さ：{pitch.toFixed(1)}
              <input type="range" min={0.5} max={2} step={0.1} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} data-testid="tts-pitch" />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              選べる声と声の質は、お使いのパソコン・スマホによって変わります。速さ・高さは、次の文から反映されます。
            </p>
          </div>
        </SettingsSection>

        <SettingsSection title="読みの登録" n={2} defaultOpen={false} summary={`${readings.filter((r) => r.word && r.reading).length}件`}>
          <div className="flex flex-col gap-2 text-sm" data-testid="tts-readings">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              読み間違える言葉と、読ませたい読み方を登録します（例：明日 → あした）。登録した内容は保存されず、ページを閉じると消えます。
            </p>
            {readings.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={r.word}
                  onChange={(e) => updateReading(i, { word: e.target.value })}
                  placeholder="言葉（例：明日）"
                  aria-label={`${i + 1}件目の言葉`}
                  className="w-32 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
                <span aria-hidden="true">→</span>
                <input
                  value={r.reading}
                  onChange={(e) => updateReading(i, { reading: e.target.value })}
                  placeholder="読み（例：あした）"
                  aria-label={`${i + 1}件目の読み`}
                  className="w-32 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                />
                <button
                  type="button"
                  onClick={() => setReadings((prev) => (prev.length === 1 ? [{ word: "", reading: "" }] : prev.filter((_, k) => k !== i)))}
                  aria-label={`${i + 1}件目を消す`}
                  className="rounded p-1 text-neutral-500 hover:text-red-600"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setReadings((prev) => [...prev, { word: "", reading: "" }])}
              className="self-start rounded border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
            >
              ＋ 読みを追加
            </button>
          </div>
        </SettingsSection>
      </SettingsStack>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        このツールは聞くだけで、音声ファイルとして保存することはできません（ブラウザの読み上げには、音をファイルにする仕組みがないため）。
      </p>
    </div>
  );
}
