"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { featureFlags } from "@/lib/config/features";
import { ErrorMessage } from "@/components/common/error-message";
import { TOOL_SEARCH_CONSENT_VERSION, TOOL_SEARCH_MAX_CHARS, type ToolSearchPick } from "@/lib/ai/tool-search";
import type { Tool } from "@/lib/tools/types";
import {
  AI_PANEL_CLASS,
  AiPanelHeader,
  AiRunButton,
  AiUnavailableNotice,
  AiUsageMeter,
  ConsentBox,
  type AiUsage,
} from "@/components/tools/implementations/shared/ai-panel-parts";

/**
 * ツール検索の「AIに相談して探す」（プレミアム。2026-11-20）。
 * 検索欄の言葉（やりたいこと）を、AIに渡して合うツールを選んでもらう。AIの利用枠を使う。
 * AIに送るのは、この欄の文章だけ（同意してから送る）。結果のツールは、サイトの一覧にあるものだけを出す。
 */

type UsageState =
  | { status: "loading" }
  | ({ status: "available" } & AiUsage)
  | { status: "unavailable"; reason: "login_required" | "not_premium" | "unavailable" };

interface Result {
  picks: ToolSearchPick[];
  steps: string[];
  note: string;
}

const UNAVAILABLE_TEXT = {
  login_required: "AIに相談して探すには、ログインが必要です。",
  not_premium: "AIに相談して探す機能は、プレミアムプランの機能です。",
  unavailable: "AIに相談して探す機能は、現在ご利用いただけません。",
} as const;

function newRequestId(): string {
  return crypto.randomUUID();
}

export function ToolSearchAi({ query, tools }: { query: string; tools: Pick<Tool, "id" | "name" | "description">[] }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [text, setText] = useState(query);
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 検索欄の言葉が変わったら、相談の文章も合わせる（実行中は変えない）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!running) setText(query.slice(0, TOOL_SEARCH_MAX_CHARS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/ai/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.available && data.usage) setUsage({ status: "available", ...data.usage });
        else setUsage({ status: "unavailable", reason: data?.reason === "login_required" || data?.reason === "not_premium" ? data.reason : "unavailable" });
      })
      .catch(() => {
        if (!cancelled) setUsage({ status: "unavailable", reason: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!featureFlags.billing) return null;

  const trimmed = text.trim();
  const canRun = usage.status === "available" && consent && trimmed.length > 0 && trimmed.length <= TOOL_SEARCH_MAX_CHARS && !running;
  const byId = new Map(tools.map((t) => [t.id, t]));

  async function run() {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/ai/tool-search", {
        signal: controller.signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ requestId: newRequestId(), text: trimmed, consent: { accepted: true, version: TOOL_SEARCH_CONSENT_VERSION } }),
      });
      const data = await res.json().catch(() => null);
      if (data?.usage) setUsage((prev) => (prev.status === "available" ? { ...prev, ...data.usage } : prev));
      if (!res.ok || !data?.ok) {
        setError(typeof data?.message === "string" ? data.message : "AIに相談できませんでした。時間をおいて、もう一度お試しください。");
        return;
      }
      setResult({ picks: Array.isArray(data.picks) ? data.picks : [], steps: Array.isArray(data.steps) ? data.steps : [], note: typeof data.note === "string" ? data.note : "" });
    } catch {
      if (!controller.signal.aborted) setError("通信に失敗しました。時間をおいて、もう一度お試しください。");
    } finally {
      abortRef.current = null;
      setRunning(false);
      setConsent(false);
    }
  }

  return (
    <div data-testid="tool-search-ai" className={AI_PANEL_CLASS}>
      <AiPanelHeader
        title="AIに相談して探す（プレミアム）"
        sub="やりたいことを文章で書くと、AIが合うツールと使う順番を教えます"
        action={
          <button
            type="button"
            data-testid="tool-search-ai-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-violet-400 bg-white px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-50 dark:border-violet-600 dark:bg-neutral-900 dark:text-violet-100 dark:hover:bg-violet-950"
          >
            {open ? "閉じる" : "相談する"}
          </button>
        }
      />
      {open && (
        <>
          {usage.status === "loading" && <p className="text-sm text-neutral-600 dark:text-neutral-300">利用状況を確認しています…</p>}
          {usage.status === "unavailable" && <AiUnavailableNotice reason={usage.reason} text={UNAVAILABLE_TEXT[usage.reason]} loginNext="/tools" />}
          {usage.status === "available" && (
            <>
              <AiUsageMeter usage={usage} />
              <label className="flex flex-col gap-1 text-sm">
                やりたいこと（{TOOL_SEARCH_MAX_CHARS}文字まで）
                <textarea
                  data-testid="tool-search-ai-text"
                  value={text}
                  maxLength={TOOL_SEARCH_MAX_CHARS}
                  rows={3}
                  disabled={running}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="例：会議を録音して、あとで議事録にしたい"
                  className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <ConsentBox testId="tool-search-ai-consent" checked={consent} onChange={setConsent}>
                この文章を、AI（OpenAI）に送って、合うツールを探すことに同意します
              </ConsentBox>
              <AiRunButton
                testId="tool-search-ai-run"
                disabled={!canRun}
                running={running}
                label="AIに相談する"
                runningLabel="AIが探しています…"
                consentGiven={consent}
                onClick={() => void run()}
                cancelTestId="tool-search-ai-cancel"
                onCancel={() => abortRef.current?.abort()}
              />
            </>
          )}
          {error && <ErrorMessage message={error} testId="tool-search-ai-error" />}
          {result && (
            <div data-testid="tool-search-ai-result" className="flex flex-col gap-3 rounded-lg bg-white p-3 dark:bg-neutral-900">
              {result.picks.length > 0 && (
                <ol className="flex flex-col gap-2">
                  {result.picks.map((p) => {
                    const tool = byId.get(p.id);
                    if (!tool) return null;
                    return (
                      <li key={p.id} data-testid="tool-search-ai-pick" data-tool-id={p.id}>
                        <Link href={`/tools/${p.id}`} className="block rounded-lg border border-neutral-200 p-2 hover:border-violet-400 dark:border-neutral-700">
                          <span className="text-sm font-semibold text-ms-accent dark:text-ms-focus">{tool.name} →</span>
                          {p.reason && <span className="mt-0.5 block text-xs text-neutral-700 dark:text-neutral-200">{p.reason}</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              )}
              {result.steps.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">使う順番</p>
                  <ol data-testid="tool-search-ai-steps" className="ml-5 list-decimal text-sm text-neutral-800 dark:text-neutral-100">
                    {result.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}
              {result.note && <p data-testid="tool-search-ai-note" className="text-sm text-neutral-700 dark:text-neutral-200">{result.note}</p>}
              {result.picks.length === 0 && !result.note && <p className="text-sm text-neutral-600">合うツールが見つかりませんでした。書き方を変えて、もう一度お試しください。</p>}
              <p className="text-xs text-neutral-500">AIの提案は目安です。ツールの説明を確かめてからお使いください。</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
