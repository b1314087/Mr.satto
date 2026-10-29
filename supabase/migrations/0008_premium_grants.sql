-- Mr.Satto: プレミアムの「無料付与」と「3日間の無料お試し」
--
-- ★このファイルはSupabaseへ「まだ適用していません」。ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001〜0007と同じ手動適用の運用）。適用は、コードを本番へ公開（push）する「前」に行ってください。
--
-- 目的:
--   1. 管理画面から「この人に○月○日まで、プレミアムを無料で付与」できるようにする（source = 'admin'）。
--   2. ログイン中の本人が、アカウントごとに1回だけ「3日間の無料お試し」を始められるようにする（source = 'trial'）。
--   どちらも Stripe の契約（subscriptions）とは別に管理する。Stripeの契約・請求には一切触れない。
--   期限（ends_at）を過ぎると、自動で無料プランに戻る（アプリ側が期限を見て判定する）。
--
-- 設計方針:
--   - premium_grants       : 1ユーザー1行（いまの付与）。新しく付与すると上書きする。
--   - premium_trial_claims : 無料お試しを使った記録（1ユーザー1行）。付与を取り消しても残り、2回目は使えない。
--   - 書き込みはサーバー（Service Role）専用。ブラウザ側からは、自分の付与の「読み取り」だけできる。
--   - アカウントを削除すると、どちらの行も連鎖して消える。
--   - AIの利用枠: ai_derive_period を更新し、有効な付与がある人も「プレミアム」として期間を持てるようにする
--     （Stripeの契約が有効ならそちらを優先する。既存の動作は変えない）。
--   - 何度流しても安全（IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS）。

begin;

create table if not exists public.premium_grants (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null check (source in ('admin', 'trial')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  granted_by uuid references auth.users (id) on delete set null,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

comment on table public.premium_grants is
  'プレミアムの無料付与（管理者の付与 / 3日間の無料お試し）。1ユーザー1行。Stripeの契約とは別。期限(ends_at)を過ぎると無効。';

alter table public.premium_grants enable row level security;

drop policy if exists "premium_grants_select_own" on public.premium_grants;
create policy "premium_grants_select_own"
  on public.premium_grants for select
  using (auth.uid() = user_id);

-- 書き込み用のポリシーは作らない（Service Roleだけが書く）。anon / authenticated は読み取り(自分の行)のみ。
revoke all on table public.premium_grants from public, anon, authenticated;
grant select on table public.premium_grants to authenticated;

create table if not exists public.premium_trial_claims (
  user_id uuid primary key references auth.users (id) on delete cascade,
  claimed_at timestamptz not null default now()
);

comment on table public.premium_trial_claims is
  '3日間の無料お試しを使った記録（1ユーザー1行）。付与を取り消しても残り、2回目のお試しを防ぐ。Service Roleだけが読み書きする。';

alter table public.premium_trial_claims enable row level security;
revoke all on table public.premium_trial_claims from public, anon, authenticated;

-- AIの請求期間の導出: Stripeの契約が有効ならそれを使う（従来どおり）。なければ、有効な付与の期間を使う。
create or replace function public.ai_derive_period(p_user_id uuid)
returns table (reason text, period_start timestamptz, period_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
  g record;
  v_sub_active boolean := false;
  v_start timestamptz;
  v_end timestamptz;
  i integer := 0;
begin
  select sub.plan, sub.status, sub.current_period_start, sub.current_period_end, sub.created_at
    into s
    from public.subscriptions sub
   where sub.user_id = p_user_id;

  if found then
    v_sub_active := s.plan is not distinct from 'premium' and coalesce(s.status, '') in ('active', 'trialing');
  end if;

  if v_sub_active then
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

    if v_end > now() then
      return query select 'ok'::text, v_start, v_end;
      return;
    end if;
    -- 契約の期間が分からないとき: 有効な付与があれば、そちらで使える（下へ進む）
  end if;

  select pg.starts_at, pg.ends_at
    into g
    from public.premium_grants pg
   where pg.user_id = p_user_id
     and pg.starts_at <= now()
     and pg.ends_at > now();

  if found then
    return query select 'ok'::text, g.starts_at, g.ends_at;
    return;
  end if;

  if v_sub_active then
    return query select 'period_unknown'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'not_premium'::text, null::timestamptz, null::timestamptz;
end;
$$;

revoke all on function public.ai_derive_period(uuid) from public, anon, authenticated;
revoke all on function public.ai_derive_period(uuid) from service_role;

commit;
