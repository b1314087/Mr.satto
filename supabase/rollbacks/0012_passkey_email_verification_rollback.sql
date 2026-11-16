-- 0012_passkey_email_verification.sql の取り消し（新しい端末の登録のためのメール確認の表と関数を消す）。
-- 0011（パスキー・端末・同時利用）の表には触れない。
drop function if exists public.pk_email_begin_send(uuid, text, int, int, int);
drop function if exists public.pk_email_cancel_send(uuid, uuid);
drop function if exists public.pk_email_attempt(uuid, text, int);
drop function if exists public.pk_email_mark_verified(uuid, uuid);
drop function if exists public.pk_email_consume_approval(uuid, text, int);
drop function if exists public.pk_email_has_approval(uuid, text, int);
drop function if exists public.pk_device_history_count(uuid);
drop table if exists public.passkey_email_challenges;
