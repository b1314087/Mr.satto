import type { Page, Request } from "@playwright/test";

/**
 * privacy回帰テスト用のネットワーク監視ヘルパー（Phase 14）。
 *
 * Mr.Sattoの各ツールは「ブラウザ内で処理し、ファイルはサーバーに保存しない」設計
 * （README/各所のコピー、Phase 13棚卸しでも確認済み）のため、
 * テスト用フィクスチャファイルを使ってツールを操作している間、
 * - 自社API（同一オリジンの /api/** ）へファイル本文相当のデータが送信されない
 * - 外部ホストへファイル本文相当のデータが送信されない
 * ことを検証する。
 *
 * 注意（ベストエフォートである旨を明記）:
 * - これは「絶対に送信されていないことの数学的証明」ではなく、Playwrightが観測できる
 *   ネットワークリクエストのURL・メソッド・Content-Type・ボディサイズ・
 *   （取得できる範囲での）ボディ内容から、フィクスチャ内容の混入が「見つからない」ことを
 *   確認するベストエフォートのテストである。
 */

export interface RecordedRequest {
  url: string;
  method: string;
  resourceType: string;
  contentType: string | null;
  bodySize: number;
  bodyText: string | null;
}

export class NetworkRecorder {
  readonly requests: RecordedRequest[] = [];

  constructor(page: Page) {
    page.on("request", (request) => this.record(request));
  }

  private record(request: Request) {
    let bodyText: string | null = null;
    let bodySize = 0;
    try {
      const buffer = request.postDataBuffer();
      if (buffer) {
        bodySize = buffer.length;
        // 多くの部分がテキストである前提でベストエフォートにデコードする
        // （multipart/binaryの場合は文字列化が崩れてもよい。マーカー検索にのみ使う）。
        bodyText = buffer.toString("utf8");
      }
    } catch {
      // postDataBuffer() が取得できないリクエストは無視する（ボディなしとして扱う）。
    }
    this.requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      contentType: request.headers()["content-type"] ?? null,
      bodySize,
      bodyText,
    });
  }
}

/**
 * 指定した文字列（フィクスチャ内容に含まれるユニークな文字列）が、
 * 記録されたどのリクエストのURL・ボディにも含まれていないことを確認する。
 */
export function findLeakedRequests(recorder: NetworkRecorder, needle: string): RecordedRequest[] {
  return recorder.requests.filter(
    (r) => r.url.includes(needle) || (r.bodyText !== null && r.bodyText.includes(needle))
  );
}

/**
 * 同一オリジンの /api/** に対して、許可リスト外のパスへ
 * 有意なサイズ（ファイル本文が乗り得るサイズ）のボディを伴うリクエストが
 * 送信されていないことを確認する。
 */
export function findSuspiciousApiUploads(
  recorder: NetworkRecorder,
  origin: string,
  allowedApiPathPrefixes: string[] = [],
  minSuspiciousBodySize = 256
): RecordedRequest[] {
  return recorder.requests.filter((r) => {
    if (!r.url.startsWith(origin)) return false;
    const pathname = r.url.slice(origin.length).split("?")[0];
    if (!pathname.startsWith("/api/")) return false;
    if (allowedApiPathPrefixes.some((prefix) => pathname.startsWith(prefix))) return false;
    return r.bodySize >= minSuspiciousBodySize;
  });
}

/**
 * 外部（クロスオリジン）ホストへ、有意なサイズのボディを伴うリクエストが
 * 送信されていないことを確認する。
 */
export function findSuspiciousExternalUploads(
  recorder: NetworkRecorder,
  origin: string,
  minSuspiciousBodySize = 256
): RecordedRequest[] {
  return recorder.requests.filter((r) => !r.url.startsWith(origin) && r.bodySize >= minSuspiciousBodySize);
}
