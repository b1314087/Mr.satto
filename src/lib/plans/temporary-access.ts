"use client";

import { grantTemporaryAccess } from "./temporary-access-actions";

/**
 * Rewarded Ad 視聴後に付与される「一時的な無料利用権限」のクライアント側抽象層。
 *
 * Phase 3で仕様が確定した：
 *   Guest / Free ユーザーがStandard対象ツールを利用する際、リワード広告視聴の
 *   成功をもって「15分間、Standard対象ツール全体」を利用できるようにする
 *   （1ツールにつき1広告、という設計にはしない）。
 *
 * 権限の正式な判定（本当にまだ有効か）は、署名付きトークンを使って
 * サーバー側（src/lib/plans/temp-access-token.ts、
 * src/lib/plans/temporary-access-actions.ts）で行う。
 * このクラスが保持する状態はあくまで「広告視聴直後、ページ遷移せずに
 * すぐ結果をUIへ反映するための楽観的キャッシュ」に過ぎず、権限の正式な
 * 情報源ではない（ブラウザの時計やlocalStorageを書き換えても、次に
 * サーバー側の検証を通るツールページでは無効なものとして扱われる）。
 */
export interface TemporaryAccessService {
  /** Rewarded Ad視聴完了後、Standard対象ツール全体の一時的な利用権限を付与する */
  grant(): Promise<void>;
  /** 現在、（楽観的キャッシュ上）一時的な利用権限を持っているように見えるか */
  hasAccess(): boolean;
  /** 有効期限（ms epoch）。無ければnull */
  getExpiresAtMs(): number | null;
}

class CookieBackedTemporaryAccessService implements TemporaryAccessService {
  private expiresAtMs: number | null = null;

  async grant(): Promise<void> {
    const result = await grantTemporaryAccess();
    this.expiresAtMs = result.expiresAtMs;
  }

  hasAccess(): boolean {
    return this.expiresAtMs !== null && Date.now() < this.expiresAtMs;
  }

  getExpiresAtMs(): number | null {
    return this.expiresAtMs;
  }
}

let currentService: TemporaryAccessService = new CookieBackedTemporaryAccessService();

/** テスト等で差し替えるための注入口 */
export function setTemporaryAccessService(service: TemporaryAccessService): void {
  currentService = service;
}

/** 現在利用中の TemporaryAccessService を取得する */
export function getTemporaryAccessService(): TemporaryAccessService {
  return currentService;
}
