-- 0011_passkeys_devices_sessions.sql の取り消し（パスキー・登録端末・同時利用・記録の表と関数を消す）。
-- ★実行すると、登録済みのパスキー・端末・記録はすべて消えます（有料会員は、もう一度パスキーの登録が必要になります）。
-- 既存の表（subscriptions など）には触れません。
drop function if exists public.pk_create_challenge(uuid, text, text, int);
drop function if exists public.pk_consume_challenge(uuid, uuid, text);
drop function if exists public.pk_register_device(uuid, text, text, int, int, int);
drop function if exists public.pk_revoke_device(uuid, uuid);
drop function if exists public.pk_acquire_lease(uuid, uuid, text, int, boolean);
drop function if exists public.pk_heartbeat(uuid, text, int);
drop function if exists public.pk_release_lease(uuid, text);
drop function if exists public.pk_end_all_sessions(uuid);
drop function if exists public.pk_access_state(uuid, text, text);
drop function if exists public.pk_create_verification(uuid, text, text, int);
drop function if exists public.pk_check_verification(uuid, text);
drop function if exists public.pk_log_event(uuid, text, jsonb, text, text);
drop function if exists public.pk_count_events(uuid, text, int);
drop table if exists public.paid_session_leases;
drop table if exists public.passkey_verifications;
drop table if exists public.passkey_challenges;
drop table if exists public.registered_devices;
drop table if exists public.passkey_credentials;
drop table if exists public.auth_security_events;
