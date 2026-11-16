-- ============================================================================
-- Mr.Satto：パスキー機能を本番で使うための SQL（1回で実行できるようにまとめたもの）
--   中身は supabase/migrations/0011_passkeys_devices_sessions.sql と 0012_passkey_email_verification.sql をこの順につなげたもの。
--   何度実行しても安全（すでに表がある場合は作り直さず、関数だけを最新にする）。既存の表・データは変更しない。
--   Supabase → SQL Editor → New query に全文を貼り付けて Run。最後に「Success. No rows returned」と出れば成功。
--   ★このファイルは自動テストで、0011と0012をつなげた内容と一致することを確かめている（手で直さない）。
-- ============================================================================

-- Mr.Satto: 有料プランのアカウント共有対策（パスキー・登録端末・同時利用・記録）
--
-- ★このファイルはSupabaseへ「まだ適用していません」。ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001〜0010と同じ手動適用の運用）。何度実行しても安全（再実行できる）。既存の表・データは一切変更しない。
--   取り消すときは supabase/rollbacks/0011_passkeys_devices_sessions_rollback.sql。
--
-- 方針:
--   - パスキーは「公開鍵」と「Credential ID」だけを保存する（秘密鍵はサーバーに来ない。WebAuthnの仕組み上、送られない）。
--   - 端末の登録は、パスキーとは別に管理する（パスキーは複数の端末に同期されるため、パスキーの数では端末の数を数えられない）。
--     端末は、サーバーが発行した乱数（Cookieに入れる）の「ハッシュ」で識別する。乱数そのものは保存しない。
--   - 同時利用は「期限つきの利用ロック」（1ユーザー1行）で管理する。更新・解放は、ロックを持っている本人の
--     セッション（乱数のハッシュ）が一致するときだけ行う（古いセッションが新しいセッションのロックを消さない）。
--   - 端末の上限・ロックの取得は、DBの関数の中で、ユーザーごとのロックをかけてから判定する（同時に押しても上限を超えない）。
--   - 表と関数は、Service Role（サーバー）だけが使える。RLSを有効にし、ポリシーは作らない
--     （anon / authenticated からは、自分の行も含めて読み書きできない。他人の認証情報・端末情報は取得・変更できない）。
--   - 記録（auth_security_events）には、IPアドレスそのものは保存しない（ハッシュの先頭だけ）。IPだけで不正と判定しない。

