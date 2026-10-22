-- Mr.Satto 工程4B【草案・未適用】: AI利用量（トークン枠）管理の台帳
--
-- ★このファイルは「設計レビュー用の草案」です。Supabaseには適用していません。
--   ユーザーが内容を確認し、了承した後に、ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001/0002と同じ手動適用の運用）。適用前に必ず Supabase の Backups / PITR の状態を確認してください。
--
-- 目的:
--   Premium契約者のAI補助機能（OpenAI API）について、「請求期間ごとに実コスト約500円相当まで」という
--   上限を、サーバー側（DB）で確実に守るための台帳を作る。
--
-- 設計方針:
--   1. 金額は内部では「µUSD（1ドルの100万分の1）」の整数で保持する（浮動小数点の誤差を避ける）。
--      円換算・AIトークン換算は「表示時」にアプリ側で行う。DBは換算レートを知らない。
--   2. 期間ごとの上限額（limit_micro_usd）は「期間作成時」に行へ固定保存する。
--      為替・モデル・価格・換算率を後で変えても、進行中の期間の上限は変わらず、次の期間から反映される。
--   3. 「予約→実行→確定/解放」方式。AI呼び出しの前に最悪ケースの金額を予約し、
--      予約できた場合のみ呼び出す。同一ユーザーの予約は pg_advisory_xact_lock + 行ロックで直列化し、
--      同時リクエストでも「確定額＋予約額」が上限を超えない。
--   4. 台帳にはファイル内容・AIへの入力・AIの応答は一切保存しない（件数・トークン数・金額・モデル名・状態のみ）。
--   5. 書き込み・読み取りはService Role専用の関数経由のみ。anon/authenticated（ブラウザ側）からは
--      テーブルも関数も一切触れない（RLS有効＋ポリシー無し＋権限REVOKE）。
--   6. 既存データは削除・更新しない。subscriptionsへの変更は「NULL許容の列の追加」のみ。
--   7. 何度流しても安全（IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS）。
--
-- 状態の意味（ai_usage_requests.status）:
--   reserved : 予約済み（AI呼び出し前〜実行中）
--   settled  : 確定済み（実際のAPI使用量に基づく金額を計上済み）
--   released : 解放済み（「課金されていない」と確実に言える失敗のみ。予約額を返却）
--   lapsed   : 期限切れ（予約したまま確定も解放もされなかった＝課金有無が不明）。
--              安全側に倒し「予約額ぶん使用済み」として計上する。後から確定/解放が届けば実額に補正する。

-- 途中でエラーが起きた場合に中途半端な状態を残さないよう、全体を1つのトランザクションにしている。
begin;

-- ============================================================
-- 1. subscriptions への列追加（NULL許容・既存行は変更しない）
-- ============================================================
alter table public.subscriptions
  add column if not exists current_period_start timestamptz;
alter table public.subscriptions
  add column if not exists stripe_price_id text;

alter table public.subscriptions
  add column if not exists stripe_synced_at timestamptz;

comment on column public.subscriptions.stripe_synced_at is
  'Stripeから契約の最新状態を取得した時刻。Webhookは、これより古い取得結果では上書きしない（古いイベントによる状態の巻き戻しを防ぐ）。';

comment on column public.subscriptions.current_period_start is
  'Stripeの現在の請求期間の開始時刻。Webhookが同期する（未同期の既存行はNULL→ai_derive_periodが終了日から逆算）。';
comment on column public.subscriptions.stripe_price_id is
  '契約中のStripe Price ID。権限判定には使わない（Premiumは1,100円に統一する方針）。'
  '旧価格から新価格への契約移行の進捗確認（旧Price IDの契約が0件になったか）にのみ使う。移行完了後は参照されない。';

-- ============================================================
-- 2. ai_usage_periods : ユーザー×請求期間ごとの集計
-- ============================================================
create table if not exists public.ai_usage_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  limit_micro_usd bigint not null check (limit_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  request_count integer not null default 0 check (request_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start),
  unique (user_id, period_start)
);

comment on table public.ai_usage_periods is
  'ユーザー×請求期間ごとのAI利用量集計（µUSD整数）。spent=確定済み実コスト(+期限切れ予約)、reserved=予約中。'
  '個人情報・ファイル内容・AI入出力は持たない。書き込みはai_reserve/ai_settle/ai_release経由のみ。';

create index if not exists ai_usage_periods_user_period_idx
  on public.ai_usage_periods (user_id, period_start desc);

