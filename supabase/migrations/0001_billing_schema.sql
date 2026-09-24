-- Mr.Satto Phase 3: 会員登録・課金基盤のDBスキーマ
--
-- このファイルはSupabase側で手動適用する想定（Supabase CLIが未接続のため、
-- このセッションからは直接適用できない）。
-- 適用方法: Supabaseダッシュボードの SQL Editor に貼り付けて実行するか、
--          `supabase db push`（Supabase CLIをプロジェクトにリンク済みの場合）。
--
-- 設計方針:
--   - profiles      : auth.users の付随情報（メールアドレスのキャッシュ等）
--   - subscriptions : ユーザーごとの「現在有効な」Stripe契約状態（1ユーザー1行）
--   - stripe_webhook_events : Webhookの冪等性を保証するための受信済みイベントID台帳
--   - カード番号等の決済情報は一切保存しない（Stripe Checkout/Customer Portalに一任）
--   - RLSにより「自分の行だけ」参照可能。書き込みはService Role（Webhook）経由のみ。

-- ============================================================
-- profiles
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'auth.usersに対応するアプリ側プロフィール。会員登録時にトリガーで自動作成される。';

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- update/insert/deleteのポリシーは意図的に作らない。
-- 通常のログインユーザー(anon/authenticatedロール)からの書き込みは一切許可せず、
-- 新規行の作成はトリガー、更新はService Role（必要になった場合）にのみ許可する。

-- 新規ユーザー登録時に自動でprofilesへ1行作成するトリガー
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- subscriptions
-- ============================================================
-- 1ユーザーにつき「現在の」契約状態を1行だけ保持する（履歴管理はStripe側に一任し、
-- Mr.Satto側では最新状態のみを同期する）。
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text check (plan in ('standard', 'premium')),
  status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'ユーザーごとの現在のStripe契約状態。正式な情報源はStripeであり、このテーブルは'
  'Webhook（src/app/api/stripe/webhook/route.ts）によって同期されるキャッシュ。'
  'plan/statusがnullの行は「Stripe Customerは存在するが契約が確定していない」状態を表す。';

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- insert/update/deleteのポリシーは作らない。
-- 書き込みは以下の2箇所のみ（いずれもService Role Keyを使うサーバー専用コード）:
--   - src/app/api/stripe/checkout/route.ts （Stripe Customer作成時の紐付け）
--   - src/app/api/stripe/webhook/route.ts  （契約状態の同期）
-- これにより「クライアントから自分のplanを書き換える」ことは構造的に不可能。

-- ============================================================
-- stripe_webhook_events（Webhookの冪等性）
-- ============================================================
create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_webhook_events is
  '処理済みのStripe Webhookイベントidの台帳。同じイベントが再送されても'
  'event_idの重複insertが失敗することで二重処理を防ぐ（冪等性の保証）。';

alter table public.stripe_webhook_events enable row level security;
-- どのロールにもポリシーを作らない = anon/authenticatedからは一切参照・変更不可。
-- Service Role（Webhookハンドラ）のみがRLSをバイパスしてアクセスできる。

-- ============================================================
-- updated_at 自動更新
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();
