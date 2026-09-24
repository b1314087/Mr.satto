"use client";

import { grantTemporaryAccess } from "./temporary-access-actions";
import { TEMP_ACCESS_COOKIE_NAME } from "./temporary-access-cookie";

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
 * src/lib/plans/temporary-access-actions.ts）で行う。このクラスが返す値は
 * あくまで「ページ遷移せずにすぐUIへ反映するための表示用の見積もり」に過ぎず、
 * 権限の正式な情報源ではない（Phase 4 spec 12章：ブラウザの時計や
 * localStorageだけを信頼して判定する構造は禁止）。
 *
 * Phase 4での拡張点：
 *   - isActive() / getRemainingSeconds() / isExpired() などの読み取り系メソッドを追加。
 *     これらは「サーバーが発行した署名付きトークン（Cookie）に書かれた有効期限」を
 *     そのまま読むだけで、有効期限の値自体はサーバー（HMAC署名）が確定させたもの。
 *     Cookieはhttp0nlyにしていないため中身は読めるが、署名を検証できるのはサーバーのみ。
 *     そのためこの値は「表示用」であり、実際のツール利用可否は必ずサーバー側
 *     （getServerPlan() → ToolAccessGateへpropsで渡る temporaryAccessActive）で
 *     再確認される（このファイル単体でアクセス制御を完結させない）。
 *   - 複数タブ間の同期（Phase 4 spec 13章）：Cookieはブラウザ内の全タブで自動的に
 *     共有されるため、他タブでgrant()が呼ばれれば、このタブが次にCookieを読んだ
 *     時点で自然に反映される。それに加えて、BroadcastChannelで「他タブでgrant()が
 *     成功した」ことを能動的に通知し、既に開いているタブのUIをその場で
 *     再検証（router.refresh()）できるようにする（本当の可否判定は引き続き
 *     サーバー側で行う。BroadcastChannelはあくまで「見に行くきっかけ」）。
 */

export interface TemporaryAccessSnapshot {
  active: boolean;
  expiresAtMs: number | null;
  remainingSeconds: number;
}

export interface TemporaryAccessService {
  /** Rewarded Ad視聴完了後、Standard対象ツール全体の一時的な利用権限を付与する */
  grant(): Promise<TemporaryAccessSnapshot>;
  /** 現在、（表示用の見積もり上）一時的な利用権限を持っているように見えるか */
  isActive(): boolean;
  /** @deprecated isActive() を使うこと。後方互換のために残している */
  hasAccess(): boolean;
  /** 有効期限（ms epoch）。無ければnull */
  getExpiresAtMs(): number | null;
  /** 残り秒数（負値にはならない。無効な場合は0） */
  getRemainingSeconds(): number;
  /** 有効期限を過ぎているか（そもそも付与されていない場合もtrue） */
  isExpired(): boolean;
  /** 表示用キャッシュをリセットする（署名付きCookie自体は削除しない） */
  clear(): void;
  /**
   * 他タブでgrant()が成功したことの通知を購読する。
   * 戻り値の関数を呼ぶと購読を解除する。
   * BroadcastChannel等がブラウザ側で利用できない場合は何も起きない（no-op）。
   */
  subscribeToCrossTabGrant(listener: () => void): () => void;
}

const CROSS_TAB_CHANNEL_NAME = "mrsatto-temporary-access";

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(prefix.length));
}

/**
 * Cookieに書かれた有効期限(ms)だけを取り出す（表示用）。
 * トークン形式は `v1.<expiresAtMs>.<signature>`（src/lib/plans/temp-access-token.ts）。
 * 署名の検証はできない（秘密鍵はサーバーのみが持つ）ため、ここでは行わない。
 * 改ざんされていても、実際のアクセス可否判定（サーバー側）には一切影響しない。
 */
function readExpiresAtMsFromCookie(): number | null {
  const raw = readCookieValue(TEMP_ACCESS_COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const expiresAtMs = Number(parts[1]);
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

class CookieBackedTemporaryAccessService implements TemporaryAccessService {
  /** grant()直後、Cookieの反映がまだ読めない場合に備えたフォールバック値 */
  private lastKnownExpiresAtMs: number | null = null;
  private channel: BroadcastChannel | null = null;
  private channelInitAttempted = false;

  private getChannel(): BroadcastChannel | null {
    if (this.channelInitAttempted) return this.channel;
    this.channelInitAttempted = true;
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return null;
    }
    try {
      this.channel = new BroadcastChannel(CROSS_TAB_CHANNEL_NAME);
    } catch {
      this.channel = null;
    }
    return this.channel;
  }

  async grant(): Promise<TemporaryAccessSnapshot> {
    const result = await grantTemporaryAccess();
    this.lastKnownExpiresAtMs = result.expiresAtMs;

    // 他タブへ「Temporary Accessが更新された」ことを知らせる。
    // 実際の可否判定は各タブが自分でサーバーへ確認する（このメッセージは
    // 「確認しにいくきっかけ」に過ぎず、メッセージの中身自体は信用しない）。
    try {
      this.getChannel()?.postMessage({ type: "granted" });
    } catch {
      // 送信に失敗しても致命的ではない（Cookie自体は既に共有されている）
    }

    return this.snapshot();
  }

  private resolveExpiresAtMs(): number | null {
    const fromCookie = readExpiresAtMsFromCookie();
    if (fromCookie !== null) {
      this.lastKnownExpiresAtMs = fromCookie;
      return fromCookie;
    }
    return this.lastKnownExpiresAtMs;
  }

  isActive(): boolean {
    const expiresAtMs = this.resolveExpiresAtMs();
    return expiresAtMs !== null && Date.now() < expiresAtMs;
  }

  hasAccess(): boolean {
    return this.isActive();
  }

  getExpiresAtMs(): number | null {
    return this.resolveExpiresAtMs();
  }

  getRemainingSeconds(): number {
    const expiresAtMs = this.resolveExpiresAtMs();
    if (expiresAtMs === null) return 0;
    return Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
  }

  isExpired(): boolean {
    return !this.isActive();
  }

  clear(): void {
    this.lastKnownExpiresAtMs = null;
  }

  subscribeToCrossTabGrant(listener: () => void): () => void {
    const channel = this.getChannel();
    if (!channel) return () => {};

    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (data?.type === "granted") listener();
    };
    channel.addEventListener("message", handler);
    return () => channel.removeEventListener("message", handler);
  }

  private snapshot(): TemporaryAccessSnapshot {
    return {
      active: this.isActive(),
      expiresAtMs: this.getExpiresAtMs(),
      remainingSeconds: this.getRemainingSeconds(),
    };
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
