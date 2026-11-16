import type { LeaseState } from "./policy";

/**
 * パスキー・登録端末・同時利用のデータの読み書き（サーバー専用）。
 * 本番は Supabase（Service Roleで、0011のDB関数を呼ぶ）。開発のテストだけ、メモリ上の実装を使う（dev.ts）。
 * どちらも同じ約束（上限・ロック・1回だけのチャレンジ）を守る。
 */

export interface StoredCredential {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice" | null;
  backedUp: boolean;
  aaguid: string | null;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccessState {
  credentialCount: number;
  deviceId: string | null;
  lease: LeaseState;
  verifiedAt: string | null;
}

export type RegisterDeviceOutcome =
  | { outcome: "ok"; deviceId: string; already: boolean }
  | { outcome: "limit" }
  | { outcome: "rate_limited" }
  | { outcome: "revoked" }
  | { outcome: "conflict" };

export type AcquireLeaseOutcome =
  | { outcome: "ok"; tookOver: boolean; previousDeviceId: string | null }
  | { outcome: "in_use" }
  | { outcome: "device_invalid" };

export interface NewCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice" | null;
  backedUp: boolean;
  aaguid: string | null;
  label: string;
}

export type EmailBeginSendOutcome =
  | { outcome: "ok"; id: string }
  | { outcome: "too_soon"; retryAfterSec: number }
  | { outcome: "hourly_limit" };

export type EmailAttemptOutcome =
  | { outcome: "ok"; id: string; remaining: number }
  | { outcome: "none" }
  | { outcome: "expired" }
  | { outcome: "locked" };

export interface PasskeyStore {
  listCredentials(userId: string): Promise<StoredCredential[]>;
  /** 本人のパスキーだけを返す（他人のCredential IDなら null） */
  getCredential(userId: string, credentialId: string): Promise<StoredCredential | null>;
  insertCredential(userId: string, credential: NewCredential): Promise<"ok" | "duplicate">;
  updateCredentialUsage(userId: string, credentialId: string, counter: number, backedUp: boolean): Promise<void>;
  deleteCredential(userId: string, id: string): Promise<boolean>;

  listDevices(userId: string): Promise<StoredDevice[]>;
  registerDevice(userId: string, tokenHash: string, label: string): Promise<RegisterDeviceOutcome>;
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;

  createChallenge(userId: string, kind: "register" | "authenticate", challenge: string): Promise<string>;
  /** 1回だけ使える。同じユーザー・同じ種類・期限内・未使用のときだけ返す */
  consumeChallenge(userId: string, id: string, kind: "register" | "authenticate"): Promise<string | null>;

  createVerification(userId: string, tokenHash: string, credentialId: string): Promise<void>;
  checkVerification(userId: string, tokenHash: string): Promise<boolean>;

  acquireLease(userId: string, deviceId: string, tokenHash: string, takeover: boolean): Promise<AcquireLeaseOutcome>;
  heartbeat(userId: string, tokenHash: string): Promise<"ok" | "lost">;
  releaseLease(userId: string, tokenHash: string): Promise<boolean>;
  endAllSessions(userId: string): Promise<void>;
  accessState(userId: string, deviceHash: string | null, sessionHash: string | null): Promise<AccessState>;

  /** これまでに登録したことのある端末の数（解除した端末も数える） */
  deviceHistoryCount(userId: string): Promise<number>;
  emailBeginSend(userId: string, verificationHash: string): Promise<EmailBeginSendOutcome>;
  emailCancelSend(userId: string, id: string): Promise<void>;
  emailAttempt(userId: string, verificationHash: string): Promise<EmailAttemptOutcome>;
  emailMarkVerified(userId: string, id: string): Promise<boolean>;
  emailHasApproval(userId: string, verificationHash: string): Promise<boolean>;
  emailConsumeApproval(userId: string, verificationHash: string): Promise<boolean>;

  logEvent(userId: string, kind: string, detail?: Record<string, unknown>, ipHash?: string | null, userAgent?: string | null): Promise<void>;
  countEvents(userId: string, kind: string, sinceSec: number): Promise<number>;
}
