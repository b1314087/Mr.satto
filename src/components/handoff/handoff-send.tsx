"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { runWithDownloadAccess } from "@/lib/download/download-gate";
import { captureDownloads } from "@/lib/handoff/capture";
import { detectFileKind } from "@/lib/handoff/file-kind";
import { HandoffStoreError, putHandoff } from "@/lib/handoff/store";
import { describeNoTarget, findHandoffTargets, hasPotentialHandoffTargets, type HandoffSource } from "@/lib/handoff/targets";
import { HANDOFF_FILE_KIND_MIME, type HandoffFileInfo, type HandoffTarget } from "@/lib/handoff/types";
import { useCurrentPlan } from "@/lib/plans/plan-context";
import { formatBytes } from "@/lib/utils/format";
import { HANDOFF_QUERY_KEY, useHandoffSender } from "./handoff-provider";

/**
 * 結果のダウンロード欄に出す「ほかのツールで使う」（工程16）。RewardedDownloadGate から全ツール共通で表示する。
 *
 * 1. 押すと、ツールのダウンロード処理（onDownload）を「受け取りモード」で実行し、保存せずに結果のファイルを受け取る
 *    （src/lib/handoff/capture.ts）。ダウンロードと同じファイルなので、ツールごとの受け渡し専用コードは不要。
 * 2. 結果のファイルそのもの（種類・数・サイズ）から、受け取れるツールだけを候補に出す（src/lib/handoff/targets.ts）。
 * 3. 候補を選ぶと、ダウンロードと同じ関所（広告の確認。src/lib/download/download-gate.ts）を通してから、
 *    ファイルをメモリ上の置き場に置き、ランダムな識別子だけをURLに付けて送り先のページへ移る。
 *    受け渡しで、ダウンロードの広告確認・利用制限を回避できないようにするため。
 *
 * 受け渡せる候補が一度も出ないツール（設定なし・受け取れるツールなし）では、何も表示しない。
 * 失敗しても、元の結果はダウンロードボタンからそのまま保存できる。
 */

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "choose"; files: File[]; infos: HandoffFileInfo[]; targets: HandoffTarget[] }
  | { kind: "message"; message: string };

const MEMORY_MESSAGE = "ファイルが大きすぎるため、受け渡せませんでした。ダウンロードしてお使いください。";
const PREPARE_FAILED_MESSAGE = "結果を受け渡す準備ができませんでした。ダウンロードしてお使いください。";

export function HandoffSend({
  onDownload,
  disabled,
}: {
  onDownload: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const sender = useHandoffSender();
  const plan = useCurrentPlan();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  if (!sender) return null;
  const source: HandoffSource = { toolId: sender.toolId, hubId: sender.hubId, send: sender.send };
  if (!hasPotentialHandoffTargets(source, sender.targets, plan)) return null;

  async function open() {
    if (!sender) return;
    setPhase({ kind: "busy" });
    try {
      const captured = await captureDownloads(onDownload);
      const kinds = await Promise.all(captured.map((c) => detectFileKind(c.blob, c.filename)));
      // 名前（ダウンロード時と同じ）とMIMEタイプを保つ。MIMEタイプがない結果は、判別した種類のものを補う
      const files = captured.map(
        (c, i) =>
          new File([c.blob], c.filename, {
            type: c.blob.type || (kinds[i] ? HANDOFF_FILE_KIND_MIME[kinds[i]] : ""),
            lastModified: Date.now(),
          })
      );
      const infos: HandoffFileInfo[] = files.map((f, i) => ({ name: f.name, size: f.size, kind: kinds[i] }));
      const targets = findHandoffTargets(source, infos, sender.targets, plan);
      setPhase(
        targets.length > 0
          ? { kind: "choose", files, infos, targets }
          : { kind: "message", message: describeNoTarget(source, infos, sender.targets, plan) }
      );
    } catch {
      setPhase({ kind: "message", message: PREPARE_FAILED_MESSAGE });
    }
  }

  function sendTo(files: File[], target: HandoffTarget) {
    if (!sender) return;
    const names = files.map((f) => f.name).join("、");
    runWithDownloadAccess({
      key: files[0],
      label: `${names}（${target.name}で開く）`,
      run: () => {
        try {
          const id = putHandoff({ sourceToolId: sender.toolId, sourceName: sender.toolName, targetToolId: target.id, files });
          router.push(`/tools/${target.id}?${HANDOFF_QUERY_KEY}=${id}`);
        } catch (e) {
          setPhase({ kind: "message", message: e instanceof HandoffStoreError && e.reason === "too-large" ? MEMORY_MESSAGE : PREPARE_FAILED_MESSAGE });
        }
      },
    });
  }

  if (phase.kind === "choose") {
    const { files, infos, targets } = phase;
    return (
      <div data-testid="handoff-panel" className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-ms-border p-3 text-left">
        <p className="text-xs font-semibold text-ms-text">この結果を使えるツール</p>
        <p className="text-xs text-ms-muted break-all">
          {infos.map((f) => `${f.name}（${formatBytes(f.size)}）`).join("、")}
        </p>
        <div className="flex flex-wrap gap-2">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`handoff-target-${t.id}`}
              onClick={() => sendTo(files, t)}
              className="rounded-md border border-blue-600 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300 dark:hover:bg-blue-950/30"
            >
              {t.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="handoff-close"
          onClick={() => setPhase({ kind: "idle" })}
          className="w-fit text-xs text-ms-muted underline underline-offset-2"
        >
          閉じる
        </button>
      </div>
    );
  }

  if (phase.kind === "message") {
    return (
      <div data-testid="handoff-message" role="status" className="flex max-w-md flex-col items-center gap-1 text-xs text-ms-muted">
        <p>{phase.message}</p>
        <button type="button" onClick={() => setPhase({ kind: "idle" })} className="underline underline-offset-2">
          閉じる
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="handoff-open"
      onClick={() => void open()}
      disabled={disabled || phase.kind === "busy"}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ms-border px-3 py-1.5 text-xs font-medium text-ms-text transition-colors hover:bg-ms-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
    >
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
      </svg>
      {phase.kind === "busy" ? "準備しています…" : "ほかのツールで使う"}
    </button>
  );
}
