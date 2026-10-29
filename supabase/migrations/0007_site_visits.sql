-- Mr.Satto: サイトの訪問数の集計（管理画面の「アクセス数」用）
--
-- このファイルはSupabase側で手動適用する想定（0001〜0006と同じ運用）。
-- 適用方法: Supabaseダッシュボードの SQL Editor に貼り付けて実行する。何度実行しても安全（再実行できる）。
--
-- 方針（個人を特定しない・Cookieを使わない集計）:
--   - 保存するのは、日ごとの「訪問者数」と「閲覧数（ページを開いた回数）」だけ（site_visits_daily）。
--     IPアドレス・ブラウザの情報・閲覧したページの内容は、一切保存しない。
--   - 「同じ人が1日に何回来ても1人」と数えるため、サーバーが、IPアドレスとブラウザの情報から
--     「その日だけ有効な、元に戻せない暗号の値（ハッシュ）」を作り、その日の重複確認にだけ使う（site_visitor_hashes）。
--     ハッシュは、毎日変わる値を混ぜて作るので、日をまたいで同じ人を追跡することはできない。
--     この表は、新しい訪問者が来たときに、前日より古い行を削除する（長く残さない）。
--   - 日付の境界は日本時間（Asia/Tokyo）。
--   - 2つの表は、Service Role（サーバー）だけが読み書きできる（RLSを有効にし、ポリシーは作らない）。
--   - 記録は record_site_visit() だけが行い、この関数もService Roleだけが実行できる。

create table if not exists public.site_visits_daily (
  visit_date date primary key,
  visitors integer not null default 0,
  pageviews integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.site_visits_daily is
  '日ごとの訪問者数（その日の重複を除いた人数）と閲覧数。個人を特定する情報は含まない。日付は日本時間。';

create table if not exists public.site_visitor_hashes (
  visit_date date not null,
  visitor_hash text not null,
  primary key (visit_date, visitor_hash)
);

comment on table public.site_visitor_hashes is
  'その日の重複確認だけに使う、元に戻せない値。前日より古い行は、新しい訪問者の記録時に削除される。';

alter table public.site_visits_daily enable row level security;
alter table public.site_visitor_hashes enable row level security;
-- ポリシーは意図的に作らない（anon / authenticated からは、読み書きとも一切できない。Service Roleは常に操作できる）。
revoke all on public.site_visits_daily from anon, authenticated;
revoke all on public.site_visitor_hashes from anon, authenticated;

create or replace function public.record_site_visit(p_visitor_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_rows integer;
  v_new integer := 0;
begin
  if p_visitor_hash is null or char_length(p_visitor_hash) not between 16 and 128 then
    return;
  end if;

  insert into public.site_visitor_hashes (visit_date, visitor_hash)
  values (v_today, p_visitor_hash)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    v_new := 1;
    -- 前日より古い重複確認用の値は、残さない
    delete from public.site_visitor_hashes where visit_date < v_today - 1;
  end if;

  insert into public.site_visits_daily as d (visit_date, visitors, pageviews)
  values (v_today, v_new, 1)
  on conflict (visit_date) do update
    set visitors = d.visitors + excluded.visitors,
        pageviews = d.pageviews + 1,
        updated_at = now();
end;
$$;

revoke all on function public.record_site_visit(text) from public, anon, authenticated;
grant execute on function public.record_site_visit(text) to service_role;