alter table public.ai_usage_periods enable row level security;
-- ポリシーは意図的に作らない（anon/authenticatedは参照も変更も不可。Service Roleのみ）。

drop trigger if exists set_ai_usage_periods_updated_at on public.ai_usage_periods;
create trigger set_ai_usage_periods_updated_at
  before update on public.ai_usage_periods
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. ai_usage_requests : 1回のAI呼び出しごとの台帳（内容は保存しない）
-- ============================================================
create table if not exists public.ai_usage_requests (
  id uuid primary key,  -- サーバーが呼び出しごとに発行する冪等キー（重複呼び出しの二重計上を防ぐ）
  user_id uuid not null references auth.users (id) on delete cascade,
  period_id uuid not null references public.ai_usage_periods (id) on delete cascade,
  feature text not null,   -- 例: 'calendar-import'（機能名のみ。内容は入れない）
  model text not null,     -- 例: 'gpt-6-luna'
  price_version text,      -- 計算に使った単価表の版（例: '2026-10-22'）。価格改定時の追跡用
  status text not null default 'reserved'
    check (status in ('reserved', 'settled', 'released', 'lapsed')),
  reserved_micro_usd bigint not null check (reserved_micro_usd > 0),
  actual_micro_usd bigint check (actual_micro_usd >= 0),
  input_tokens integer check (input_tokens >= 0),
  cached_input_tokens integer check (cached_input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  error_code text,         -- 解放理由などの短いコードのみ（エラー本文・入力内容は入れない）
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz
);

comment on table public.ai_usage_requests is
  'AI呼び出し1回ごとの予約・確定の台帳。保存するのは機能名/モデル名/トークン数/金額/状態のみ。'
  'ファイル内容・プロンプト・AI応答は保存しない。書き込みは関数経由のみ。';

create index if not exists ai_usage_requests_user_status_idx
  on public.ai_usage_requests (user_id, status, expires_at);
create index if not exists ai_usage_requests_user_created_idx
  on public.ai_usage_requests (user_id, created_at desc);
create index if not exists ai_usage_requests_period_idx
  on public.ai_usage_requests (period_id);

alter table public.ai_usage_requests enable row level security;
-- ポリシーは意図的に作らない。

-- Supabaseは public スキーマの新規オブジェクトへ anon/authenticated の権限を既定で付与するため、明示的に剥奪する。
revoke all on table public.ai_usage_periods from public, anon, authenticated;
revoke all on table public.ai_usage_requests from public, anon, authenticated;

-- ============================================================
-- 4. 内部関数: 請求期間の導出（Premium判定込み）
-- ============================================================
-- 戻り値 reason: 'ok' | 'not_premium' | 'period_unknown'
-- 期間の決め方:
--   終了 = subscriptions.current_period_end（NULLなら created_at + 1か月）
--   開始 = subscriptions.current_period_start（NULLなら 終了 - 1か月）
--   終了が過去（Webhook遅延など）なら、1か月ずつ先へ送って「いま」を含む期間にする（最大24回）。
-- 判定は既存アプリと同じ: plan='premium' かつ status が active/trialing。
create or replace function public.ai_derive_period(p_user_id uuid)
returns table (reason text, period_start timestamptz, period_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
  v_start timestamptz;
  v_end timestamptz;
  i integer := 0;
begin
  select sub.plan, sub.status, sub.current_period_start, sub.current_period_end, sub.created_at
    into s
    from public.subscriptions sub
   where sub.user_id = p_user_id;

  if not found or s.plan is distinct from 'premium'
     or coalesce(s.status, '') not in ('active', 'trialing') then
    return query select 'not_premium'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_end := coalesce(s.current_period_end, s.created_at + interval '1 month');
  v_start := coalesce(s.current_period_start, v_end - interval '1 month');
  if v_start >= v_end then
    v_start := v_end - interval '1 month';
  end if;

  while v_end <= now() and i < 24 loop
    v_start := v_end;
    v_end := v_end + interval '1 month';
    i := i + 1;
  end loop;

  if v_end <= now() then
    return query select 'period_unknown'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'ok'::text, v_start, v_end;
end;
$$;

-- ============================================================
-- 5. 内部関数: 期間の現在値をJSONで返す
-- ============================================================
create or replace function public.ai_usage_json(p_period_id uuid, p_outcome text, p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', p_outcome,
    'request_status', p_status,
    'period_id', p.id,
    'period_start', p.period_start,
    'period_end', p.period_end,
    'limit_micro_usd', p.limit_micro_usd,
    'spent_micro_usd', p.spent_micro_usd,
    'reserved_micro_usd', p.reserved_micro_usd,
    'remaining_micro_usd', greatest(p.limit_micro_usd - p.spent_micro_usd - p.reserved_micro_usd, 0)
  )
  from public.ai_usage_periods p
  where p.id = p_period_id;
$$;

-- ============================================================
-- 6. ai_reserve : 予約（AI呼び出しの前に必ず呼ぶ）
-- ============================================================
-- outcome: ok | duplicate | quota_exceeded | too_many_concurrent | rate_limited
--          | not_premium | period_unknown | invalid
-- p_limit_micro_usd は「期間を新規作成するとき」だけ使われ、既存期間の上限は変更しない。
create or replace function public.ai_reserve(
  p_user_id uuid,
  p_request_id uuid,
  p_feature text,
  p_model text,
  p_reserve_micro_usd bigint,
  p_limit_micro_usd bigint,
  p_ttl_seconds integer default 1800,
  p_max_concurrent integer default 2,
  p_max_per_minute integer default 10,
  p_price_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_der record;
  v_period public.ai_usage_periods%rowtype;
  v_req public.ai_usage_requests%rowtype;
  v_active integer;
  v_recent integer;
begin
  if p_user_id is null or p_request_id is null
     or p_feature is null or length(p_feature) = 0
     or p_model is null or length(p_model) = 0
     or coalesce(p_reserve_micro_usd, 0) <= 0
     or coalesce(p_limit_micro_usd, 0) <= 0
     or coalesce(p_ttl_seconds, 0) <= 0
     or coalesce(p_max_concurrent, 0) <= 0
     or coalesce(p_max_per_minute, 0) <= 0 then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  -- 同一ユーザーの予約を直列化（トランザクション終了で自動解放）
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || p_user_id::text, 0));

  -- 冪等性: 同じrequest_idは二重に計上しない
  select * into v_req from public.ai_usage_requests r where r.id = p_request_id;
  if found then
    if v_req.user_id <> p_user_id then
      return jsonb_build_object('outcome', 'invalid');
    end if;
    return public.ai_usage_json(v_req.period_id, 'duplicate', v_req.status);
  end if;

  -- 期限切れの予約を「使用済み（課金有無不明）」として確定させる（軽量な遅延クリーンアップ）
  with lapsed as (
    update public.ai_usage_requests r
       set status = 'lapsed'
     where r.user_id = p_user_id
       and r.status = 'reserved'
       and r.expires_at <= now()
    returning r.period_id, r.reserved_micro_usd
  ), agg as (
    select l.period_id, sum(l.reserved_micro_usd)::bigint as amt
      from lapsed l group by l.period_id
  )
  update public.ai_usage_periods p
     set reserved_micro_usd = p.reserved_micro_usd - agg.amt,
         spent_micro_usd = p.spent_micro_usd + agg.amt
    from agg
   where p.id = agg.period_id;

  -- Premium判定と請求期間の導出
  select * into v_der from public.ai_derive_period(p_user_id);
  if v_der.reason <> 'ok' then
    return jsonb_build_object('outcome', v_der.reason);
  end if;

  -- 既存期間との重複判定（開始日がずれても使用量をリセットしない。境界は1日の許容を持たせる）
  select * into v_period
    from public.ai_usage_periods p
   where p.user_id = p_user_id
     and p.period_start < v_der.period_end - interval '1 day'
     and p.period_end > v_der.period_start + interval '1 day'
   order by p.period_start desc
   limit 1
   for update;

  if found then
    if v_period.period_end < v_der.period_end then
      update public.ai_usage_periods p
         set period_end = v_der.period_end
       where p.id = v_period.id
      returning * into v_period;
    end if;
  else
    insert into public.ai_usage_periods (user_id, period_start, period_end, limit_micro_usd)
    values (p_user_id, v_der.period_start, v_der.period_end, p_limit_micro_usd)
    on conflict (user_id, period_start) do nothing;

    select * into v_period
      from public.ai_usage_periods p
     where p.user_id = p_user_id and p.period_start = v_der.period_start
       for update;
  end if;

  -- 同時実行数・直近1分の回数（DBで数えるため複数インスタンスでも有効）
  select count(*) into v_active
    from public.ai_usage_requests r
   where r.user_id = p_user_id and r.status = 'reserved' and r.expires_at > now();
  if v_active >= p_max_concurrent then
    return public.ai_usage_json(v_period.id, 'too_many_concurrent', null);
  end if;

  select count(*) into v_recent
    from public.ai_usage_requests r
   where r.user_id = p_user_id and r.created_at > now() - interval '1 minute';
  if v_recent >= p_max_per_minute then
    return public.ai_usage_json(v_period.id, 'rate_limited', null);
  end if;

  -- 上限チェック: 確定済み＋予約中＋今回の予約 <= 上限
  if v_period.spent_micro_usd + v_period.reserved_micro_usd + p_reserve_micro_usd
       > v_period.limit_micro_usd then
    return public.ai_usage_json(v_period.id, 'quota_exceeded', null);
  end if;

  insert into public.ai_usage_requests
    (id, user_id, period_id, feature, model, price_version, status, reserved_micro_usd, expires_at)
  values
    (p_request_id, p_user_id, v_period.id, p_feature, p_model, p_price_version, 'reserved',
     p_reserve_micro_usd, now() + make_interval(secs => p_ttl_seconds));

  update public.ai_usage_periods p
     set reserved_micro_usd = p.reserved_micro_usd + p_reserve_micro_usd,
         request_count = p.request_count + 1
   where p.id = v_period.id;

  return public.ai_usage_json(v_period.id, 'ok', 'reserved');
end;
$$;

-- ============================================================
-- 7. ai_settle : 確定（実際のAPI使用量に基づく金額を計上）
-- ============================================================
-- 何度呼んでも二重計上しない（settled済みは already_settled）。
-- released/lapsed になった後でも、課金が実際にあったと分かれば実額へ補正できる（事実を優先）。
-- 実額が予約額を超えた場合も事実どおり記録する（outcome='ok_over_reservation'。予約が最悪ケースなら通常起きない）。
create or replace function public.ai_settle(
  p_user_id uuid,
  p_request_id uuid,
  p_actual_micro_usd bigint,
  p_input_tokens integer default null,
  p_cached_input_tokens integer default null,
  p_output_tokens integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.ai_usage_requests%rowtype;
  v_period public.ai_usage_periods%rowtype;
  v_outcome text := 'ok';
begin
  if p_user_id is null or p_request_id is null or coalesce(p_actual_micro_usd, -1) < 0 then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_req
    from public.ai_usage_requests r
   where r.id = p_request_id and r.user_id = p_user_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_req.status = 'settled' then
    return public.ai_usage_json(v_req.period_id, 'already_settled', v_req.status);
  end if;

  select * into v_period from public.ai_usage_periods p where p.id = v_req.period_id for update;

  if v_req.status = 'reserved' then
    update public.ai_usage_periods p
       set reserved_micro_usd = p.reserved_micro_usd - v_req.reserved_micro_usd,
           spent_micro_usd = p.spent_micro_usd + p_actual_micro_usd
     where p.id = v_period.id;
  elsif v_req.status = 'lapsed' then
    -- 期限切れ時に予約額ぶんをspentへ計上済み → 実額との差分だけ補正
    update public.ai_usage_periods p
       set spent_micro_usd = p.spent_micro_usd - v_req.reserved_micro_usd + p_actual_micro_usd
     where p.id = v_period.id;
  else  -- released
    update public.ai_usage_periods p
       set spent_micro_usd = p.spent_micro_usd + p_actual_micro_usd
     where p.id = v_period.id;
  end if;

  if p_actual_micro_usd > v_req.reserved_micro_usd then
    v_outcome := 'ok_over_reservation';
  end if;

  update public.ai_usage_requests r
     set status = 'settled',
         actual_micro_usd = p_actual_micro_usd,
         input_tokens = p_input_tokens,
         cached_input_tokens = p_cached_input_tokens,
         output_tokens = p_output_tokens,
         settled_at = now()
   where r.id = v_req.id;

  return public.ai_usage_json(v_req.period_id, v_outcome, 'settled');
end;
$$;

-- ============================================================
-- 8. ai_release : 解放（「課金されていない」と確実に言える失敗のみ）
-- ============================================================
-- 例: OpenAIへ送る前に自サーバーで失敗した／OpenAIが401/400等で明確に拒否した。
-- タイムアウト・接続断・応答不明など「課金有無が不明」の場合は呼ばない（予約は期限切れで安全側に計上される）。
-- settled済みは変更しない（実額を取り消さない）。
create or replace function public.ai_release(
  p_user_id uuid,
  p_request_id uuid,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.ai_usage_requests%rowtype;
  v_period public.ai_usage_periods%rowtype;
begin
  if p_user_id is null or p_request_id is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_req
    from public.ai_usage_requests r
   where r.id = p_request_id and r.user_id = p_user_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_req.status = 'released' then
    return public.ai_usage_json(v_req.period_id, 'already_released', v_req.status);
  end if;
  if v_req.status = 'settled' then
    return public.ai_usage_json(v_req.period_id, 'already_settled', v_req.status);
  end if;

  select * into v_period from public.ai_usage_periods p where p.id = v_req.period_id for update;

  if v_req.status = 'reserved' then
    update public.ai_usage_periods p
       set reserved_micro_usd = p.reserved_micro_usd - v_req.reserved_micro_usd
     where p.id = v_period.id;
  else  -- lapsed: 予約額はspentへ計上済みなので戻す
    update public.ai_usage_periods p
       set spent_micro_usd = p.spent_micro_usd - v_req.reserved_micro_usd
     where p.id = v_period.id;
  end if;

  update public.ai_usage_requests r
     set status = 'released',
         error_code = left(p_error_code, 64),
         settled_at = now()
   where r.id = v_req.id;

  return public.ai_usage_json(v_req.period_id, 'ok', 'released');
end;
$$;

-- ============================================================
-- 9. ai_get_usage : 表示用の現在状況（読み取り専用）
-- ============================================================
-- 期限切れ予約は「使用済み」として加味して返す（reserve時のクリーンアップ前でも表示が正しい）。
-- 期間がまだ作られていない（初回利用前）場合は、導出した期間と p_default_limit で0使用量を返す。
create or replace function public.ai_get_usage(p_user_id uuid, p_default_limit_micro_usd bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_der record;
  v_period public.ai_usage_periods%rowtype;
  v_expired bigint;
  v_spent bigint;
  v_reserved bigint;
begin
  select * into v_der from public.ai_derive_period(p_user_id);

  select * into v_period
    from public.ai_usage_periods p
   where p.user_id = p_user_id and p.period_start <= now() and p.period_end > now()
   order by p.period_start desc
   limit 1;

  if not found then
    return jsonb_build_object(
      'entitled', v_der.reason = 'ok',
      'reason', v_der.reason,
      'period_start', v_der.period_start,
      'period_end', v_der.period_end,
      'limit_micro_usd', p_default_limit_micro_usd,
      'spent_micro_usd', 0,
      'reserved_micro_usd', 0,
      'remaining_micro_usd', p_default_limit_micro_usd
    );
  end if;

  select coalesce(sum(r.reserved_micro_usd), 0) into v_expired
    from public.ai_usage_requests r
   where r.period_id = v_period.id and r.status = 'reserved' and r.expires_at <= now();

  v_spent := v_period.spent_micro_usd + v_expired;
  v_reserved := v_period.reserved_micro_usd - v_expired;

  return jsonb_build_object(
    'entitled', v_der.reason = 'ok',
    'reason', v_der.reason,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'limit_micro_usd', v_period.limit_micro_usd,
    'spent_micro_usd', v_spent,
    'reserved_micro_usd', v_reserved,
    'remaining_micro_usd', greatest(v_period.limit_micro_usd - v_spent - v_reserved, 0)
  );
end;
$$;

-- ============================================================
-- 10. 関数の実行権限: Service Roleのみ（ブラウザ側から呼べない）
-- ============================================================
revoke all on function public.ai_derive_period(uuid) from public, anon, authenticated;
revoke all on function public.ai_usage_json(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_reserve(uuid, uuid, text, text, bigint, bigint, integer, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.ai_settle(uuid, uuid, bigint, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.ai_release(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_get_usage(uuid, bigint) from public, anon, authenticated;

grant execute on function public.ai_reserve(uuid, uuid, text, text, bigint, bigint, integer, integer, integer, text)
  to service_role;
grant execute on function public.ai_settle(uuid, uuid, bigint, integer, integer, integer) to service_role;
grant execute on function public.ai_release(uuid, uuid, text) to service_role;
grant execute on function public.ai_get_usage(uuid, bigint) to service_role;
-- ai_derive_period / ai_usage_json は内部用。Supabaseの既定権限でservice_roleにも付与されてしまうため明示的に剥奪する
-- （上記のSECURITY DEFINER関数は所有者権限で実行されるため、これらを内部呼び出しできる）。
revoke all on function public.ai_derive_period(uuid) from service_role;
revoke all on function public.ai_usage_json(uuid, text, text) from service_role;

commit;
