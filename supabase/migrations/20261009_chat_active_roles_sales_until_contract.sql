-- 공간 Talk 일반 메시지 알림 대상(역할): 영업은 계약 단계까지만 (설계 단계부터 빠짐)
--  계약 단계 판정은 단계 엔진(stage-engine.js earlyStage)과 같은 기준을 SQL로:
--  BM 상태가 설계·변경계약·착공·설치로 넘어갔거나, 세부공정이 하나라도 시작/완료됐거나, 공사비 85% 이상 입금이면 계약 단계를 지난 것
create or replace function public.chat_active_roles(p_bm_key text)
returns text[]
language sql stable security definer set search_path to 'public'
as $$
  with items as (
    select process, name, state from public.stage_items
    where bm_key = p_bm_key and not public.st_skipped(state)
  ),
  ad as (select name, state from items where process = 'AD'),
  shim as (select count(*) n, count(*) filter (where public.st_done(state)) d from ad where name like '%실시도면%' or name like '%실시설계%'),
  all_ad as (select count(*) n, count(*) filter (where public.st_done(state)) d from ad),
  s as (select bm_state, cost_pct from public.sites where bm_key = p_bm_key),
  past as (
    select coalesce((select bm_state ~ '설계|변경계약|착공|설치' from s), false)
        or coalesce((select cost_pct >= 85 from s), false)
        or exists (select 1 from items where public.st_done(state) or state ~* '(시공 ?중|진행 ?중|in progress|접수)') as v
  )
  select array_remove(array[
    case when not past.v then '영업' end,
    case when not (shim.n > 0 and shim.d = shim.n) then '설계' end,
    case when not (all_ad.n > 0 and all_ad.d = all_ad.n) then '인테리어' end
  ]::text[], null)
  from shim, all_ad, past
$$;
