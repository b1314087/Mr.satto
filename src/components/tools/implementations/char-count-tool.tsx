"use client";

import { useEffect, useState } from "react";
import { CharCountProcessor, type CharCountOutput } from "@/lib/processors/browser/text";

const EMPTY: CharCountOutput = { characters: 0, charactersNoSpaces: 0, words: 0, lines: 0, bytes: 0 };

export function CharCountTool() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<CharCountOutput>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    new CharCountProcessor().process({ text }).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  const stats: { label: string; value: number }[] = [
    { label: "文字数", value: result.characters },
    { label: "文字数（空白除く）", value: result.charactersNoSpaces },
    { label: "単語数", value: result.words },
    { label: "行数", value: result.lines },
    { label: "バイト数 (UTF-8)", value: result.bytes },
  ];

  return (
    <div className="flex flex-col gap-6">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder="ここに文章を入力または貼り付けてください"
        className="rounded-xl border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-center dark:border-neutral-800 dark:bg-neutral-900"
          >
            <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{s.value}</p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
