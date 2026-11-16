import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHALLENGE_TTL_SEC,
  DEVICE_REGISTRATION_WINDOW_MAX,
  DEVICE_REGISTRATION_WINDOW_SEC,
  LEASE_TTL_SEC,
  MAX_DEVICES,
  RECENT_VERIFICATION_TTL_SEC,
  EMAIL_APPROVAL_WINDOW_SEC,
  EMAIL_CODE_TTL_SEC,
  EMAIL_HOURLY_MAX,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_RESEND_INTERVAL_SEC,
} from "./config";
import type { LeaseState } from "./policy";
import type { EmailAttemptOutcome, EmailBeginSendOutcome } from "./store";
import type { AccessState, AcquireLeaseOutcome, NewCredential, PasskeyStore, RegisterDeviceOutcome, StoredCredential, StoredDevice } from "./store";

/**
 * Supabase（Service Role）での実装。表は RLS でクライアントから読めないので、必ずこのサーバー側から操作する。
 * 呼び出し側（server.ts）が、ログイン中の本人のIDだけを渡す（他人のIDを受け取らない）。
 */

interface CredentialRow {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number | string;
  transports: string[] | null;
  device_type: "singleDevice" | "multiDevice" | null;
  backed_up: boolean;
  aaguid: string | null;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

function toCredential(r: CredentialRow): StoredCredential {
  return {
    id: r.id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    counter: Number(r.counter),
    transports: r.transports ?? [],
    deviceType: r.device_type,
    backedUp: r.backed_up,
    aaguid: r.aaguid,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

const CREDENTIAL_COLUMNS = "id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, label, created_at, last_used_at";

function must<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

export function createSupabasePasskeyStore(client: SupabaseClient): PasskeyStore {
  return {
    async listCredentials(userId) {
      const data = must(
        await client.from("passkey_credentials").select(CREDENTIAL_COLUMNS).eq("user_id", userId).order("created_at"),
        "listCredentials"
      );
      return (data as CredentialRow[]).map(toCredential);
    },
    async getCredential(userId, credentialId) {
      const data = must(
        await client.from("passkey_credentials").select(CREDENTIAL_COLUMNS).eq("user_id", userId).eq("credential_id", credentialId).maybeSingle(),
        "getCredential"
      );
      return data ? toCredential(data as CredentialRow) : null;
    },
    async insertCredential(userId, c: NewCredential) {
      const { error } = await client.from("passkey_credentials").insert({
        user_id: userId,
        credential_id: c.credentialId,
        public_key: c.publicKey,
        counter: c.counter,
        transports: c.transports,
        device_type: c.deviceType,
        backed_up: c.backedUp,
        aaguid: c.aaguid,
        label: c.label,
      });
      if (error) {
        if ((error as { code?: string }).code === "23505") return "duplicate";
        throw new Error(`insertCredential: ${error.message}`);
      }
      return "ok";
    },
    async updateCredentialUsage(userId, credentialId, counter, backedUp) {
      must(
        await client
          .from("passkey_credentials")
          .update({ counter, backed_up: backedUp, last_used_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("credential_id", credentialId),
        "updateCredentialUsage"
      );
    },
    async deleteCredential(userId, id) {
      const data = must(await client.from("passkey_credentials").delete().eq("user_id", userId).eq("id", id).select("id"), "deleteCredential");
      return Array.isArray(data) && data.length === 1;
    },

    async listDevices(userId) {
      const data = must(
        await client
          .from("registered_devices")
          .select("id, label, created_at, last_seen_at")
          .eq("user_id", userId)
          .is("revoked_at", null)
          .order("created_at"),
        "listDevices"
      );
      return (data as { id: string; label: string; created_at: string; last_seen_at: string }[]).map(
        (d): StoredDevice => ({ id: d.id, label: d.label, createdAt: d.created_at, lastSeenAt: d.last_seen_at })
      );
    },
    async registerDevice(userId, tokenHash, label): Promise<RegisterDeviceOutcome> {
      const data = must(
        await client.rpc("pk_register_device", {
          p_user: userId,
          p_token_hash: tokenHash,
          p_label: label,
          p_max: MAX_DEVICES,
          p_window_sec: DEVICE_REGISTRATION_WINDOW_SEC,
          p_window_max: DEVICE_REGISTRATION_WINDOW_MAX,
        }),
        "registerDevice"
      ) as { outcome: string; device_id?: string; already?: boolean };
      if (data.outcome === "ok") return { outcome: "ok", deviceId: String(data.device_id), already: !!data.already };
      if (data.outcome === "limit" || data.outcome === "rate_limited" || data.outcome === "revoked" || data.outcome === "conflict") {
        return { outcome: data.outcome };
      }
      throw new Error(`registerDevice: unexpected ${data.outcome}`);
    },
    async revokeDevice(userId, deviceId) {
      return Boolean(must(await client.rpc("pk_revoke_device", { p_user: userId, p_device: deviceId }), "revokeDevice"));
    },

    async createChallenge(userId, kind, challenge) {
      return String(
        must(await client.rpc("pk_create_challenge", { p_user: userId, p_kind: kind, p_challenge: challenge, p_ttl_sec: CHALLENGE_TTL_SEC }), "createChallenge")
      );
    },
    async consumeChallenge(userId, id, kind) {
      const data = must(await client.rpc("pk_consume_challenge", { p_id: id, p_user: userId, p_kind: kind }), "consumeChallenge");
      return typeof data === "string" && data.length > 0 ? data : null;
    },

    async createVerification(userId, tokenHash, credentialId) {
      must(
        await client.rpc("pk_create_verification", {
          p_user: userId,
          p_token_hash: tokenHash,
          p_credential: credentialId,
          p_ttl_sec: RECENT_VERIFICATION_TTL_SEC,
        }),
        "createVerification"
      );
    },
    async checkVerification(userId, tokenHash) {
      return Boolean(must(await client.rpc("pk_check_verification", { p_user: userId, p_token_hash: tokenHash }), "checkVerification"));
    },

    async acquireLease(userId, deviceId, tokenHash, takeover): Promise<AcquireLeaseOutcome> {
      const data = must(
        await client.rpc("pk_acquire_lease", {
          p_user: userId,
          p_device: deviceId,
          p_token_hash: tokenHash,
          p_ttl_sec: LEASE_TTL_SEC,
          p_takeover: takeover,
        }),
        "acquireLease"
      ) as { outcome: string; took_over?: boolean; previous_device?: string | null };
      if (data.outcome === "ok") return { outcome: "ok", tookOver: !!data.took_over, previousDeviceId: data.previous_device ?? null };
      if (data.outcome === "in_use" || data.outcome === "device_invalid") return { outcome: data.outcome };
      throw new Error(`acquireLease: unexpected ${data.outcome}`);
    },
    async heartbeat(userId, tokenHash) {
      const data = must(await client.rpc("pk_heartbeat", { p_user: userId, p_token_hash: tokenHash, p_ttl_sec: LEASE_TTL_SEC }), "heartbeat");
      return data === "ok" ? "ok" : "lost";
    },
    async releaseLease(userId, tokenHash) {
      return Boolean(must(await client.rpc("pk_release_lease", { p_user: userId, p_token_hash: tokenHash }), "releaseLease"));
    },
    async endAllSessions(userId) {
      must(await client.rpc("pk_end_all_sessions", { p_user: userId }), "endAllSessions");
    },
    async accessState(userId, deviceHash, sessionHash): Promise<AccessState> {
      const data = must(
        await client.rpc("pk_access_state", { p_user: userId, p_device_hash: deviceHash, p_session_hash: sessionHash }),
        "accessState"
      ) as { credential_count: number; device_id: string | null; lease: LeaseState; verified_at: string | null };
      return {
        credentialCount: Number(data.credential_count),
        deviceId: data.device_id ?? null,
        lease: data.lease,
        verifiedAt: data.verified_at ?? null,
      };
    },

    async deviceHistoryCount(userId) {
      return Number(must(await client.rpc("pk_device_history_count", { p_user: userId }), "deviceHistoryCount"));
    },
    async emailBeginSend(userId, verificationHash): Promise<EmailBeginSendOutcome> {
      const data = must(
        await client.rpc("pk_email_begin_send", {
          p_user: userId,
          p_verification_hash: verificationHash,
          p_ttl_sec: EMAIL_CODE_TTL_SEC,
          p_interval_sec: EMAIL_RESEND_INTERVAL_SEC,
          p_hourly_max: EMAIL_HOURLY_MAX,
        }),
        "emailBeginSend"
      ) as { outcome: string; id?: string; retry_after_sec?: number };
      if (data.outcome === "ok") return { outcome: "ok", id: String(data.id) };
      if (data.outcome === "too_soon") return { outcome: "too_soon", retryAfterSec: Number(data.retry_after_sec ?? EMAIL_RESEND_INTERVAL_SEC) };
      if (data.outcome === "hourly_limit") return { outcome: "hourly_limit" };
      throw new Error(`emailBeginSend: unexpected ${data.outcome}`);
    },
    async emailCancelSend(userId, id) {
      must(await client.rpc("pk_email_cancel_send", { p_user: userId, p_id: id }), "emailCancelSend");
    },
    async emailAttempt(userId, verificationHash): Promise<EmailAttemptOutcome> {
      const data = must(
        await client.rpc("pk_email_attempt", { p_user: userId, p_verification_hash: verificationHash, p_max_attempts: EMAIL_MAX_ATTEMPTS }),
        "emailAttempt"
      ) as { outcome: string; id?: string; remaining?: number };
      if (data.outcome === "ok") return { outcome: "ok", id: String(data.id), remaining: Number(data.remaining ?? 0) };
      if (data.outcome === "none" || data.outcome === "expired" || data.outcome === "locked") return { outcome: data.outcome };
      throw new Error(`emailAttempt: unexpected ${data.outcome}`);
    },
    async emailMarkVerified(userId, id) {
      return Boolean(must(await client.rpc("pk_email_mark_verified", { p_user: userId, p_id: id }), "emailMarkVerified"));
    },
    async emailHasApproval(userId, verificationHash) {
      return Boolean(
        must(
          await client.rpc("pk_email_has_approval", { p_user: userId, p_verification_hash: verificationHash, p_window_sec: EMAIL_APPROVAL_WINDOW_SEC }),
          "emailHasApproval"
        )
      );
    },
    async emailConsumeApproval(userId, verificationHash) {
      return Boolean(
        must(
          await client.rpc("pk_email_consume_approval", { p_user: userId, p_verification_hash: verificationHash, p_window_sec: EMAIL_APPROVAL_WINDOW_SEC }),
          "emailConsumeApproval"
        )
      );
    },

    async logEvent(userId, kind, detail = {}, ipHash = null, userAgent = null) {
      // 記録に失敗しても、利用者の操作は止めない
      await client.rpc("pk_log_event", { p_user: userId, p_kind: kind, p_detail: detail, p_ip_hash: ipHash, p_user_agent: userAgent });
    },
    async countEvents(userId, kind, sinceSec) {
      return Number(must(await client.rpc("pk_count_events", { p_user: userId, p_kind: kind, p_since_sec: sinceSec }), "countEvents"));
    },
  };
}