-- 1. パスキー（公開鍵）
create table if not exists public.passkey_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique check (credential_id ~ '^[A-Za-z0-9_-]{16,1400}$'),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{16,4000}$'),
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  device_type text check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  aaguid text,
  label text not null default 'パスキー' check (char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists passkey_credentials_user_idx on public.passkey_credentials(user_id);
comment on table public.passkey_credentials is 'パスキーの公開鍵とCredential ID（秘密鍵は保存しない）。Service Roleだけが読み書きする。';

-- 2. 登録端末（パスキーとは別に管理する。1アカウント最大2台は関数で判定する）
create table if not exists public.registered_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null default 'この端末' check (char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists registered_devices_user_active_idx on public.registered_devices(user_id) where revoked_at is null;
create index if not exists registered_devices_user_created_idx on public.registered_devices(user_id, created_at);
comment on table public.registered_devices is '有料プランの登録端末。Cookieに入れた乱数のハッシュで識別する。解除した端末は revoked_at を入れて残す（登録の回数制限に使う）。';

-- 3. パスキーの登録・認証のチャレンジ（1回だけ使える・5分で期限切れ）
create table if not exists public.passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('register', 'authenticate')),
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{16,200}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists passkey_challenges_user_idx on public.passkey_challenges(user_id, created_at);

-- 4. 直近の本人確認（パスキーで確認してから5分間だけ、端末の解除・パスキーの削除などができる）
create table if not exists public.passkey_verifications (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists passkey_verifications_user_idx on public.passkey_verifications(user_id);

-- 5. 同時利用のロック（1ユーザー1行。期限つき）
create table if not exists public.paid_session_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  device_id uuid not null references public.registered_devices(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null default now(),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
comment on table public.paid_session_leases is '有料プランの同時利用のロック。持ち主のセッション（乱数のハッシュ）が一致するときだけ更新・解放できる。';

-- 6. 認証まわりの記録（不審な利用の検知用。IPそのものは保存しない）
create table if not exists public.auth_security_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]{3,40}$'),
  detail jsonb not null default '{}'::jsonb,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{16}$'),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists auth_security_events_user_kind_idx on public.auth_security_events(user_id, kind, created_at);

-- RLS：すべて有効にし、ポリシーは作らない（Service Roleだけが操作できる）
alter table public.passkey_credentials enable row level security;
alter table public.registered_devices enable row level security;
alter table public.passkey_challenges enable row level security;
alter table public.passkey_verifications enable row level security;
alter table public.paid_session_leases enable row level security;
alter table public.auth_security_events enable row level security;
revoke all on public.passkey_credentials, public.registered_devices, public.passkey_challenges,
  public.passkey_verifications, public.paid_session_leases, public.auth_security_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 関数（Service Roleだけが実行できる）
-- ---------------------------------------------------------------------------

-- チャレンジを作る（古いものはここで消す）
create or replace function public.pk_create_challenge(p_user uuid, p_kind text, p_challenge text, p_ttl_sec int default 300)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  delete from public.passkey_challenges where user_id = p_user and (expires_at < now() - interval '1 hour' or used_at is not null);
  insert into public.passkey_challenges(user_id, kind, challenge, expires_at)
  values (p_user, p_kind, p_challenge, now() + make_interval(secs => greatest(30, least(p_ttl_sec, 900))))
  returning id into v_id;
  return v_id;
end;
$$;

-- チャレンジを1回だけ使う（同じユーザー・同じ種類・期限内・未使用のときだけ返す）
create or replace function public.pk_consume_challenge(p_id uuid, p_user uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_challenge text;
begin
  update public.passkey_challenges
     set used_at = now()
   where id = p_id and user_id = p_user and kind = p_kind and used_at is null and expires_at > now()
  returning challenge into v_challenge;
  return v_challenge;
end;
$$;

-- 端末を登録する。上限（p_max台）と、期間内の登録回数（p_window_sec秒にp_window_max回まで）をロックの中で判定する
create or replace function public.pk_register_device(
  p_user uuid, p_token_hash text, p_label text, p_max int default 2, p_window_sec int default 604800, p_window_max int default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_existing public.registered_devices; v_active int; v_recent int; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('pk_devices:' || p_user::text, 0));

  select * into v_existing from public.registered_devices where token_hash = p_token_hash;
  if found then
    if v_existing.user_id <> p_user then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    if v_existing.revoked_at is null then
      update public.registered_devices set last_seen_at = now() where id = v_existing.id;
      return jsonb_build_object('outcome', 'ok', 'device_id', v_existing.id, 'already', true);
    end if;
    -- 解除した端末の識別値は使い回さない（新しい乱数で登録し直す）
    return jsonb_build_object('outcome', 'revoked');
  end if;

  select count(*) into v_active from public.registered_devices where user_id = p_user and revoked_at is null;
  if v_active >= p_max then
    return jsonb_build_object('outcome', 'limit', 'active', v_active);
  end if;

  select count(*) into v_recent from public.registered_devices
   where user_id = p_user and created_at > now() - make_interval(secs => p_window_sec);
  if v_recent >= p_window_max then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  insert into public.registered_devices(user_id, token_hash, label)
  values (p_user, p_token_hash, left(coalesce(nullif(p_label, ''), 'この端末'), 80))
  returning id into v_id;
  return jsonb_build_object('outcome', 'ok', 'device_id', v_id, 'already', false);
end;
$$;

-- 端末の登録を解除する（その端末が持っていた利用ロックも消す）
create or replace function public.pk_revoke_device(p_user uuid, p_device uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int;
begin
  perform pg_advisory_xact_lock(hashtextextended('pk_devices:' || p_user::text, 0));
  update public.registered_devices set revoked_at = now()
   where id = p_device and user_id = p_user and revoked_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    delete from public.paid_session_leases where user_id = p_user and device_id = p_device;
  end if;
  return v_rows = 1;
end;
$$;

-- 利用ロックを取る。空き・期限切れ・自分のセッション・切り替え（p_takeover）のときだけ取れる。
-- 端末が有効（解除されていない・本人の端末）であることもここで確かめる
create or replace function public.pk_acquire_lease(p_user uuid, p_device uuid, p_token_hash text, p_ttl_sec int default 180, p_takeover boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.paid_session_leases; v_ttl interval := make_interval(secs => greatest(30, least(p_ttl_sec, 3600)));
begin
  if not exists (select 1 from public.registered_devices where id = p_device and user_id = p_user and revoked_at is null) then
    return jsonb_build_object('outcome', 'device_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pk_lease:' || p_user::text, 0));
  select * into v_row from public.paid_session_leases where user_id = p_user for update;
  if not found then
    insert into public.paid_session_leases(user_id, device_id, token_hash, verified_at, acquired_at, expires_at, updated_at)
    values (p_user, p_device, p_token_hash, now(), now(), now() + v_ttl, now());
    return jsonb_build_object('outcome', 'ok', 'took_over', false);
  end if;

  if v_row.token_hash = p_token_hash or v_row.expires_at <= now() or p_takeover then
    update public.paid_session_leases
       set device_id = p_device, token_hash = p_token_hash, verified_at = now(), acquired_at = now(),
           expires_at = now() + v_ttl, updated_at = now()
     where user_id = p_user;
    return jsonb_build_object('outcome', 'ok',
      'took_over', v_row.token_hash <> p_token_hash and v_row.expires_at > now(),
      'previous_device', case when v_row.token_hash <> p_token_hash then v_row.device_id end);
  end if;

  return jsonb_build_object('outcome', 'in_use', 'device_id', v_row.device_id);
end;
$$;

-- 利用ロックの更新（定期確認）。自分のセッションのときだけ延長する。
-- 期限が切れていても、まだ誰にも取られていなければ（自分のセッションのままなら）延長する（スリープ明けなど）
create or replace function public.pk_heartbeat(p_user uuid, p_token_hash text, p_ttl_sec int default 180)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int;
begin
  update public.paid_session_leases l
     set expires_at = now() + make_interval(secs => greatest(30, least(p_ttl_sec, 3600))), updated_at = now()
   where l.user_id = p_user and l.token_hash = p_token_hash
     and exists (select 1 from public.registered_devices d where d.id = l.device_id and d.user_id = p_user and d.revoked_at is null);
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    update public.registered_devices set last_seen_at = now()
     where id = (select device_id from public.paid_session_leases where user_id = p_user) and last_seen_at < now() - interval '5 minutes';
    return 'ok';
  end if;
  return 'lost';
end;
$$;

-- 利用ロックの解放（ログアウト）。自分のセッションのときだけ消す（新しいセッションのロックは消さない）
create or replace function public.pk_release_lease(p_user uuid, p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int;
begin
  delete from public.paid_session_leases where user_id = p_user and token_hash = p_token_hash;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- すべてのセッションを終わらせる（パスワード変更のあと）。利用ロックと直近の本人確認を消す
create or replace function public.pk_end_all_sessions(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.paid_session_leases where user_id = p_user;
  delete from public.passkey_verifications where user_id = p_user;
end;
$$;

-- 有料機能を使えるかの判定に必要な状態を、1回の呼び出しでまとめて返す
create or replace function public.pk_access_state(p_user uuid, p_device_hash text, p_session_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_count int; v_device uuid; v_lease public.paid_session_leases; v_state text;
begin
  select count(*) into v_count from public.passkey_credentials where user_id = p_user;
  if p_device_hash is not null then
    select id into v_device from public.registered_devices where token_hash = p_device_hash and user_id = p_user and revoked_at is null;
  end if;
  select * into v_lease from public.paid_session_leases where user_id = p_user;
  if not found then
    v_state := 'none';
  elsif p_session_hash is not null and v_lease.token_hash = p_session_hash and v_lease.device_id = v_device then
    v_state := 'mine';
  elsif v_lease.expires_at <= now() or (v_device is not null and v_lease.device_id = v_device) then
    -- 期限切れ、または同じ端末の前のセッション（ブラウザを閉じて開き直した）なら、空いているのと同じ扱い（本人確認で取り直せる）
    v_state := 'free';
  else
    v_state := 'other';
  end if;
  return jsonb_build_object(
    'credential_count', v_count,
    'device_id', v_device,
    'lease', v_state,
    'verified_at', case when v_state = 'mine' then v_lease.verified_at end
  );
end;
$$;

-- 直近の本人確認を記録する／確かめる
create or replace function public.pk_create_verification(p_user uuid, p_token_hash text, p_credential text, p_ttl_sec int default 300)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.passkey_verifications where user_id = p_user and expires_at < now();
  insert into public.passkey_verifications(token_hash, user_id, credential_id, expires_at)
  values (p_token_hash, p_user, p_credential, now() + make_interval(secs => greatest(30, least(p_ttl_sec, 900))));
end;
$$;

create or replace function public.pk_check_verification(p_user uuid, p_token_hash text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.passkey_verifications where token_hash = p_token_hash and user_id = p_user and expires_at > now());
$$;

-- 認証の記録（古い記録は90日で消す）
create or replace function public.pk_log_event(p_user uuid, p_kind text, p_detail jsonb default '{}'::jsonb, p_ip_hash text default null, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.auth_security_events(user_id, kind, detail, ip_hash, user_agent)
  values (p_user, p_kind, coalesce(p_detail, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
  if random() < 0.01 then
    delete from public.auth_security_events where created_at < now() - interval '90 days';
  end if;
end;
$$;

create or replace function public.pk_count_events(p_user uuid, p_kind text, p_since_sec int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.auth_security_events
   where user_id = p_user and kind = p_kind and created_at > now() - make_interval(secs => p_since_sec);
$$;

-- 実行できるのは Service Role だけ
do $$
declare f text;
begin
  foreach f in array array[
    'public.pk_create_challenge(uuid, text, text, int)',
    'public.pk_consume_challenge(uuid, uuid, text)',
    'public.pk_register_device(uuid, text, text, int, int, int)',
    'public.pk_revoke_device(uuid, uuid)',
    'public.pk_acquire_lease(uuid, uuid, text, int, boolean)',
    'public.pk_heartbeat(uuid, text, int)',
    'public.pk_release_lease(uuid, text)',
    'public.pk_end_all_sessions(uuid)',
    'public.pk_access_state(uuid, text, text)',
    'public.pk_create_verification(uuid, text, text, int)',
    'public.pk_check_verification(uuid, text)',
    'public.pk_log_event(uuid, text, jsonb, text, text)',
    'public.pk_count_events(uuid, text, int)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

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
