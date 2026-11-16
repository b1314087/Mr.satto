-- Mr.Satto: パスキーの新しい端末（2台目以降）を登録するときの、メールの確認コード（2026-11-16）
--
-- ★0011_passkeys_devices_sessions.sql のあとに実行する（0011の表 registered_devices を使う）。
--   ユーザー自身が SQL Editor へ貼り付けて実行する。何度実行しても安全。既存の表・データは変更しない。
--   取り消すときは supabase/rollbacks/0012_passkey_email_verification_rollback.sql。
--
-- 方針:
--   - 確認コードそのものは、この表に保存しない。コードの作成・送信・照合は Supabase Auth（メールのワンタイムコード）が行い、
--     Supabase Auth はコードをハッシュにして保存する。この表は「いつ送ったか・何回試したか・確認できたか・使ったか」だけを持つ。
--   - 有効期限（10分）・試せる回数（5回）・送り直しの間隔（60秒）・1時間の送信数（5通）は、ここ（サーバー側）で判定する。
--   - 確認できたコードは、端末の登録に1回だけ使える（使ったら used_at を入れる）。パスキーでの本人確認（直近の確認の値）にひもづける。
--   - RLSを有効にし、ポリシーは作らない（Service Roleだけが使える）。

create table if not exists public.passkey_email_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  verification_hash text not null check (verification_hash ~ '^[0-9a-f]{64}$'),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts int not null default 0 check (attempts >= 0),
  verified_at timestamptz,
  used_at timestamptz
);
create index if not exists passkey_email_challenges_user_idx on public.passkey_email_challenges(user_id, sent_at);
comment on table public.passkey_email_challenges is
  '新しい端末の登録のためのメール確認の状態（コードそのものは保存しない。Supabase Authが照合する）。Service Roleだけが読み書きする。';

alter table public.passkey_email_challenges enable row level security;
revoke all on public.passkey_email_challenges from anon, authenticated;

-- 送ってよいかを判定し、よければ送信の記録を作る（送り直しの間隔・1時間の上限）。前の未確認のコードは無効にする
create or replace function public.pk_email_begin_send(
  p_user uuid, p_verification_hash text, p_ttl_sec int default 600, p_interval_sec int default 60, p_hourly_max int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_last timestamptz; v_count int; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('pk_email:' || p_user::text, 0));
  select max(sent_at) into v_last from public.passkey_email_challenges where user_id = p_user;
  if v_last is not null and v_last > now() - make_interval(secs => p_interval_sec) then
    return jsonb_build_object('outcome', 'too_soon',
      'retry_after_sec', ceil(extract(epoch from (v_last + make_interval(secs => p_interval_sec) - now())))::int);
  end if;
  select count(*) into v_count from public.passkey_email_challenges where user_id = p_user and sent_at > now() - interval '1 hour';
  if v_count >= p_hourly_max then
    return jsonb_build_object('outcome', 'hourly_limit');
  end if;
  update public.passkey_email_challenges set expires_at = least(expires_at, now())
   where user_id = p_user and verified_at is null and expires_at > now();
  delete from public.passkey_email_challenges where user_id = p_user and sent_at < now() - interval '1 day';
  insert into public.passkey_email_challenges(user_id, verification_hash, expires_at)
  values (p_user, p_verification_hash, now() + make_interval(secs => greatest(60, least(p_ttl_sec, 3600))))
  returning id into v_id;
  return jsonb_build_object('outcome', 'ok', 'id', v_id);
end;
$$;

-- 送信に失敗したとき：記録を取り消す（送れていないので、試す回数も送信数も数えない）
create or replace function public.pk_email_cancel_send(p_user uuid, p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.passkey_email_challenges where id = p_id and user_id = p_user and verified_at is null and attempts = 0;
$$;

-- コードを試す前に、1回分を数える（照合の前に数えるので、同時に何回送っても上限を超えて試せない）
create or replace function public.pk_email_attempt(p_user uuid, p_verification_hash text, p_max_attempts int default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.passkey_email_challenges;
begin
  perform pg_advisory_xact_lock(hashtextextended('pk_email:' || p_user::text, 0));
  select * into v_row from public.passkey_email_challenges
   where user_id = p_user and verification_hash = p_verification_hash and verified_at is null
   order by sent_at desc limit 1;
  if not found then return jsonb_build_object('outcome', 'none'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('outcome', 'expired'); end if;
  if v_row.attempts >= p_max_attempts then return jsonb_build_object('outcome', 'locked'); end if;
  update public.passkey_email_challenges set attempts = attempts + 1 where id = v_row.id;
  return jsonb_build_object('outcome', 'ok', 'id', v_row.id, 'remaining', p_max_attempts - v_row.attempts - 1);
end;
$$;

-- 照合できた：確認済みにする（期限内のときだけ）
create or replace function public.pk_email_mark_verified(p_user uuid, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int;
begin
  update public.passkey_email_challenges set verified_at = now()
   where id = p_id and user_id = p_user and verified_at is null and expires_at > now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- 端末の登録に使う：確認済み・未使用・同じ本人確認・確認から一定時間内のものを、1回だけ使う
create or replace function public.pk_email_consume_approval(p_user uuid, p_verification_hash text, p_window_sec int default 600)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  update public.passkey_email_challenges set used_at = now()
   where id = (
     select id from public.passkey_email_challenges
      where user_id = p_user and verification_hash = p_verification_hash and verified_at is not null and used_at is null
        and verified_at > now() - make_interval(secs => p_window_sec)
      order by verified_at desc limit 1
      for update
   )
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- 確認済みで、まだ使っていないものがあるか（使わずに確かめるだけ）
create or replace function public.pk_email_has_approval(p_user uuid, p_verification_hash text, p_window_sec int default 600)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.passkey_email_challenges
     where user_id = p_user and verification_hash = p_verification_hash and verified_at is not null and used_at is null
       and verified_at > now() - make_interval(secs => p_window_sec)
  );
$$;

-- これまでに登録したことのある端末の数（解除した端末も数える）。1台目（初めての登録）だけはメール確認を求めないために使う
create or replace function public.pk_device_history_count(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.registered_devices where user_id = p_user;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.pk_email_begin_send(uuid, text, int, int, int)',
    'public.pk_email_cancel_send(uuid, uuid)',
    'public.pk_email_attempt(uuid, text, int)',
    'public.pk_email_mark_verified(uuid, uuid)',
    'public.pk_email_consume_approval(uuid, text, int)',
    'public.pk_email_has_approval(uuid, text, int)',
    'public.pk_device_history_count(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
