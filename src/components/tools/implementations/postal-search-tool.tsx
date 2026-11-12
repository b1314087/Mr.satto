"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Segmented } from "@/components/ui/segmented";
import { ErrorMessage } from "@/components/common/error-message";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import {
  PREFECTURES,
  entryAddress,
  formatZip,
  loadPostalIndex,
  searchByAddress,
  searchByZip,
  type PostalEntry,
} from "@/lib/postal/postal-search";
import { useAnnounceToolMode } from "@/lib/guides/tool-mode";
import { usePrehydrationValue } from "@/lib/hooks/use-prehydration-value";
import { PostalBulkSection } from "./postal-bulk-section";

type Mode = "zip-to-address" | "address-to-zip";

/** コピー（使えないときは、文字を選んだ状態にする） */
function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`${label}をコピー`}
      onClick={(e) => {
        const btn = e.currentTarget;
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {
            const sel = window.getSelection();
            const target = btn.parentElement?.querySelector("[data-copy-text]");
            if (sel && target) {
              const range = document.createRange();
              range.selectNodeContents(target);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        );
      }}
      className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      {done ? "コピーしました" : "コピー"}
    </button>
  );
}

/**
 * 郵便番号・住所検索（総合改修 17）。
 * - 郵便番号 → 住所：7桁（または上3桁以上）から、住所の候補を出す。
 * - 住所 → 郵便番号：都道府県と、市区町村・町域（番地まで入れてもよい）から、郵便番号の候補を出す。
 * 住所データはこのサイトから読み込み、検索はブラウザの中だけで行う（入力は外部へ送らない）。
 */
export function PostalSearchTool({ initialMode = "zip-to-address" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  useAnnounceToolMode(mode);
  const [zipText, setZipText] = useState("");
  const zipRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  usePrehydrationValue(zipRef, zipText, setZipText);
  const [prefCode, setPrefCode] = useState<number | 0>(0);
  const [addressText, setAddressText] = useState("");
  const [results, setResults] = useState<PostalEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);

  useEffect(() => {
    loadPostalIndex().then(
      (i) => setUpdated(i.updated),
      () => {}
    );
  }, []);

  async function run(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "zip-to-address") {
        const r = await searchByZip(zipText);
        setResults(r.results);
        setTruncated(r.truncated);
      } else {
        const r = await searchByAddress(prefCode || null, addressText);
        if (!prefCode || prefCode !== r.prefCode) setPrefCode(r.prefCode);
        setResults(r.results);
        setTruncated(r.truncated);
      }
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : "検索できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Segmented
        ariaLabel="調べる向き"
        testId="postal-mode"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setResults(null);
          setError(null);
        }}
        options={[
          { value: "zip-to-address", label: "郵便番号から住所" },
          { value: "address-to-zip", label: "住所から郵便番号" },
        ]}
      />

      <form onSubmit={run} className="flex flex-col gap-3" data-testid="postal-form">
        <SettingsStack>
          {mode === "zip-to-address" ? (
            <SettingsSection n={1} title="郵便番号を入れる">
              <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
                郵便番号（7桁。上3桁以上でも探せます）
                <input
                  ref={zipRef}
            data-testid="postal-zip-input"
                  value={zipText}
                  onChange={(e) => setZipText(e.target.value)}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="例：100-0001"
                  maxLength={10}
                  className="w-48 rounded-lg border border-neutral-300 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </SettingsSection>
          ) : (
            <SettingsSection n={1} title="住所を入れる">
              <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
                都道府県
                <select
                  data-testid="postal-pref"
                  value={prefCode}
                  onChange={(e) => setPrefCode(Number(e.target.value))}
                  className="w-48 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value={0}>選んでください（住所に書いても可）</option>
                  {PREFECTURES.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
                市区町村・町域（番地まで入れても探せます）
                <input
                  data-testid="postal-address-input"
                  value={addressText}
                  onChange={(e) => setAddressText(e.target.value)}
                  autoComplete="address-level2"
                  placeholder="例：千代田区丸の内、神戸市中央区三宮町"
                  className="w-full max-w-md rounded-lg border border-neutral-300 px-3 py-2 text-base dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </SettingsSection>
          )}
        </SettingsStack>
        <button
          type="submit"
          data-testid="postal-search"
          disabled={loading}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "検索中…" : mode === "zip-to-address" ? "住所を調べる" : "郵便番号を調べる"}
        </button>
      </form>

      {error && <ErrorMessage message={error} />}

      {results && (
        <section className="flex flex-col gap-2" aria-label="検索結果" data-testid="postal-results">
          <p className="text-sm font-semibold text-ms-text" data-testid="postal-result-count">
            {results.length === 0 ? "見つかりませんでした。" : `${results.length}件${truncated ? `（多いため、先頭${results.length}件だけを表示）` : ""}`}
          </p>
          {results.length === 0 && (
            <p className="text-xs text-ms-muted">
              {mode === "zip-to-address"
                ? "番号を確かめてください。会社・役所などの個別の郵便番号は、見つからないことがあります。"
                : "字を減らす（例：「丸の内1-1-1」→「丸の内」）、市区町村だけにする、などで探してみてください。"}
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {results.map((r) => (
              <li key={`${r.zip}-${r.city}-${r.town}`} data-testid="postal-result" className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-semibold text-ms-text" data-copy-text data-testid="postal-result-zip">
                    〒{formatZip(r.zip)}
                  </span>
                  <CopyButton text={formatZip(r.zip)} label="郵便番号" testId="postal-copy-zip" />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 break-all text-sm text-ms-text" data-copy-text data-testid="postal-result-address">
                    {entryAddress(r)}
                    {r.town === "" && <span className="ml-1 text-xs text-ms-muted">（町域の指定なし）</span>}
                  </span>
                  <CopyButton text={entryAddress(r)} label="住所" testId="postal-copy-address" />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PostalBulkSection direction={mode} />

      <p className="text-xs text-ms-muted" data-testid="postal-data-note">
        住所データ：日本郵便「郵便番号データ」{updated ? `（${updated}時点）` : ""}。検索はお使いのブラウザの中で行い、入力した郵便番号・住所は外部へ送りません。
        郵便番号の変更が反映されるまでに時間がかかることがあります。大切な郵便物は、日本郵便の公式サイトでもご確認ください。
      </p>
    </div>
  );
}
