-- 다음 근무 시작 시각: p_t(한국시간) 이후 첫 '근무 요일(1~p_maxdow) · 공휴일 아님'의 p_hour시
create or replace function public.next_open_at(p_t timestamp, p_maxdow int, p_hour int) returns timestamptz
language plpgsql stable security definer set search_path to 'public'
as $$
declare d date := p_t::date;
begin
  if not (extract(hour from p_t) < p_hour and extract(isodow from d) <= p_maxdow
          and not exists (select 1 from public.holidays h where h.day = d)) then d := d + 1; end if;
  for i in 0..30 loop
    exit when extract(isodow from d) <= p_maxdow and not exists (select 1 from public.holidays h where h.day = d);
    d := d + 1;
  end loop;
  return (d + make_time(p_hour, 0, 0)) at time zone 'Asia/Seoul';
end $$;

-- 공간 Talk·전화 연결용 근무 상태
--   work/reason/holiday/next : 담당자 공통 (평일 08~17시, 공휴일 제외 — is_work_time 과 같은 기준)
--   sales/sales_next          : 영업 (월~토 09~18시, 공휴일 제외)
create or replace function public.work_status() returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  t timestamp := now() at time zone 'Asia/Seoul';
  hol text;
  w boolean := public.is_work_time();
  s boolean;
  res jsonb;
begin
  select name into hol from public.holidays where day = t::date;
  s := hol is null and extract(isodow from t) <= 6 and extract(hour from t) between 9 and 17;
  res := jsonb_build_object('work', w, 'sales', s);
  if not w then
    res := res || jsonb_build_object('reason', case when hol is not null then 'holiday' when extract(isodow from t) > 5 then 'weekend' else 'hours' end,
                                     'holiday', hol, 'next', public.next_open_at(t, 5, 8));
  end if;
  if not s then res := res || jsonb_build_object('sales_next', public.next_open_at(t, 6, 9)); end if;
  return res;
end $$;
grant execute on function public.work_status() to anon, authenticated;
