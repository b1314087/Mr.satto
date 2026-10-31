"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { takeHandoff, HANDOFF_TTL_MS } from "@/lib/handoff/store";
import type { HandoffReceiveSpec, HandoffSendSpec, HandoffTarget } from "@/lib/handoff/types";

/**
 * ツール間のファイル受け渡し（工程16）の、ツールページ共通の入口。ツールページ（src/app/tools/[tool]/page.tsx）が
 * 各ツールの画面を囲む。各ツールに受け渡し専用のコードは書かない。
 *
 * - 送り出し：このページのツールの設定と、受け渡し先の候補一覧（サーバーで設定から作ったもの）を、
 *   結果のダウンロード欄（RewardedDownloadGate → HandoffSend）へ渡す。
 * - 受け取り：URLの ?handoff=<識別子> を読み、ブラウザのメモリ上の置き場（src/lib/handoff/store.ts）から
 *   1回だけ取り出す。取り出したファイルは、ページで最初に表示された共通のファイル選択欄（FileDropzone）が、
 *   利用者が選んだときと同じ確認を通して受け取る。識別子はすぐにURLから消す（再読み込みで同じ処理を繰り返さない）。
 */

export const HANDOFF_QUERY_KEY = "handoff";

/** 受け取ったファイルを、画面の入力欄が受け取るまで待つ時間。過ぎたら「読み込めませんでした」と案内する */
const CLAIM_TIMEOUT_MS = 20_000;

type ReceiveState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "received"; fileNames: string[]; sourceName: string }
  | { status: "error"; message: string };

interface SenderValue {
  toolId: string;
  toolName: string;
  hubId?: string;
  send?: HandoffSendSpec;
  targets: readonly HandoffTarget[];
}

interface ReceiverValue {
  /** まだ入力欄に渡していない、受け渡されたファイルがあるか */
  hasPending: boolean;
  /**
   * 受け渡されたファイルを受け取る（1回だけ）。handler は入力欄の確認を行い、問題があれば理由を返す。
   * 問題がなければ handler の中で入力欄の処理（onFilesSelected）まで行い、null を返す。
   */
  claim: (handler: (files: File[]) => string | null) => void;
}

const SenderContext = createContext<SenderValue | null>(null);
const ReceiverContext = createContext<ReceiverValue | null>(null);

export function useHandoffSender(): SenderValue | null {
  return useContext(SenderContext);
}

export function useHandoffReceiver(): ReceiverValue | null {
  return useContext(ReceiverContext);
}

const NOT_FOUND_MESSAGE =
  "受け渡されたファイルが見つかりませんでした。ページを再読み込みした場合や、別のタブで開いた場合は、ファイルは引き継がれません。元のツールでもう一度「ほかのツールで使う」を選ぶか、ファイルを選んでください。";
const EXPIRED_MESSAGE = `受け渡しの有効期限（${HANDOFF_TTL_MS / 60_000}分）が切れたため、ファイルを読み込めませんでした。元のツールでもう一度「ほかのツールで使う」を選ぶか、ファイルを選んでください。`;
const NOT_RECEIVABLE_MESSAGE = "このツールは、ほかのツールからファイルを受け取れません。ファイルを選んでください。";
const TIMEOUT_MESSAGE = "この画面では、受け渡されたファイルを読み込めませんでした。ファイルを選んでください。";

export function ToolHandoffProvider({
  toolId,
  toolName,
  hubId,
  send,
  receive,
  receiveBlockedReason,
  targets,
  children,
}: {
  toolId: string;
  toolName: string;
  hubId?: string;
  send?: HandoffSendSpec;
  receive?: HandoffReceiveSpec;
  /** 利用者のプランでこのツールを使えない場合の理由（受け取らずに案内する） */
  receiveBlockedReason?: string | null;
  targets: readonly HandoffTarget[];
  children: ReactNode;
}) {
  const [state, setState] = useState<ReceiveState>({ status: "idle" });
  // 受け取り待ちのファイル。入力欄の effect（このコンポーネントの effect より先に動く）から読めるよう、ref に置く
  const pendingRef = useRef<{ files: File[]; sourceName: string } | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get(HANDOFF_QUERY_KEY);
    if (id === null) return;
    // 識別子はURLからすぐ消す（履歴・共有・再読み込みに残さない）
    url.searchParams.delete(HANDOFF_QUERY_KEY);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);

    let next: ReceiveState;
    if (!receive) {
      next = { status: "error", message: NOT_RECEIVABLE_MESSAGE };
    } else if (receiveBlockedReason) {
      next = { status: "error", message: receiveBlockedReason };
    } else {
      const result = takeHandoff(id, toolId);
      if (result.ok) {
        pendingRef.current = { files: result.entry.files, sourceName: result.entry.sourceName };
        next = { status: "pending" };
      } else {
        next = { status: "error", message: result.reason === "expired" ? EXPIRED_MESSAGE : NOT_FOUND_MESSAGE };
      }
    }
    // URL（ブラウザの外部の値）を読んだ結果を、表示に反映する
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
  }, [toolId, receive, receiveBlockedReason]);

  // 入力欄が受け取らないまま時間が過ぎたら、待つのをやめて案内する
  useEffect(() => {
    if (state.status !== "pending") return;
    const timer = window.setTimeout(() => {
      if (!pendingRef.current) return;
      pendingRef.current = null;
      setState({ status: "error", message: TIMEOUT_MESSAGE });
    }, CLAIM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.status]);

  const claim = useCallback((handler: (files: File[]) => string | null) => {
    const pending = pendingRef.current;
    if (!pending) return;
    // 先に空にして、二重に受け取らない（開発時の二重実行・複数の入力欄に備える）
    pendingRef.current = null;
    const problem = handler(pending.files);
    setState(
      problem
        ? { status: "error", message: `受け渡されたファイルを読み込めませんでした。${problem}` }
        : { status: "received", fileNames: pending.files.map((f) => f.name), sourceName: pending.sourceName }
    );
  }, []);

  const sender = useMemo<SenderValue>(
    () => ({ toolId, toolName, hubId, send, targets }),
    [toolId, toolName, hubId, send, targets]
  );
  const receiver = useMemo<ReceiverValue>(() => ({ hasPending: state.status === "pending", claim }), [state.status, claim]);

  return (
    <SenderContext.Provider value={sender}>
      <ReceiverContext.Provider value={receiver}>
        {state.status === "received" && (
          <div
            data-testid="handoff-received"
            role="status"
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-200"
          >
            <p>
              <span className="font-semibold">「{state.sourceName}」の結果</span>を受け取りました：
              <span data-testid="handoff-received-names" className="ml-1 font-medium break-all">
                {state.fileNames.join("、")}
              </span>
            </p>
            <DismissButton onClick={() => setState({ status: "idle" })} />
          </div>
        )}
        {state.status === "error" && (
          <div
            data-testid="handoff-error"
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
          >
            <p>{state.message}</p>
            <DismissButton onClick={() => setState({ status: "idle" })} />
          </div>
        )}
        {children}
      </ReceiverContext.Provider>
    </SenderContext.Provider>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="この案内を閉じる"
      className="shrink-0 rounded px-1.5 text-sm leading-none opacity-70 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-600"
    >
      ×
    </button>
  );
}
