"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
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
import { displayOfFinding } from "@/lib/gaiji/report";
import { findVariantChars, fontLabel, loadMjVariantIndex, shortSjisLabel, sjisNoteOf, type MjVariantIndex, type VariantFinding } from "@/lib/gaiji/variants";
import { RunBar } from "@/components/ui/run-bar";
import { StepHeading } from "@/components/ui/step-heading";

/** 戸籍・住民基本台帳などの字を、本来の形で出す書体（利用者のパソコンに入っているときだけ効く） */
const IPAMJ_FONT_FAMILY = '"IPAmj明朝", "IPAmjMincho", serif';
const IPAMJ_FONT_URL = "https://moji.or.jp/mojikiban/font/";

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

/** 1つの分類の中で、最初に表示する文字の種類の数（多いときは「すべて表示」で広げる） */
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
  /** 調べた対象の名前（貼り付けたテキスト） */
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
  const [scanning, setScanning] = useState(false);
  /** 前の結果を消した・調べ直した、などのお知らせ */
  const [notice, setNotice] = useState<string | null>(null);
  const [cleanOptions, setCleanOptions] = useState<CleanOptions>(DEFAULT_CLEAN_OPTIONS);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<GaijiCategory>>(new Set());
  // 戸籍・住民基本台帳などの字の一覧（大きいため、最初に結果を出すときに読み込む）
  const [mjIndex, setMjIndex] = useState<MjVariantIndex | null>(null);
  const [mjFailed, setMjFailed] = useState(false);

  /** 調べるたびに増やす番号。途中で入力が変わったときに、古い処理の結果を出さないために使う */
  const runIdRef = useRef(0);
  /** 次に結果が出たとき、結果の見出しへ移動する（調べるボタンのときだけ。設定の変更では移動しない） */
  const focusResultRef = useRef(false);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sjisAvailable = useMemo(() => getSjisTable() !== null, []);
  const busy = scanning;

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
    if (!mjIndex) {
      setMjFailed(false);
      loadMjVariantIndex().then(setMjIndex, () => setMjFailed(true));
    }
  }

  /** 結果を消す（入力が変わったなど、表示中の結果が今の入力と合わなくなったとき） */
  function discardResult(message: string | null) {
    runIdRef.current++;
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
    setScanned(null);
  }

  function runText() {
    setError(null);
    setNotice(null);
    if (text === "") {
      setError("調べる文字が入っていません。文字を貼り付けてください。");
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

  const variantFindings = useMemo(() => (scanned ? findVariantChars(scanned.units, mjIndex) : []), [scanned, mjIndex]);
  const mjLoading = scanned !== null && mjIndex === null && !mjFailed;

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

  const findings = scanned?.result.findings ?? [];
  const totalKinds = findings.length;
  const totalCount = findings.reduce((sum, f) => sum + f.count, 0);
  const severityKinds = (s: GaijiSeverity) => findings.filter((f) => f.severity === s).length;

  const statusMessage = scanning
    ? "調べています…"
    : notice
      ? notice
      : !scanned && text === ""
        ? "調べたい文字を貼り付けてください。"
        : !scanned
          ? "「貼り付けた文字を調べる」を押すと、下に結果が出ます。"
          : null;

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClass} aria-labelledby="gaiji-step1">
        <StepHeading n={1} as="h2" id="gaiji-step1">調べる文字を入れる</StepHeading>

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
            調べる文字を貼り付ける
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
          <RunBar>
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
          </RunBar>
        </div>

        <div id="gaiji-status" role="status" aria-live="polite" data-testid="gaiji-status" className="flex flex-col gap-1">
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

          {(variantFindings.length > 0 || mjLoading || mjFailed) && <VariantSection key={variantFindings.map((f) => f.char).join("")} findings={variantFindings} mjLoading={mjLoading} mjFailed={mjFailed} />}

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

          {cleaned && scanned.text !== null && scanned.text !== "" && (
            <div data-testid="gaiji-clean" className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <StepHeading n={3} as="h3">整えたテキスト</StepHeading>
              <p className="text-xs text-neutral-600 dark:text-neutral-300">見えない文字の削除や、①→1・ｱ→ア などの直せる文字だけを直した文章です。外字などはそのまま残します。</p>
              <details data-testid="gaiji-clean-settings" className="text-xs text-neutral-700 dark:text-neutral-200">
                <summary className="cursor-pointer font-medium text-neutral-600 dark:text-neutral-300">詳しい設定（直す内容・直した数）</summary>
                <div className="mt-2 flex flex-col gap-3">
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
                </div>
              </details>
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

/** 形の違う字（異体字）。入力した文字に、名前でよく使われる形違いの字があれば出す（検索・照合で一致しない原因の確認用） */
function VariantSection({ findings, mjLoading, mjFailed }: { findings: VariantFinding[]; mjLoading: boolean; mjFailed: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [useIpamj, setUseIpamj] = useState(false);
  // チェックを入れた字（チェックした順）。「選んだ字をコピー」で、この順につなげてコピーする
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionCopied, setSelectionCopied] = useState(false);
  const needsFont = findings.some((f) => f.variants.some((v) => v.font !== "standard"));
  const glyphStyle = useIpamj ? { fontFamily: IPAMJ_FONT_FAMILY } : undefined;

  async function copy(char: string) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(char);
      setCopied(char);
    } catch {
      setCopied(null);
      setCopyError("コピーできませんでした。文字を選んで、手でコピーしてください。");
    }
  }

  function toggleSelected(char: string, checked: boolean) {
    setSelectionCopied(false);
    setSelected((prev) => (checked ? (prev.includes(char) ? prev : [...prev, char]) : prev.filter((c) => c !== char)));
  }

  async function copySelected() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(selected.join(""));
      setSelectionCopied(true);
    } catch {
      setSelectionCopied(false);
      setCopyError("コピーできませんでした。文字を選んで、手でコピーしてください。");
    }
  }

  return (
    <div data-testid="gaiji-variants" className="flex min-w-0 flex-col gap-2 rounded-lg border border-blue-200 p-3 dark:border-blue-900">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">形の違う字（異体字）</h3>
        {findings.length > 0 && <span className={mutedText}>{findings.length.toLocaleString("ja-JP")}文字</span>}
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-300">
        入力した文字の形違いの字です（例：高→髙、辺→邊・邉）。戸籍・住民票・名簿・システムでは別の文字として扱われるため、検索や照合で一致しないことがあります。
      </p>
      {mjLoading && (
        <p data-testid="gaiji-variants-loading" className={mutedText}>
          戸籍・住民基本台帳などで使われる字の一覧を読み込んでいます…
        </p>
      )}
      {mjFailed && (
        <p data-testid="gaiji-variants-mj-failed" className="text-xs text-amber-800 dark:text-amber-300">
          戸籍・住民基本台帳などで使われる字の一覧を読み込めませんでした。基本の一覧だけで出しています。調べ直すと、もう一度読み込みます。
        </p>
      )}
      {needsFont && (
        <div
          data-testid="gaiji-font-guide"
          className="flex flex-col gap-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <p className="text-base font-semibold leading-relaxed">
            <span aria-hidden="true">⚠ </span>□になる字は、無料の書体「IPAmj明朝」を
            <a href={IPAMJ_FONT_URL} target="_blank" rel="noopener noreferrer" className="mx-0.5 underline underline-offset-2">
              ここから入れる
            </a>
            と正しく出ます。
          </p>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="ms-focus-ring h-4 w-4"
              checked={useIpamj}
              onChange={(e) => setUseIpamj(e.target.checked)}
              data-testid="gaiji-use-ipamj"
            />
            入れたあとは、ここにチェックするとIPAmj明朝で表示します
          </label>
        </div>
      )}
      {findings.length > 0 && (
        <p className="text-sm text-neutral-700 dark:text-neutral-200">
          コピーしたい字にチェックを入れて「選んだ字をコピー」を押すと、まとめてコピーできます。
        </p>
      )}
      <ul className="flex flex-col" aria-label="形の違う字の一覧">
        {findings.map((f) => (
          <li
            key={f.char}
            data-testid="gaiji-variant-row"
            data-char={f.char}
            className="flex flex-col gap-2 border-b border-neutral-100 py-2 last:border-b-0 dark:border-neutral-900"
          >
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-neutral-700 dark:text-neutral-300">
              <span className="text-lg text-neutral-900 dark:text-neutral-100">{f.char}</span>
              <span>
                コード：<span className="font-mono">{f.hex}</span>
              </span>
              <span>件数：{f.count.toLocaleString("ja-JP")}か所</span>
              <span className="text-neutral-500 dark:text-neutral-400">場所：{f.locations.join("、")}</span>
            </p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" aria-label={`${f.char}の形違いの字`}>
              {f.variants.map((v) => (
                <li
                  key={v.char}
                  data-testid="gaiji-variant"
                  data-char={v.char}
                  data-ivs={v.ivs || undefined}
                  data-selected={selected.includes(v.char) || undefined}
                  className={`flex min-w-0 items-start gap-2 rounded-md border p-2 text-[11px] leading-tight ${
                    selected.includes(v.char)
                      ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/40"
                      : "border-neutral-200 dark:border-neutral-800"
                  }`}
                >
                  <label className="flex shrink-0 cursor-pointer flex-col items-center gap-1">
                    <span
                      data-testid="gaiji-variant-glyph"
                      style={glyphStyle}
                      className="flex h-10 w-10 items-center justify-center rounded-md border border-neutral-300 bg-white text-2xl text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                    >
                      {v.char}
                    </span>
                    <input
                      type="checkbox"
                      className="ms-focus-ring h-4 w-4"
                      checked={selected.includes(v.char)}
                      onChange={(e) => toggleSelected(v.char, e.target.checked)}
                      aria-label={`「${v.char}」を選ぶ`}
                      data-testid="gaiji-variant-select"
                    />
                  </label>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-neutral-700 [overflow-wrap:anywhere] dark:text-neutral-300">{v.hex}</span>
                    {v.mj && <span className="font-mono text-neutral-700 dark:text-neutral-300">{v.mj}</span>}
                    <span className="text-neutral-600 dark:text-neutral-400" title={sjisNoteOf(v.sjis, v.ivs)}>
                      {shortSjisLabel(v.sjis, v.ivs)}
                    </span>
                    {fontLabel(v.font) && <span className="text-amber-800 dark:text-amber-300">{fontLabel(v.font)}</span>}
                    <button
                      type="button"
                      className="ms-focus-ring self-start rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                      onClick={() => copy(v.char)}
                      aria-label={`「${v.char}」をコピー`}
                      data-testid="gaiji-variant-copy"
                    >
                      {copied === v.char ? "コピーしました" : "コピー"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {selected.length > 0 && (
        <div
          data-testid="gaiji-selection-bar"
          className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-blue-300 bg-white/95 p-3 shadow-lg dark:border-blue-800 dark:bg-neutral-900/95"
        >
          <span className="text-sm text-neutral-800 dark:text-neutral-100">
            選んだ字：
            <span data-testid="gaiji-selection-chars" style={glyphStyle} className="mx-1 text-xl [overflow-wrap:anywhere]">
              {selected.join("")}
            </span>
            （{selected.length.toLocaleString("ja-JP")}字）
          </span>
          <button
            type="button"
            onClick={copySelected}
            data-testid="gaiji-selection-copy"
            className="ms-focus-ring rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {selectionCopied ? "コピーしました" : "選んだ字をコピー"}
          </button>
          <button type="button" onClick={() => { setSelected([]); setSelectionCopied(false); }} data-testid="gaiji-selection-clear" className={smallButton}>
            選択を解除
          </button>
        </div>
      )}
      {copyError && <ErrorMessage message={copyError} />}
      <ul className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-300" aria-label="表示の意味">
        <li>Shift_JISで使える：古い業務ソフト・CSV（Shift_JIS）でもそのまま使える</li>
        <li>機種依存文字：Windowsの拡張の字。Mac・古いシステムで文字化けしやすい</li>
        <li>Shift_JISにない：古い業務ソフト・CSVでは外字扱い・文字化けになりやすい</li>
        <li>異体字セレクタ付き：Shift_JISで保存すると、セレクタが消えて元の字になる</li>
      </ul>
      <p className={mutedText}>
        「異体字セレクタ付き」の字は、同じ文字コードのまま形だけを変えた字です。対応した書体（IPAmj明朝など）がないと、元の字と同じ形に見えます。MJ番号（例：MJ025759）を、文字情報基盤の検索（moji.or.jp）に入れると、本来の形を確かめられます。
      </p>
      <p className={mutedText}>
        出どころ：新字体・旧字体と異体字の公開データ（kyujitai・itaiji、MIT）と、文字情報基盤 MJ縮退マップ・MJ文字情報一覧表（© IPA 独立行政法人情報処理推進機構、CC BY-SA 2.1 JP。文字情報技術促進協議会が提供。このサイトで加工）。すべての異体字を出せるわけではありません。会社や自治体が独自に作った外字（私用領域の文字）は出ません。
      </p>
    </div>
  );
}
