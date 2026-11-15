import "server-only";

import { randomUUID } from "node:crypto";
import {
  CHALLENGE_TTL_SEC,
  DEVICE_REGISTRATION_WINDOW_MAX,
  DEVICE_REGISTRATION_WINDOW_SEC,
  LEASE_TTL_SEC,
  MAX_DEVICES,
  RECENT_VERIFICATION_TTL_SEC,
} from "./config";
import type { PasskeyStore, StoredCredential } from "./store";

/**
 * 開発サーバーの自動テスト専用の、メモリ上の実装（dev.ts の条件を満たすときだけ使う。本番では使わない）。
 * Supabaseの関数（0011）と同じ約束を守る。Node.jsは1つのスレッドで動くので、関数の中でawaitしない限り、同時に呼ばれても順番に処理される。
 */

interface Device { id: string; userId: string; tokenHash: string; label: string; createdAt: number; lastSeenAt: number; revokedAt: number | null }
interface Lease { userId: string; deviceId: string; tokenHash: string; verifiedAt: number; expiresAt: number }
interface Challenge { id: string; userId: string; kind: string; challenge: string; expiresAt: number; used: boolean }
interface Verification { userId: string; credentialId: string; expiresAt: number }
interface Event { userId: string; kind: string; at: number }

interface Db {
  credentials: Map<string, StoredCredential & { userId: string }>;
  devices: Map<string, Device>;
  leases: Map<string, Lease>;
  challenges: Map<string, Challenge>;
  verifications: Map<string, Verification>;
  events: Event[];
}

const g = globalThis as unknown as { __mrsattoPasskeyMemoryDb?: Db };

