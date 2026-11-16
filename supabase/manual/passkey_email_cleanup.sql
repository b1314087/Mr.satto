-- ============================================================================
-- Mr.Satto：パスキーのメール認証（廃止）の表と関数を消す SQL ★承認後に、必要な場合だけ実行★
--   メール認証（2台目以降の端末の確認コード）は廃止した。コードからは取り除き、0012 のマイグレーションも削除した。
--   以前に supabase/manual/passkey_launch.sql（0011＋0012をまとめた古い版）や 0012 を本番で実行していた場合だけ、
--   残っている表 passkey_email_challenges と関数7つを消すために、これを1回実行する。
--   実行していない場合は不要（実行しても、何も消えずに「Success」になるだけ。if exists を付けている）。
--   0011（パスキー・登録端末・同時利用）の表・データには触れない。
--   確かめ方：Supabase → Table Editor に passkey_email_challenges があれば、実行が必要。
-- ============================================================================
drop function if exists public.pk_email_begin_send(uuid, text, int, int, int);
drop function if exists public.pk_email_cancel_send(uuid, uuid);
drop function if exists public.pk_email_attempt(uuid, text, int);
drop function if exists public.pk_email_mark_verified(uuid, uuid);
drop function if exists public.pk_email_consume_approval(uuid, text, int);
drop function if exists public.pk_email_has_approval(uuid, text, int);
drop function if exists public.pk_device_history_count(uuid);
drop table if exists public.passkey_email_challenges;
