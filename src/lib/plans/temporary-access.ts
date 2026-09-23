/**
 * Rewarded Ad 視聴後に付与される「一時的な無料利用権限」の抽象層。
 *
 * Guest
 *   ↓
 * Access Gate
 *   ↓
 * Rewarded Ad
 *   ↓ 視聴完了
 * TemporaryAccessService.grant()
 *   ↓
 * 利用許可（TemporaryAccessService.hasAccess()）
 *
 * 「視聴後、何をもって利用許可とするか」（1回だけ利用可能 / 一定時間利用可能 /
 * 一定回数利用可能 など）は今回確定しない。呼び出し側（ToolAccessGate）は
 * この抽象インターフェースにのみ依存するため、方式が決まった時点で
 * この実装だけを差し替えれば、Tool側のコードには一切手を入れずに済む。
 */
export interface TemporaryAccessService {
  /** Rewarded Ad視聴完了後、そのツールの一時的な利用権限を付与する */
  grant(toolId: string): void;
  /** そのツールについて、現在一時的な利用権限を持っているか */
  hasAccess(toolId: string): boolean;
}

/**
 * Phase 2-0 時点のスタブ実装。
 *
 * ブラウザのメモリ上（ページを読み込んでいる間だけ）に許可状態を保持する、
 * 最も単純な方式。ページの再読み込みやブラウザを閉じると許可は消える。
 *
 * 将来「1回だけ」「〇分間」「〇回まで」などの方式が決まった際は、
 * 同じ `TemporaryAccessService` を実装したクラス（localStorageやCookie、
 * あるいはサーバー側セッションを見るものなど）を作り、
 * `setTemporaryAccessService()` で差し替えるだけでよい。
 */
class InMemoryTemporaryAccessService implements TemporaryAccessService {
  private grantedToolIds = new Set<string>();

  grant(toolId: string): void {
    this.grantedToolIds.add(toolId);
  }

  hasAccess(toolId: string): boolean {
    return this.grantedToolIds.has(toolId);
  }
}

let currentService: TemporaryAccessService = new InMemoryTemporaryAccessService();

/** 将来、本実装の TemporaryAccessService に差し替えるための注入口 */
export function setTemporaryAccessService(service: TemporaryAccessService): void {
  currentService = service;
}

/** 現在利用中の TemporaryAccessService を取得する */
export function getTemporaryAccessService(): TemporaryAccessService {
  return currentService;
}
