"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  CATEGORY_INFO,
  CATEGORY_ORDER,
  cleanText,
  DEFAULT_CLEAN_OPTIONS,
  getSjisTable,
  SCAN_MAX_CHARS,
  scanUnits,
  SEVERITY_LABEL,
  shouldShowAsName,
  unitsFromText,
  type CleanOptions,
  type GaijiCategory,
  type GaijiFinding,
  type GaijiScanResult,
  type GaijiSeverity,
  type ScanUnit,
} from "@/lib/gaiji/detect";
import { displayOfFinding, findingsToCsvBlob } from "@/lib/gaiji/report";
import { GAIJI_FILE_ACCEPT, GAIJI_FILE_MAX_MB, loadGaijiFile } from "@/lib/processors/browser/gaiji-files";
import { downloadBlob } from "@/lib/utils/format";

const inputClass =
  "ms-focus-ring rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "ms-focus-ring rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const mutedText = "text-xs text-neutral-500 dark:text-neutral-400";

const SEVERITY_STYLE: Record<GaijiSeverity, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  mid: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  low: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

/** 重要度の意味（結果の見方の説明。判定の規則そのものではない） */
const SEVERITY_MEANING: Record<GaijiSeverity, string> = {
  high: "まず確認してほしい文字",
  mid: "使う先（ソフト・システム）によっては、問題になる文字",
  low: "多くの場合は問題ないが、念のため知っておきたい文字",
};

const SEVERITY_ORDER: GaijiSeverity[] = ["high", "mid", "low"];

/** 1つの分類の中で、最初に表示する文字の種類の数（多いときは「すべて表示」で広げる。CSVにはすべて入る） */
const GROUP_PREVIEW_LIMIT = 50;

const CLEAN_OPTION_LABELS: [keyof CleanOptions, string][] = [
  ["removeInvisible", "不可視の文字（ゼロ幅スペース・BOMなど）を取り除く"],
  ["normalizeSpaces", "特殊な空白を、通常の半角スペースにする"],
  ["composeCombining", "濁点・半濁点の結合文字を合成する（「か」＋「゛」→「が」）"],
  ["replaceCompat", "機種依存文字・半角カナ・康熙部首を、通常の文字にする（①→1、㈱→(株)、ｱ→ア、⽇→日）"],
  ["replaceMismatch", "Shift_JISで別の文字に変わる文字を、安全な文字にする（〜→～ など）"],
];

interface Scanned {
  result: GaijiScanResult;
  /** 調べた中身（設定を変えたときに、同じ中身をもう一度調べるため） */
  units: ScanUnit[];
  /** 調べた対象の名前（貼り付けたテキスト／ファイル名） */
  sourceLabel: string;
  /** 貼り付けたテキストを調べたとき、その内容（整えたテキストの元） */
  text: string | null;
  notes: string[];
  checkShiftJis: boolean;
}