function db(): Db {
  g.__mrsattoPasskeyMemoryDb ??= {
    credentials: new Map(),
    devices: new Map(),
    leases: new Map(),
    challenges: new Map(),
    verifications: new Map(),
    events: [],
  };
  return g.__mrsattoPasskeyMemoryDb;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** テスト用：時間を進めたことにして、利用ロックを期限切れにする */
export function expireMemoryLease(userId: string): void {
  const lease = db().leases.get(userId);
  if (lease) lease.expiresAt = Date.now() - 1000;
}

export function createMemoryPasskeyStore(): PasskeyStore {
  return {
    async listCredentials(userId) {
      return [...db().credentials.values()].filter((c) => c.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async getCredential(userId, credentialId) {
      const c = [...db().credentials.values()].find((x) => x.credentialId === credentialId);
      return c && c.userId === userId ? c : null;
    },
    async insertCredential(userId, c) {
      if ([...db().credentials.values()].some((x) => x.credentialId === c.credentialId)) return "duplicate";
      const id = randomUUID();
      db().credentials.set(id, { ...c, id, userId, createdAt: iso(Date.now()), lastUsedAt: null });
      return "ok";
    },
    async updateCredentialUsage(userId, credentialId, counter, backedUp) {
      for (const c of db().credentials.values()) {
        if (c.userId === userId && c.credentialId === credentialId) Object.assign(c, { counter, backedUp, lastUsedAt: iso(Date.now()) });
      }
    },
    async deleteCredential(userId, id) {
      const c = db().credentials.get(id);
      if (!c || c.userId !== userId) return false;
      db().credentials.delete(id);
      return true;
    },

    async listDevices(userId) {
      return [...db().devices.values()]
        .filter((d) => d.userId === userId && d.revokedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((d) => ({ id: d.id, label: d.label, createdAt: iso(d.createdAt), lastSeenAt: iso(d.lastSeenAt) }));
    },
    async registerDevice(userId, tokenHash, label) {
      const now = Date.now();
      const existing = [...db().devices.values()].find((d) => d.tokenHash === tokenHash);
      if (existing) {
        if (existing.userId !== userId) return { outcome: "conflict" };
        if (existing.revokedAt === null) {
          existing.lastSeenAt = now;
          return { outcome: "ok", deviceId: existing.id, already: true };
        }
        return { outcome: "revoked" };
      }
      const mine = [...db().devices.values()].filter((d) => d.userId === userId);
      if (mine.filter((d) => d.revokedAt === null).length >= MAX_DEVICES) return { outcome: "limit" };
      if (mine.filter((d) => d.createdAt > now - DEVICE_REGISTRATION_WINDOW_SEC * 1000).length >= DEVICE_REGISTRATION_WINDOW_MAX) {
        return { outcome: "rate_limited" };
      }
      const id = randomUUID();
      db().devices.set(id, { id, userId, tokenHash, label: label.slice(0, 80) || "この端末", createdAt: now, lastSeenAt: now, revokedAt: null });
      return { outcome: "ok", deviceId: id, already: false };
    },
    async revokeDevice(userId, deviceId) {
      const d = db().devices.get(deviceId);
      if (!d || d.userId !== userId || d.revokedAt !== null) return false;
      d.revokedAt = Date.now();
      const lease = db().leases.get(userId);
      if (lease?.deviceId === deviceId) db().leases.delete(userId);
      return true;
    },

    async createChallenge(userId, kind, challenge) {
      const id = randomUUID();
      db().challenges.set(id, { id, userId, kind, challenge, expiresAt: Date.now() + CHALLENGE_TTL_SEC * 1000, used: false });
      return id;
    },
    async consumeChallenge(userId, id, kind) {
      const c = db().challenges.get(id);
      if (!c || c.userId !== userId || c.kind !== kind || c.used || c.expiresAt <= Date.now()) return null;
      c.used = true;
      return c.challenge;
    },

    async createVerification(userId, tokenHash, credentialId) {
      db().verifications.set(tokenHash, { userId, credentialId, expiresAt: Date.now() + RECENT_VERIFICATION_TTL_SEC * 1000 });
    },
    async checkVerification(userId, tokenHash) {
      const v = db().verifications.get(tokenHash);
      return !!v && v.userId === userId && v.expiresAt > Date.now();
    },

    async acquireLease(userId, deviceId, tokenHash, takeover) {
      const d = db().devices.get(deviceId);
      if (!d || d.userId !== userId || d.revokedAt !== null) return { outcome: "device_invalid" };
      const now = Date.now();
      const cur = db().leases.get(userId);
      if (!cur || cur.tokenHash === tokenHash || cur.expiresAt <= now || takeover) {
        const tookOver = !!cur && cur.tokenHash !== tokenHash && cur.expiresAt > now;
        const previousDeviceId = cur && cur.tokenHash !== tokenHash ? cur.deviceId : null;
        db().leases.set(userId, { userId, deviceId, tokenHash, verifiedAt: now, expiresAt: now + LEASE_TTL_SEC * 1000 });
        return { outcome: "ok", tookOver, previousDeviceId };
      }
      return { outcome: "in_use" };
    },
    async heartbeat(userId, tokenHash) {
      const cur = db().leases.get(userId);
      const d = cur ? db().devices.get(cur.deviceId) : undefined;
      if (!cur || cur.tokenHash !== tokenHash || !d || d.revokedAt !== null) return "lost";
      cur.expiresAt = Date.now() + LEASE_TTL_SEC * 1000;
      d.lastSeenAt = Date.now();
      return "ok";
    },
    async releaseLease(userId, tokenHash) {
      const cur = db().leases.get(userId);
      if (!cur || cur.tokenHash !== tokenHash) return false;
      db().leases.delete(userId);
      return true;
    },
    async endAllSessions(userId) {
      db().leases.delete(userId);
      for (const [k, v] of db().verifications) if (v.userId === userId) db().verifications.delete(k);
    },
    async accessState(userId, deviceHash, sessionHash) {
      const credentialCount = [...db().credentials.values()].filter((c) => c.userId === userId).length;
      const device = deviceHash
        ? [...db().devices.values()].find((d) => d.tokenHash === deviceHash && d.userId === userId && d.revokedAt === null)
        : undefined;
      const lease = db().leases.get(userId);
      let state: "mine" | "free" | "other" | "none";
      if (!lease) state = "none";
      else if (sessionHash && lease.tokenHash === sessionHash && device && lease.deviceId === device.id) state = "mine";
      else if (lease.expiresAt <= Date.now() || (device && lease.deviceId === device.id)) state = "free";
      else state = "other";
      return { credentialCount, deviceId: device?.id ?? null, lease: state, verifiedAt: state === "mine" && lease ? iso(lease.verifiedAt) : null };
    },

    async logEvent(userId, kind) {
      db().events.push({ userId, kind, at: Date.now() });
    },
    async countEvents(userId, kind, sinceSec) {
      const since = Date.now() - sinceSec * 1000;
      return db().events.filter((e) => e.userId === userId && e.kind === kind && e.at > since).length;
    },
  };
}
