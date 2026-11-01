import type { DocumentType } from "./types";

/**
 * 書類番号（管理番号）の組み立て。
 *
 * 形：「記号-発行日-末尾」。例: INV-20261101-001 / INV-20261101-1513
 * - 記号: 見積書=EST、請求書=INV、注文書=ORD
 * - 日付: 入力された「発行日」（未入力・不正なときは今日）
 * - 末尾: 通し番号（001〜）か、作成した時刻（時分 4桁）
 *
 * 通し番号の「前回どこまで使ったか」は、このブラウザの中（localStorage）だけに覚える。
 * サーバーには送らない。別のパソコン・ブラウザでは、また 001 から始まる。
 */

export type DocumentNumberTailMode = "serial" | "time";

export const DOCUMENT_NUMBER_PREFIX: Record<DocumentType, string> = {
  estimate: "EST",
  invoice: "INV",
  order: "ORD",
};

/** 通し番号のプルダウンに並べる数（001〜050） */
export const DOCUMENT_SERIAL_MAX = 50;

export const DOCUMENT_SERIAL_OPTIONS: number[] = Array.from({ length: DOCUMENT_SERIAL_MAX }, (_, i) => i + 1);

/** localStorage のキー。中身は {"invoice:20261101": 3, ...}（種類・日付ごとの、最後に使った通し番号） */
export const DOCUMENT_SERIAL_STORAGE_KEY = "ms-document-serial:v1";

export function formatSerial(n: number): string {
  return String(n).padStart(3, "0");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-01" → "20261101"。読めないときは now の日付 */
export function compactIssueDate(issueDate: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(issueDate.trim());
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

/** 時刻の末尾（時分 4桁）。例: 15:13 → "1513" */
export function timeTail(now: Date = new Date()): string {
  return `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

export function buildDocumentNumber(args: {
  type: DocumentType;
  issueDate: string;
  mode: DocumentNumberTailMode;
  serial: number;
  now?: Date;
}): string {
  const now = args.now ?? new Date();
  const tail = args.mode === "time" ? timeTail(now) : formatSerial(args.serial);
  return `${DOCUMENT_NUMBER_PREFIX[args.type]}-${compactIssueDate(args.issueDate, now)}-${tail}`;
}

export function serialKey(type: DocumentType, issueDate: string, now: Date = new Date()): string {
  return `${type}:${compactIssueDate(issueDate, now)}`;
}

/** 保存されている文字列から、種類・日付ごとの「最後に使った通し番号」を読む（壊れていれば空） */
export function parseSerialStore(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 999) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** 次に選んでおく通し番号（前回の次。上限を超えたら上限のまま） */
export function suggestNextSerial(store: Record<string, number>, key: string): number {
  const last = store[key] ?? 0;
  return Math.min(last + 1, DOCUMENT_SERIAL_MAX);
}

/** 使った通し番号を記録した新しい中身を返す（古い日付の記録は、直近60件だけ残す） */
export function recordSerial(store: Record<string, number>, key: string, serial: number): Record<string, number> {
  const next: Record<string, number> = { ...store, [key]: Math.max(store[key] ?? 0, serial) };
  const keys = Object.keys(next);
  if (keys.length > 60) {
    keys
      .sort((a, b) => (a.split(":")[1] ?? "").localeCompare(b.split(":")[1] ?? ""))
      .slice(0, keys.length - 60)
      .forEach((k) => delete next[k]);
  }
  return next;
}

/* ---- ブラウザの中の保存（localStorage）。使えない環境（シークレットなど）では何もしない ---- */

const listeners = new Set<() => void>();

export function readSerialStoreRaw(): string | null {
  try {
    return window.localStorage.getItem(DOCUMENT_SERIAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeSerialStore(store: Record<string, number>): void {
  try {
    window.localStorage.setItem(DOCUMENT_SERIAL_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 保存できなくても、番号を入れること自体は続ける
  }
  listeners.forEach((l) => l());
}

export function subscribeSerialStore(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === DOCUMENT_SERIAL_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
