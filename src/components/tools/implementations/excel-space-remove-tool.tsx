"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { ResultPopup } from "@/components/common/result-popup";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { RunBar } from "@/components/ui/run-bar";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import {
  DEFAULT_SPACE_CLEAN,
  cleanSpaces,
  cleanXlsxSpaces,
  showSpaces,
  spaceCleanOptionError,
  type SpaceCleanOptions,
  type SpaceCleanResult,
} from "@/lib/excel/xlsx-space-clean";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const MIDDLE_OPTIONS: { value: SpaceCleanOptions["middle"]; label: string; example: string }[] = [
  { value: "collapse", label: "続いた空白を1つにする", example: "山田␣␣太郎 → 山田␣太郎" },
  { value: "remove", label: "すべて消す", example: "山田␣太郎 → 山田太郎" },
  { value: "keep", label: "消さない", example: "山田␣太郎 → そのまま" },
];

/**
 * Excelセル内の不要なスペース削除（総合改修 18）。
 * 半角・全角、先頭・末尾・文字と文字の間を分けて選べる。文字のセルだけを変え、数式・数値・日付・書式・結合セルは変えない。
 * 処理はブラウザの中だけ。元のファイルは変えず、新しいExcelファイルを作る。
 */
export function ExcelSpaceRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState<SpaceCleanOptions>(DEFAULT_SPACE_CLEAN);
  const [sheetMode, setSheetMode] = useState<"all" | "one">("all");
  const [sheetIndex, setSheetIndex] = useState(0);
  const [preview, setPreview] = useState<{ key: string; result: SpaceCleanResult } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpaceCleanResult | null>(null);

  const effective: SpaceCleanOptions = useMemo(() => ({ ...opts, sheetIndexes: sheetMode === "one" ? [sheetIndex] : undefined }), [opts, sheetMode, sheetIndex]);
  const optionProblem = spaceCleanOptionError(effective);
  const key = file ? `${file.name}|${file.size}|${JSON.stringify(effective)}` : "";

  // 変わるセルの数と例（書き出しと同じ処理で数える。ファイルは作らない）
  useEffect(() => {
    if (!file || optionProblem) return;
    let cancelled = false;
    const t = setTimeout(() => {
      cleanXlsxSpaces(file, effective, { write: false, sampleMax: 30 }).then(
        (r) => {
          if (!cancelled) {
            setPreview({ key, result: r });
            setPreviewError(null);
          }
        },
        (e: unknown) => {
          if (!cancelled) setPreviewError(e instanceof Error ? e.message : "ファイルを読み取れませんでした。");
        }
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [file, key, effective, optionProblem]);

  const shown = preview && preview.key === key ? preview.result : null;
  const sheets = shown?.sheets ?? preview?.result.sheets ?? null;

  function update(p: Partial<SpaceCleanOptions>) {
    setOpts((o) => ({ ...o, ...p }));
    setResult(null);
    setStatus("idle");
  }

  async function run() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const r = await cleanXlsxSpaces(file, effective, { write: true });
      setResult(r);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file ? (
          <section data-testid="tool-preview" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変わるセルのプレビュー</p>
            {previewError && <ErrorMessage message={previewError} />}
            {optionProblem ? (
              <p className="text-xs text-red-600 dark:text-red-400">{optionProblem}</p>
            ) : !shown ? (
              <p className="text-xs text-neutral-400">調べています…</p>
            ) : (
              <>
                <p className="text-sm text-ms-text" data-testid="space-count">
                  {shown.changedCells === 0 ? "消す空白のあるセルはありませんでした。" : `${shown.changedCells}個のセルの空白を整えます。`}
                </p>
                {shown.samples.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs" data-testid="space-samples">
                      <thead>
                        <tr className="text-neutral-500">
                          <th className="py-1 pr-2 font-normal">シート・セル</th>
                          <th className="py-1 pr-2 font-normal">今</th>
                          <th className="py-1 font-normal">整えたあと</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.samples.map((s) => (
                          <tr key={`${s.sheet}-${s.cell}`} className="border-t border-neutral-200 dark:border-neutral-800">
                            <td className="py-1 pr-2 whitespace-nowrap text-neutral-500">{s.sheet}!{s.cell}</td>
                            <td className="py-1 pr-2 font-mono whitespace-pre-wrap text-red-700 dark:text-red-300">{showSpaces(s.before)}</td>
                            <td className="py-1 font-mono whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">{showSpaces(s.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {shown.changedCells > shown.samples.length && <p className="text-xs text-ms-muted">先頭{shown.samples.length}件を表示しています。</p>}
                <p className="text-xs text-ms-muted">␣＝半角スペース、□＝全角スペース。数式・数値・日付のセル、書式・列幅・結合セルは変えません。</p>
                {shown.skippedFormulaCells > 0 && <p className="text-xs text-ms-muted">数式の結果の文字（{shown.skippedFormulaCells}個）は、数式を残すため変えません。</p>}
              </>
            )}
          </section>
        ) : null
      }
    >
      <FileDropzone
        compact={!!file}
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => {
          setFile(files[0]);
          setSheetIndex(0);
          setResult(null);
          setPreview(null);
          setPreviewError(null);
          setStatus("idle");
        }}
        onError={setError}
      />
      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <SettingsStack testId="space-settings">
          <SettingsSection n={1} title="消す空白の種類" summary={[opts.halfWidth && "半角", opts.fullWidth && "全角"].filter(Boolean).join("・") || "なし"}>
            <div className="flex flex-wrap gap-4 text-sm text-neutral-700 dark:text-neutral-200">
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="space-half" checked={opts.halfWidth} onChange={(e) => update({ halfWidth: e.target.checked })} />
                半角スペース
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="space-full" checked={opts.fullWidth} onChange={(e) => update({ fullWidth: e.target.checked })} />
                全角スペース
              </label>
            </div>
          </SettingsSection>

          <SettingsSection
            n={2}
            title="消す場所"
            summary={[opts.leading && "先頭", opts.trailing && "末尾", opts.middle !== "keep" && `間（${MIDDLE_OPTIONS.find((m) => m.value === opts.middle)?.label}）`].filter(Boolean).join("・")}
          >
            <div className="flex flex-wrap gap-4 text-sm text-neutral-700 dark:text-neutral-200">
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="space-leading" checked={opts.leading} onChange={(e) => update({ leading: e.target.checked })} />
                先頭の空白
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" data-testid="space-trailing" checked={opts.trailing} onChange={(e) => update({ trailing: e.target.checked })} />
                末尾の空白
              </label>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm text-neutral-700 dark:text-neutral-200">文字と文字の間の空白</legend>
              {MIDDLE_OPTIONS.map((m) => (
                <label key={m.value} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                  <input type="radio" name="space-middle" data-testid={`space-middle-${m.value}`} checked={opts.middle === m.value} onChange={() => update({ middle: m.value })} />
                  {m.label}
                  <span className="font-mono text-xs text-ms-muted">（{m.example}）</span>
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-ms-muted">
              例：「{showSpaces("　山田　 太郎 ")}」→「{showSpaces(cleanSpaces("　山田　 太郎 ", opts))}」。セル内の改行は残します。
            </p>
          </SettingsSection>

          <SettingsSection n={3} title="対象のシート" summary={sheetMode === "all" ? "すべてのシート" : sheets?.[sheetIndex]?.name ?? ""}>
            <div className="flex flex-col gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <label className="flex items-center gap-2">
                <input type="radio" name="space-sheet" data-testid="space-sheet-all" checked={sheetMode === "all"} onChange={() => setSheetMode("all")} />
                すべてのシート
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="space-sheet" data-testid="space-sheet-one" checked={sheetMode === "one"} onChange={() => setSheetMode("one")} disabled={!sheets} />
                選んだシートだけ
              </label>
              {sheetMode === "one" && sheets && (
                <select
                  aria-label="対象のシート"
                  data-testid="space-sheet-select"
                  value={sheetIndex}
                  onChange={(e) => setSheetIndex(Number(e.target.value))}
                  className="w-fit rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {sheets.map((s, i) => (
                    <option key={`${s.name}-${i}`} value={i}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-ms-muted">選ばなかったシートの文字は変えません。</p>
            </div>
          </SettingsSection>
        </SettingsStack>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            data-testid="space-run"
            onClick={() => void run()}
            disabled={status === "processing" || !!optionProblem || !shown || shown.changedCells === 0}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            空白を整えて保存する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel="空白を整えました" />
      {error && <ErrorMessage message={error} />}

      {result?.blob && file && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="space-result">
            {result.changedCells}個のセルの空白を整えました（元のファイルは変えていません）。
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob!, `${stripExtension(file.name)}-空白削除.xlsx`)} label="Excelファイルをダウンロード" />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
