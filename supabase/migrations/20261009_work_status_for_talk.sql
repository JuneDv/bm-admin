-- 공간 Talk 화면용: 지금 근무시간인지, 아니면 왜(주말·공휴일·시간 외) 그리고 다음 근무 시작 시각
create or replace function public.work_status() returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  t timestamp := now() at time zone 'Asia/Seoul';
  d date := t::date;
  hol text;
  reason text;
  nxt timestamptz;
begin
  if public.is_work_time() then return jsonb_build_object('work', true); end if;
  select name into hol from public.holidays where day = d;
  reason := case when hol is not null then 'holiday' when extract(isodow from t) > 5 then 'weekend' else 'hours' end;
  -- 오늘 8시 전이고 근무일이면 오늘 8시, 아니면 다음 근무일 8시 (최대 30일 앞까지)
  if not (extract(hour from t) < 8 and extract(isodow from t) <= 5 and hol is null) then d := d + 1; end if;
  for i in 0..30 loop
    exit when extract(isodow from d) <= 5 and not exists (select 1 from public.holidays h where h.day = d);
    d := d + 1;
  end loop;
  nxt := (d + time '08:00') at time zone 'Asia/Seoul';
  return jsonb_build_object('work', false, 'reason', reason, 'holiday', hol, 'next', nxt);
end $$;
grant execute on function public.work_status() to anon, authenticated;