/** 外字・特殊文字チェック。文字・Word・Excel・PDFの文字を調べ、出力先で問題になりうる文字を見つける（ブラウザ内だけで処理） */
export function GaijiCheckerTool() {
  const [text, setText] = useState("");
  const [checkShiftJis, setCheckShiftJis] = useState(true);
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  /** 前の結果を消した・調べ直した、などのお知らせ */
  const [notice, setNotice] = useState<string | null>(null);
  const [cleanOptions, setCleanOptions] = useState<CleanOptions>(DEFAULT_CLEAN_OPTIONS);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<GaijiCategory>>(new Set());

  /** 調べるたびに増やす番号。途中で入力が変わった・別のファイルを選んだときに、古い処理の結果を出さないために使う */
  const runIdRef = useRef(0);
  /** 次に結果が出たとき、結果の見出しへ移動する（調べるボタン・ファイルの選択のときだけ。設定の変更では移動しない） */
  const focusResultRef = useRef(false);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sjisAvailable = useMemo(() => getSjisTable() !== null, []);
  const busy = scanning || loading !== null;

  useEffect(() => {
    if (scanned && focusResultRef.current) {
      focusResultRef.current = false;
      // 結果の見出しへ移動する（スマートフォンでは結果が画面の下に出るため。読み上げソフトにも結果が出たことが伝わる）
      resultHeadingRef.current?.focus();
    }
  }, [scanned]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  /** 新しい結果を出す（結果に付いていた状態は、すべて最初に戻す） */
  function showResult(next: Scanned) {
    focusResultRef.current = true;
    setScanned(next);
    setExpanded(new Set());
    setCopied(false);
    setCopyError(null);
    setExportError(null);
  }

  /** 結果を消す（入力が変わったなど、表示中の結果が今の入力と合わなくなったとき） */
  function discardResult(message: string | null) {
    runIdRef.current++;
    // 読み込み中のファイルがあれば、その結果は使わない（「読み込んでいます」の表示も消す）
    setLoading(null);
    if (scanned) {
      setScanned(null);
      setNotice(message);
    }
  }

  function handleTextChange(value: string) {
    setText(value);
    setError(null);
    discardResult("文字が変わったため、前の結果を消しました。もう一度「貼り付けた文字を調べる」を押してください。");
  }

  function clearInput() {
    setText("");
    setError(null);
    setNotice(null);
    runIdRef.current++;
    setLoading(null);
    setScanned(null);
  }

  function runText() {
    setError(null);
    setNotice(null);
    if (text === "") {
      setError("調べる文字が入っていません。文字を貼り付けるか、ファイルを選んでください。");
      return;
    }
    if (text.length > SCAN_MAX_CHARS) {
      setScanned(null);
      setError(`文字数が多すぎます（${SCAN_MAX_CHARS.toLocaleString("ja-JP")}文字までです）。分けて調べてください。`);
      return;
    }
    const runId = ++runIdRef.current;
    const snapshot = text;
    const sjis = checkShiftJis;
    setScanned(null);
    setScanning(true);
    // 「調べています」を画面に出してから調べる（文字数が多いと時間がかかるため、押したことが分かるように）
    setTimeout(() => {
      try {
        if (runId !== runIdRef.current) return;
        const units = unitsFromText(snapshot);
        const result = scanUnits(units, { checkShiftJis: sjis });
        if (runId !== runIdRef.current) return;
        showResult({ result, units, sourceLabel: "貼り付けたテキスト", text: snapshot, notes: [], checkShiftJis: sjis });
      } catch {
        if (runId === runIdRef.current) setError("調べている途中で問題が起きました。文字を分けて、もう一度お試しください。");
      } finally {
        setScanning(false);
      }
    }, 16);
  }

  async function handleFile(files: File[]) {
    const file = files[0];
    if (!file) return;
    const runId = ++runIdRef.current;
    setError(null);
    setNotice(null);
    setScanned(null);
    setLoading(`${file.name} を読み込んでいます…`);
    try {
      const loaded = await loadGaijiFile(file, (done, total) => {
        if (runId === runIdRef.current) setLoading(`${file.name} を読み込んでいます…（${done}/${total}ページ）`);
      });
      if (runId !== runIdRef.current) return;
      const units: ScanUnit[] = loaded.units;
      if (loaded.kind === "text" && loaded.text !== undefined) setText(loaded.text.length > SCAN_MAX_CHARS ? "" : loaded.text);
      showResult({
        result: scanUnits(units, { checkShiftJis }),
        units,
        sourceLabel: file.name,
        text: loaded.kind === "text" ? (loaded.text ?? null) : null,
        notes: loaded.notes,
        checkShiftJis,
      });
    } catch (e) {
      if (runId === runIdRef.current) setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
    } finally {
      if (runId === runIdRef.current) setLoading(null);
    }
  }

  function handleShiftJisChange(checked: boolean) {
    setCheckShiftJis(checked);
    // 結果が出ているときは、同じ中身を新しい設定で調べ直す（古い設定の結果を残さない）
    if (scanned) {
      setScanned({ ...scanned, result: scanUnits(scanned.units, { checkShiftJis: checked }), checkShiftJis: checked });
      setExpanded(new Set());
      setCopied(false);
      setCopyError(null);
      setNotice(
        checked
          ? "Shift_JISの問題も調べるように変えたため、同じ内容を調べ直しました。"
          : "Shift_JISの問題は調べないように変えたため、同じ内容を調べ直しました。"
      );
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<GaijiCategory, GaijiFinding[]>();
    for (const f of scanned?.result.findings ?? []) {
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({ category: c, findings: map.get(c)! }));
  }, [scanned]);

  const cleaned = useMemo(
    () => (scanned && scanned.text !== null ? cleanText(scanned.text, cleanOptions, { checkShiftJis: scanned.checkShiftJis }) : null),
    [scanned, cleanOptions]
  );

  function changeCleanOption(key: keyof CleanOptions, value: boolean) {
    setCleanOptions((prev) => ({ ...prev, [key]: value }));
    // 整えたテキストが変わるため、前のコピーの表示は消す
    setCopied(false);
    setCopyError(null);
  }

  async function copyCleaned() {
    if (!cleaned) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(cleaned.text);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
      setCopyError("コピーできませんでした。上の欄の文字をすべて選んで（Ctrl＋A、Macは⌘＋A）、コピーしてください。");
    }
  }

  function exportCsv() {
    if (!scanned) return;
    setExportError(null);
    try {
      downloadBlob(findingsToCsvBlob(scanned.result.findings), "外字・特殊文字チェック結果.csv");
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "ファイルを作成できませんでした");
    }
  }

  const findings = scanned?.result.findings ?? [];
  const totalKinds = findings.length;
  const totalCount = findings.reduce((sum, f) => sum + f.count, 0);
  const severityKinds = (s: GaijiSeverity) => findings.filter((f) => f.severity === s).length;

  const statusMessage = scanning
    ? "調べています…"
    : loading
      ? null
      : notice
        ? notice
        : !scanned && text === ""
          ? "文字を貼り付けるか、ファイルを選んでください。ファイルは、選ぶとすぐ調べます。"
          : !scanned
            ? "「貼り付けた文字を調べる」を押すと、下に結果が出ます。"
            : null;

  return (
    <div className="flex flex-col gap-6">
      <div data-testid="gaiji-intro" className="flex flex-col gap-2 rounded-xl bg-neutral-50 p-4 text-xs text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300">
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">使い方</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>文字を貼り付けて「貼り付けた文字を調べる」を押します（ファイルなら、選ぶだけで調べます）。</li>
          <li>見つかった文字と、その場所・対処の方法を確認します。</li>
          <li>必要なら、置き換えられる文字を直した「整えたテキスト」をコピーします。</li>
        </ol>
        <p>
          見つける文字の例：外字（私用領域の文字）、①・㈱などの機種依存文字、ゼロ幅スペースなどの見えない文字、半角カナ、異体字セレクタ、絵文字。
        </p>
        <p className={mutedText}>入力した文字・読み込んだファイルは、このブラウザの中だけで調べます。サーバーへの送信や保存はしません。</p>
      </div>

      <section className={sectionClass} aria-labelledby="gaiji-step1">
        <h2 id="gaiji-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          1. 調べる文字を入れる
        </h2>

        <label className="flex items-start gap-2 rounded-lg bg-neutral-50 p-2.5 text-xs text-neutral-600 dark:bg-neutral-900/60 dark:text-neutral-300">
          <input
            type="checkbox"
            data-testid="gaiji-sjis"
            className="ms-focus-ring mt-0.5"
            checked={checkShiftJis}
            disabled={!sjisAvailable || busy}
            onChange={(e) => handleShiftJisChange(e.target.checked)}
          />
          <span>
            <span className="font-medium text-neutral-800 dark:text-neutral-100">Shift_JIS（Windows系）で保存・取り込みする場合の問題も調べる</span>
            <br />
            機種依存文字・保存できない文字・半角カナなど、古い業務ソフトやCSVの取り込みで文字化けしやすい文字も見つけます。結果が出ているときに変えると、同じ内容を調べ直します。
            {!sjisAvailable && "（このブラウザでは、Shift_JISの判定を使えません）"}
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <label htmlFor="gaiji-text-input" className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            方法1：文字を貼り付ける
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">名簿・文章・Excelのセルなど</span>
          </label>
          <textarea
            id="gaiji-text-input"
            data-testid="gaiji-text"
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            rows={7}
            placeholder={"例）\n山田 太郎\n髙橋 花子\n佐藤 次郎（㈱サンプル）"}
            aria-describedby="gaiji-text-count gaiji-status"
            className={`${inputClass} w-full font-normal`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="gaiji-run"
              onClick={runText}
              disabled={text === "" || busy}
              aria-describedby="gaiji-status"
              className="ms-focus-ring rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              貼り付けた文字を調べる
            </button>
            <button type="button" data-testid="gaiji-clear" onClick={clearInput} disabled={(text === "" && !scanned) || busy} className={smallButton}>
              入力を消す
            </button>
            <span id="gaiji-text-count" className={mutedText}>
              {text.length.toLocaleString("ja-JP")}文字（{SCAN_MAX_CHARS.toLocaleString("ja-JP")}文字まで）
            </span>
          </div>
        </div>

        <p className="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400" aria-hidden="true">
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          または
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </p>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            方法2：ファイルを選ぶ
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">選ぶとすぐ調べます</span>
          </p>
          <FileDropzone
            accept={GAIJI_FILE_ACCEPT}
            maxSizeMB={GAIJI_FILE_MAX_MB}
            label="調べるファイルをドラッグ&ドロップ"
            hint={`またはタップして選択（テキスト・CSV・Word・Excel・PDF／${GAIJI_FILE_MAX_MB}MBまで）`}
            onFilesSelected={handleFile}
            onError={setError}
          />
        </div>

        <div id="gaiji-status" role="status" aria-live="polite" data-testid="gaiji-status" className="flex flex-col gap-1">
          {loading && (
            <p data-testid="gaiji-loading" className="text-xs text-neutral-600 dark:text-neutral-300">
              {loading}
            </p>
          )}
          {statusMessage && <p className="text-xs text-neutral-600 dark:text-neutral-300">{statusMessage}</p>}
        </div>
        {error && <ErrorMessage message={error} />}
      </section>

      {scanned && (
        <section className={sectionClass} aria-labelledby="gaiji-step2" data-testid="tool-preview">
          <h2
            id="gaiji-step2"
            ref={resultHeadingRef}
            tabIndex={-1}
            className="ms-focus-ring scroll-mt-24 rounded text-sm font-semibold text-neutral-800 dark:text-neutral-100"
          >
            2. 結果
          </h2>
          <div data-testid="gaiji-summary" className="flex flex-col gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <p className="text-xs text-neutral-600 dark:text-neutral-300">
              調べたもの：<span className="break-all">{scanned.sourceLabel}</span>（{scanned.result.totalChars.toLocaleString("ja-JP")}文字）
              {scanned.checkShiftJis ? "・Shift_JISの問題も調べました" : "・Shift_JISの問題は調べていません"}
            </p>
            {totalKinds === 0 ? (
              <>
                <p data-testid="gaiji-none" className="font-medium text-green-700 dark:text-green-400">
                  <span aria-hidden="true">✓ </span>調べ終わりました。注意が必要な文字は、見つかりませんでした。
                </p>
                <p className={mutedText}>見つからなかったことは、問題がないことの保証ではありません（下の「このチェックでできること・できないこと」をご覧ください）。</p>
              </>
            ) : (
              <>
                <p data-testid="gaiji-found" className="font-medium">
                  <span aria-hidden="true">! </span>調べ終わりました。問題になりうる文字が、{totalKinds.toLocaleString("ja-JP")}種類（合計
                  {totalCount.toLocaleString("ja-JP")}か所）見つかりました。
                </p>
                <ul data-testid="gaiji-severity-counts" className="flex flex-col gap-1 text-xs">
                  {SEVERITY_ORDER.map((s) => (
                    <li key={s} className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-2 py-0.5 font-semibold ${SEVERITY_STYLE[s]}`}>{SEVERITY_LABEL[s]}</span>
                      <span className="font-medium">{severityKinds(s)}種類</span>
                      <span className="text-neutral-500 dark:text-neutral-400">{SEVERITY_MEANING[s]}</span>
                    </li>
                  ))}
                </ul>
                <p className={mutedText}>「種類」は文字の種類の数、「か所」は見つかった場所の合計です（同じ文字が3回あれば、1種類・3か所）。</p>
              </>
            )}
          </div>
          {scanned.result.sjisUnavailable && <ErrorMessage message="このブラウザでは、Shift_JISの判定ができませんでした。Shift_JIS向けの項目は調べていません。" />}
          {scanned.notes.map((n) => (
            <p key={n} className={mutedText}>
              {n}
            </p>
          ))}

          <div className="flex flex-col gap-4">
            {grouped.map(({ category, findings: groupFindings }) => {
              const info = CATEGORY_INFO[category];
              const isExpanded = expanded.has(category);
              const shown = isExpanded ? groupFindings : groupFindings.slice(0, GROUP_PREVIEW_LIMIT);
              const hiddenCount = groupFindings.length - shown.length;
              const groupCount = groupFindings.reduce((sum, f) => sum + f.count, 0);
              return (
                <div
                  key={category}
                  data-testid="gaiji-group"
                  data-category={category}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[info.severity]}`}>{SEVERITY_LABEL[info.severity]}</span>
                    <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{info.label}</h3>
                    <span className={mutedText}>
                      {groupFindings.length.toLocaleString("ja-JP")}種類・{groupCount.toLocaleString("ja-JP")}か所
                    </span>
                  </div>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">{info.summary}</p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">対処：{info.advice}</p>
                  <ul className="flex flex-col" aria-label={`${info.label}の一覧`}>
                    {shown.map((f) => (
                      <FindingRow key={f.codePoint} finding={f} />
                    ))}
                  </ul>
                  {groupFindings.length > GROUP_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      data-testid="gaiji-group-toggle"
                      className={`${smallButton} self-start`}
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(category)) next.delete(category);
                          else next.add(category);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? "最初の50種類だけ表示する" : `すべて表示する（残り${hiddenCount.toLocaleString("ja-JP")}種類）`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {totalKinds > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <RewardedDownloadGate onDownload={exportCsv} label="結果をCSVでダウンロード" />
              </div>
              <p className={mutedText}>CSVには、問題のある文字の一覧と場所の例だけが入ります（元の文章は入りません）。表示を省いた文字も、すべて入ります。</p>
              {exportError && <ErrorMessage message={exportError} />}
            </div>
          )}

          {cleaned && scanned.text !== null && scanned.text !== "" && (
            <div data-testid="gaiji-clean" className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">3. 整えたテキスト（置き換えられる文字だけ直します）</h3>
              <p className={mutedText}>
                外字・互換漢字・補助面の文字・絵文字は、別の文字にすると意味が変わるため、勝手には置き換えません（そのまま残します）。元のテキストは変わりません。
              </p>
              <fieldset className="flex flex-col gap-1.5 text-xs text-neutral-700 dark:text-neutral-200">
                <legend className="mb-1 font-medium">直す内容（チェックを外すと、その文字は直しません）</legend>
                {CLEAN_OPTION_LABELS.map(([key, label]) => (
                  <label key={key} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="ms-focus-ring mt-0.5"
                      data-testid={`gaiji-clean-${key}`}
                      checked={cleanOptions[key]}
                      onChange={(e) => changeCleanOption(key, e.target.checked)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <ul data-testid="gaiji-clean-summary" className="grid gap-x-4 gap-y-0.5 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-300">
                <li>不可視の文字を取り除いた数：{cleaned.invisibleRemoved}</li>
                <li>空白を置き換えた数：{cleaned.spacesReplaced}</li>
                <li>濁点を合成した数：{cleaned.combiningComposed}</li>
                <li>互換文字を置き換えた数：{cleaned.compatReplaced}</li>
                <li>Shift_JIS変換で変わる文字を置き換えた数：{cleaned.mismatchReplaced}</li>
                <li>置き換えられず残った問題の文字：{cleaned.remainingProblemChars}種類</li>
              </ul>
              {cleaned.text === scanned.text && (
                <p data-testid="gaiji-clean-unchanged" className={mutedText}>
                  直せる文字はありませんでした（元のテキストと同じです）。
                </p>
              )}
              <label htmlFor="gaiji-clean-output-area" className="sr-only">
                整えたテキスト
              </label>
              <textarea
                id="gaiji-clean-output-area"
                data-testid="gaiji-clean-output"
                readOnly
                value={cleaned.text}
                rows={6}
                className={`${inputClass} w-full font-normal`}
              />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" data-testid="gaiji-copy" onClick={copyCleaned} className={smallButton}>
                  整えたテキストをコピー
                </button>
                <span role="status" aria-live="polite" className="text-xs">
                  {copied && (
                    <span data-testid="gaiji-copied" className="text-green-700 dark:text-green-400">
                      <span aria-hidden="true">✓ </span>コピーしました
                    </span>
                  )}
                </span>
              </div>
              {copyError && <ErrorMessage message={copyError} />}
            </div>
          )}
        </section>
      )}

      <section className={sectionClass} aria-labelledby="gaiji-limits">
        <h2 id="gaiji-limits" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          このチェックでできること・できないこと
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-neutral-600 dark:text-neutral-300">
          <li>文字コード（Unicodeの番号）の範囲で判定しています。検出漏れ・誤検出がありうるため、「見つからなかった」ことは、問題がないことの保証ではありません。</li>
          <li>受け取る側のフォントで実際に表示できるかどうかは、判定できません（文字コードが標準でも、フォントに字形がなければ表示されません）。</li>
          <li>外字（私用領域の文字）は、見つけることはできますが、「何の字か」は分かりません。外字の字形は、登録したパソコンの中にしか無いためです。</li>
          <li>PDFは、文字の情報を持つPDFだけを調べます。スキャンした画像の中の文字は、調べられません。</li>
          <li>Wordの箇条書きの記号（Symbol・Wingdingsフォントの●など）は、外字ではなくても、私用領域の文字として出ることがあります。</li>
          <li>Shift_JISの判定は、Windows系（CP932）の変換表に基づいています。使う業務ソフトによっては、受け付ける文字の範囲が違うことがあります。</li>
        </ul>
      </section>
    </div>
  );
}

/** 見つかった文字1種類（文字・コード・件数・場所の例）。スマートフォンの幅でも横にはみ出さないよう、表ではなく折り返す行にする */
function FindingRow({ finding: f }: { finding: GaijiFinding }) {
  const asName = shouldShowAsName(f.codePoint);
  return (
    <li
      data-testid="gaiji-row"
      data-code={f.hex}
      className="flex items-start gap-3 border-b border-neutral-100 py-2 last:border-b-0 dark:border-neutral-900"
    >
      <span
        className={`flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-md border border-neutral-300 bg-white px-1.5 text-center text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 ${
          asName ? "max-w-[9rem] text-[11px] leading-tight" : "text-xl"
        }`}
        title={f.name ?? undefined}
      >
        {displayOfFinding(f)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-neutral-700 dark:text-neutral-300">
        <p className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span>
            コード：<span className="font-mono">{f.hex}</span>
          </span>
          <span>件数：{f.count.toLocaleString("ja-JP")}か所</span>
          {!asName && f.name && <span className="text-neutral-500 dark:text-neutral-400">{f.name}</span>}
          {f.replacement && <span>置き換え案：{f.replacement}</span>}
        </p>
        <p className="break-words text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-400">
          場所：{f.locations.join("、")}
          {f.moreLocations && "　ほか"}
        </p>
      </div>
    </li>
  );
}
