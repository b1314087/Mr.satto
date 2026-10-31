"use client";

import { useMemo, useState } from "react";
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
  "rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const smallButton =
  "rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
const sectionClass = "flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";

const SEVERITY_STYLE: Record<GaijiSeverity, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  mid: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  low: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

interface Scanned {
  result: GaijiScanResult;
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
  const [cleanOptions, setCleanOptions] = useState<CleanOptions>(DEFAULT_CLEAN_OPTIONS);
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const sjisAvailable = useMemo(() => getSjisTable() !== null, []);

  function runText() {
    setError(null);
    if (text.length > SCAN_MAX_CHARS) {
      setError(`文字数が多すぎます（${SCAN_MAX_CHARS.toLocaleString("ja-JP")}文字までです）。分けて調べてください。`);
      return;
    }
    const units = unitsFromText(text);
    setScanned({ result: scanUnits(units, { checkShiftJis }), sourceLabel: "貼り付けたテキスト", text, notes: [], checkShiftJis });
  }

  async function handleFile(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);
    setScanned(null);
    setLoading(`${file.name} を読み込んでいます…`);
    try {
      const loaded = await loadGaijiFile(file, (done, total) => setLoading(`${file.name} を読み込んでいます…（${done}/${total}ページ）`));
      const units: ScanUnit[] = loaded.units;
      if (loaded.kind === "text" && loaded.text !== undefined) setText(loaded.text.length > SCAN_MAX_CHARS ? "" : loaded.text);
      setScanned({
        result: scanUnits(units, { checkShiftJis }),
        sourceLabel: file.name,
        text: loaded.kind === "text" ? (loaded.text ?? null) : null,
        notes: loaded.notes,
        checkShiftJis,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
    } finally {
      setLoading(null);
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

  async function copyCleaned() {
    if (!cleaned) return;
    try {
      await navigator.clipboard.writeText(cleaned.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("コピーできませんでした。下のテキストを選んで、コピーしてください。");
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

  const totalKinds = scanned?.result.findings.length ?? 0;
  const totalCount = scanned ? scanned.result.findings.reduce((sum, f) => sum + f.count, 0) : 0;
  const severityCounts = (s: GaijiSeverity) => (scanned?.result.findings ?? []).filter((f) => f.severity === s).length;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        入力した文字・読み込んだファイルは、このブラウザの中だけで調べます。サーバーへの送信や保存はしません。
      </p>

      <section className={sectionClass} aria-labelledby="gaiji-step1">
        <h2 id="gaiji-step1" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          1. 調べる文字を入れる
        </h2>
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          文字を貼り付けます（名簿・文章・Excelのセルなど）
          <textarea
            data-testid="gaiji-text"
            aria-label="調べる文字"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder={"山田 太郎\n髙橋 花子\n佐藤 次郎（㈱サンプル）"}
            className={`${inputClass} font-normal`}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="gaiji-run"
            onClick={runText}
            disabled={text === ""}
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            調べる
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{text.length.toLocaleString("ja-JP")}文字</span>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ファイルから調べる（テキスト・CSV・Word・Excel・PDF。選ぶとすぐ調べます。{GAIJI_FILE_MAX_MB}MBまで）
          </p>
          <FileDropzone
            accept={GAIJI_FILE_ACCEPT}
            maxSizeMB={GAIJI_FILE_MAX_MB}
            label="ファイルをドラッグ&ドロップ"
            hint="またはタップして選択（.txt .csv .tsv .md .docx .xlsx .pdf）"
            onFilesSelected={handleFile}
            onError={setError}
          />
          {loading && (
            <p data-testid="gaiji-loading" className="text-xs text-neutral-500 dark:text-neutral-400">
              {loading}
            </p>
          )}
        </div>

        <label className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            data-testid="gaiji-sjis"
            className="mt-0.5"
            checked={checkShiftJis}
            disabled={!sjisAvailable}
            onChange={(e) => setCheckShiftJis(e.target.checked)}
          />
          <span>
            Shift_JIS（Windows系）で保存・取り込みする場合の問題も調べる（機種依存文字・保存できない文字・半角カナなど。古い業務ソフトやCSVの取り込みで、文字化けしやすい文字です）。
            {!sjisAvailable && "このブラウザでは、Shift_JISの判定を使えません。"}
            チェックを変えたら、もう一度「調べる」を押してください。
          </span>
        </label>
        {error && <ErrorMessage message={error} />}
      </section>

      {scanned && (
        <section className={sectionClass} aria-labelledby="gaiji-step2" data-testid="tool-preview">
          <h2 id="gaiji-step2" className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            2. 結果
          </h2>
          <div data-testid="gaiji-summary" className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <p>
              調べたもの：{scanned.sourceLabel}（{scanned.result.totalChars.toLocaleString("ja-JP")}文字）
            </p>
            {totalKinds === 0 ? (
              <p data-testid="gaiji-none" className="font-medium text-green-700 dark:text-green-400">
                注意が必要な文字は、見つかりませんでした。
              </p>
            ) : (
              <p data-testid="gaiji-found" className="font-medium">
                問題になりうる文字：{totalKinds}種類（のべ{totalCount.toLocaleString("ja-JP")}個）　
                <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                  要確認 {severityCounts("high")}　注意 {severityCounts("mid")}　参考 {severityCounts("low")}
                </span>
              </p>
            )}
          </div>
          {scanned.result.sjisUnavailable && <ErrorMessage message="このブラウザでは、Shift_JISの判定ができませんでした。Shift_JIS向けの項目は調べていません。" />}
          {scanned.notes.map((n) => (
            <p key={n} className="text-xs text-neutral-500 dark:text-neutral-400">
              {n}
            </p>
          ))}

          <div className="flex flex-col gap-4">
            {grouped.map(({ category, findings }) => {
              const info = CATEGORY_INFO[category];
              return (
                <div key={category} data-testid="gaiji-group" data-category={category} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[info.severity]}`}>{SEVERITY_LABEL[info.severity]}</span>
                    <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{info.label}</h3>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">{findings.length}種類</span>
                  </div>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">{info.summary}</p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">対処：{info.advice}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-left text-xs">
                      <thead>
                        <tr className="border-b border-neutral-200 text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                          <th className="py-1 pr-3 font-medium">文字</th>
                          <th className="py-1 pr-3 font-medium">コード</th>
                          <th className="py-1 pr-3 font-medium">件数</th>
                          <th className="py-1 font-medium">場所の例</th>
                        </tr>
                      </thead>
                      <tbody>
                        {findings.map((f) => (
                          <tr key={f.codePoint} data-testid="gaiji-row" data-code={f.hex} className="border-b border-neutral-100 align-top dark:border-neutral-900">
                            <td className="py-1.5 pr-3 text-sm text-neutral-900 dark:text-neutral-100">
                              {displayOfFinding(f)}
                              {f.replacement && <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">→ {f.replacement}</span>}
                            </td>
                            <td className="py-1.5 pr-3 font-mono text-neutral-700 dark:text-neutral-300">{f.hex}</td>
                            <td className="py-1.5 pr-3 text-neutral-700 dark:text-neutral-300">{f.count}</td>
                            <td className="py-1.5 text-neutral-600 dark:text-neutral-400">
                              {f.locations.join("、")}
                              {f.moreLocations && "　ほか"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>

          {totalKinds > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <RewardedDownloadGate onDownload={exportCsv} label="結果をCSVでダウンロード" />
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">CSVには、問題のある文字の一覧と場所の例だけが入ります（元の文章は入りません）。</p>
              {exportError && <ErrorMessage message={exportError} />}
            </div>
          )}

          {cleaned && scanned.text !== null && scanned.text !== "" && (
            <div data-testid="gaiji-clean" className="flex flex-col gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">3. 整えたテキスト（置き換えられる文字だけ直します）</h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                外字・互換漢字・補助面の文字・絵文字は、別の文字にすると意味が変わるため、勝手には置き換えません（そのまま残します）。
              </p>
              <div className="flex flex-col gap-1.5 text-xs text-neutral-700 dark:text-neutral-200">
                {(
                  [
                    ["removeInvisible", "不可視の文字（ゼロ幅スペース・BOMなど）を取り除く"],
                    ["normalizeSpaces", "特殊な空白を、通常の半角スペースにする"],
                    ["composeCombining", "濁点・半濁点の結合文字を合成する（「か」＋「゛」→「が」）"],
                    ["replaceCompat", "機種依存文字・半角カナ・康熙部首を、通常の文字にする（①→1、㈱→(株)、ｱ→ア、⽇→日）"],
                    ["replaceMismatch", "Shift_JISで別の文字に変わる文字を、安全な文字にする（〜→～ など）"],
                  ] as [keyof CleanOptions, string][]
                ).map(([key, label]) => (
                  <label key={key} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      data-testid={`gaiji-clean-${key}`}
                      checked={cleanOptions[key]}
                      onChange={(e) => setCleanOptions((prev) => ({ ...prev, [key]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p data-testid="gaiji-clean-summary" className="text-xs text-neutral-600 dark:text-neutral-300">
                不可視の文字を取り除いた数：{cleaned.invisibleRemoved}　空白を置き換えた数：{cleaned.spacesReplaced}　濁点を合成した数：{cleaned.combiningComposed}　互換文字を置き換えた数：{cleaned.compatReplaced}
                　Shift_JIS変換で変わる文字を置き換えた数：{cleaned.mismatchReplaced}　置き換えられず残った問題の文字：{cleaned.remainingProblemChars}種類
              </p>
              <textarea data-testid="gaiji-clean-output" aria-label="整えたテキスト" readOnly value={cleaned.text} rows={6} className={`${inputClass} font-normal`} />
              <div className="flex items-center gap-3">
                <button type="button" data-testid="gaiji-copy" onClick={copyCleaned} className={smallButton}>
                  整えたテキストをコピー
                </button>
                {copied && <span className="text-xs text-green-700 dark:text-green-400">コピーしました</span>}
              </div>
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
