import "server-only";

/**
 * 軽量なレート制限ヘルパー（Phase 6.5 セキュリティ監査で追加）。
 *
 * 対象は「課金操作を開始する」/api/stripe/checkout・/api/stripe/portal のように、
 * 呼び出しごとにStripe側のAPIコストが発生し、連打・自動化された乱打に対して
 * 何らかの歯止めが必要なエンドポイントに限定する。
 *
 * 設計方針（監査スコープに沿った最小実装）：
 * - 新しい依存パッケージ（Upstash/Redis等）は追加しない。
 * - Vercelのサーバーレス関数はインスタンスごとにメモリが分離され、かつ
 *   コールドスタートでメモリがリセットされるため、このメモリ内カウンタは
 *   「完全な」レート制限ではない（複数インスタンスに分散されたリクエストは
 *   それぞれ別カウントになる）。これは既知の限界として最終報告書に明記し、
 *   あくまでStripe自体のAPIレート制限・認証必須という前提の上に重ねる
 *   多層防御の1つとして扱う。
 * - IPアドレスではなく、認証済みユーザーID単位でカウントする
 *   （対象エンドポイントは全て認証必須であり、共有IP（社内ネットワーク等）による
 *   誤検知を避けられるため）。
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

// 呼び出し側で個別にバケットが増え続けないよう、簡易的に定期間引きする。
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.timestamps.length === 0 || now - bucket.timestamps[bucket.timestamps.length - 1] > SWEEP_INTERVAL_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * 固定ウィンドウ+タイムスタンプ配列によるシンプルなレート制限。
 * `key`（例: `checkout:${userId}`）ごとに、直近 `windowMs` 内の呼び出し回数が
 * `limit` を超えていれば `limited: true` を返す。
 */
export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): { limited: boolean; retryAfterMs: number } {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key) ?? { timestamps: [] };
  const windowStart = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    buckets.set(key, bucket);
    return { limited: true, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { limited: false, retryAfterMs: 0 };
}
