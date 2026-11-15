-- 2026-11-15: 年額プラン（スタンダード 2,200円/年・プレミアム 11,000円/年）の追加に合わせて、
-- AIの利用枠の期間を「1か月ごと」に区切る。
--
-- これまでは、Stripeの契約の期間（current_period_start〜current_period_end）を、そのままAIの利用枠の期間にしていた。
-- 月額の契約は、これまでと同じ（契約の期間がそのまま1か月の枠）。
-- 年額の契約は、契約の期間が1年になるため、そのままだと「1年分の枠＝1か月分の上限」になってしまう。
-- そこで、契約の期間が1か月より長いときは、契約の開始日から1か月ずつ区切った「今の1か月」を枠の期間にする
-- （例：4月10日に年額で契約 → 4/10〜5/10、5/10〜6/10 … の枠。契約の終了日を超えない）。
--
-- 変えるのは public.ai_derive_period だけ（0008 で作った関数を置き換える）。テーブル・権限は変えない。

begin;

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
  v_win_start timestamptz;
  v_win_end timestamptz;
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

    -- 契約の期間がすでに終わっている（更新の通知が届いていない）ときは、1か月ずつ先へ進める（従来どおり）
    while v_end <= now() and i < 24 loop
      v_start := v_end;
      v_end := v_end + interval '1 month';
      i := i + 1;
    end loop;

    if v_end > now() then
      -- 契約の期間が1か月（＋数日の余裕）より長い（年額）ときは、開始日から1か月ずつ区切った「今の1か月」にする
      if v_end > v_start + interval '1 month' + interval '3 days' then
        -- 開始日から k か月後を毎回「開始日＋kか月」で求める（31日の契約が2月に28日へずれたまま戻らない、を防ぐ）
        i := 0;
        while v_start + make_interval(months => i + 1) <= now() and i < 24 loop
          i := i + 1;
        end loop;
        v_win_start := v_start + make_interval(months => i);
        v_win_end := least(v_start + make_interval(months => i + 1), v_end);
        return query select 'ok'::text, v_win_start, v_win_end;
        return;
      end if;
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
