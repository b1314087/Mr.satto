/**
 * ツール間の受け渡しの一時置き場（工程16）。
 *
 * 方式：このモジュールの変数（ブラウザのメモリ上）に、受け渡すファイルを置く。ツールのページの移動は、
 * ページ全体の再読み込みを伴わない画面遷移で行うため、移動先でも同じメモリから取り出せる。
 * 移動先のURLには、ランダムな識別子（UUID）だけを付ける（ファイルの中身・名前はURLに入れない）。
 *
 * 決めごと（変更しないこと）：
 * - サーバーへ送らない。localStorage・sessionStorage・IndexedDB・Cookie にも保存しない（中身を残さない）。
 * - 有効期限（HANDOFF_TTL_MS）を過ぎたものは取り出せない。取り出したら（成功したら）置き場から消す。
 * - 置き場に残すのは新しいものから HANDOFF_MAX_ENTRIES 件まで。合計の大きさにも上限（HANDOFF_MAX_TOTAL_BYTES）を設ける。
 * - 置くたび・取り出すたびに、期限切れのものを掃除する。
 * - 再読み込み・別タブではメモリが空なので、何も取り出せない（「見つかりません」を案内する）。
 */

export const HANDOFF_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_MAX_ENTRIES = 3;
export const HANDOFF_MAX_TOTAL_BYTES = 600 * 1024 * 1024;

export interface HandoffEntry {
  id: string;
  sourceToolId: string;
  /** 送り元のツール名（受け取った画面での表示用） */
  sourceName: string;
  targetToolId: string;
  files: File[];
  createdAt: number;
}

export type TakeHandoffResult =
  | { ok: true; entry: HandoffEntry }
  | { ok: false; reason: "invalid" | "not-found" | "expired" | "wrong-target" };

export class HandoffStoreError extends Error {
  constructor(public readonly reason: "too-large" | "empty") {
    super(reason);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let entries: HandoffEntry[] = [];

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isExpired(entry: HandoffEntry, now: number): boolean {
  return now - entry.createdAt > HANDOFF_TTL_MS;
}

function sweep(now: number): void {
  entries = entries.filter((e) => !isExpired(e, now));
}

/** 受け渡すファイルを置き、識別子を返す。大きすぎる・空のときは HandoffStoreError を投げる */
export function putHandoff(
  input: Omit<HandoffEntry, "id" | "createdAt">,
  now: number = Date.now()
): string {
  if (input.files.length === 0) throw new HandoffStoreError("empty");
  const bytes = input.files.reduce((sum, f) => sum + f.size, 0);
  if (bytes > HANDOFF_MAX_TOTAL_BYTES) throw new HandoffStoreError("too-large");
  sweep(now);
  const entry: HandoffEntry = { ...input, id: randomId(), createdAt: now };
  // 新しいものを先頭に置き、件数と合計の大きさが上限に収まるよう、古いものから外す
  const next = [entry];
  let total = bytes;
  for (const e of entries) {
    if (next.length >= HANDOFF_MAX_ENTRIES) break;
    const size = e.files.reduce((sum, f) => sum + f.size, 0);
    if (total + size > HANDOFF_MAX_TOTAL_BYTES) break;
    next.push(e);
    total += size;
  }
  entries = next;
  return entry.id;
}

/**
 * 受け取り側が取り出す。成功したら置き場から消す（1回だけ）。
 * 宛先が違う場合は消さない（別のツールの受け渡しを横取りしない）。期限切れは消す。
 */
export function takeHandoff(id: string, targetToolId: string, now: number = Date.now()): TakeHandoffResult {
  if (!UUID_RE.test(id)) return { ok: false, reason: "invalid" };
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    sweep(now);
    return { ok: false, reason: "not-found" };
  }
  if (isExpired(entry, now)) {
    sweep(now);
    return { ok: false, reason: "expired" };
  }
  if (entry.targetToolId !== targetToolId) return { ok: false, reason: "wrong-target" };
  entries = entries.filter((e) => e !== entry);
  sweep(now);
  return { ok: true, entry };
}

/** 置き場を空にする（テスト用） */
export function clearHandoffs(): void {
  entries = [];
}

/** 置き場の件数（中身は返さない。テスト用） */
export function countHandoffs(): number {
  return entries.length;
}
