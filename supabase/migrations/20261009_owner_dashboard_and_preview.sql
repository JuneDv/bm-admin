-- 건축주 앱 조회를 '번호만'에서 '로그인(전화번호+계약번호)'으로: 본인에게 연결된 현장만 돌려줌
-- 1) 현장 묶음(현장 정보 + 세부공정 + 담당자 번호) — 내부용, 직접 호출 불가
create or replace function public.site_bundle(p_keys text[])
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object(
    'sites', coalesce((select jsonb_agg((to_jsonb(s) - 'contract_no') order by s.bm_key) from public.sites s where s.bm_key = any(p_keys) and s.archived_at is null), '[]'::jsonb),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('bm_key', i.bm_key, 'process', i.process, 'stage_key', i.stage_key, 'name', i.name, 'state', i.state, 'seq', i.seq) order by i.bm_key, i.seq)
                        from public.stage_items i where i.bm_key = any(p_keys)), '[]'::jsonb),
    -- 영업·인테리어 담당자 번호만 (건축주 앱의 전화 연결용)
    'staff', coalesce((select jsonb_object_agg(st.name, st.phone) from public.staff st
                       where st.name in (select trim(x) from public.sites s, unnest(array[s.manager, s.interior]) x where s.bm_key = any(p_keys) and x is not null)), '{}'::jsonb)
  )
$$;
revoke execute on function public.site_bundle(text[]) from public, anon, authenticated;

-- 2) 로그인한 건축주: 본인 현장만
create or replace function public.owner_dashboard()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select case when public.is_owner_user()
    then public.site_bundle(array(select os.bm_key from public.owner_sites os where os.user_id = auth.uid()))
    else null end
$$;
revoke execute on function public.owner_dashboard() from public, anon;
grant execute on function public.owner_dashboard() to authenticated;

-- 3) 관리자 앱 '건축주 화면 보기': 직원이 10분짜리 확인값을 만들어 건축주 앱을 미리보기로 엶 (직원 로그인 정보는 넘기지 않음)
create table if not exists public.preview_tickets (
  token text primary key,
  bm_key text not null,
  created_by uuid not null,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
alter table public.preview_tickets enable row level security;   -- 정책 없음: 아래 함수로만 다룸

create or replace function public.create_preview_ticket(p_bm_key text)
returns text language plpgsql volatile security definer set search_path to 'public'
as $$
declare t text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.is_approved() then raise exception 'not allowed'; end if;
  insert into public.preview_tickets (token, bm_key, created_by) values (t, p_bm_key, auth.uid());
  return t;
end $$;
revoke execute on function public.create_preview_ticket(text) from public, anon;
grant execute on function public.create_preview_ticket(text) to authenticated;

create or replace function public.preview_bundle(p_token text)
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select public.site_bundle(array[t.bm_key]) from public.preview_tickets t where t.token = p_token and t.expires_at > now()
$$;
revoke execute on function public.preview_bundle(text) from public;
grant execute on function public.preview_bundle(text) to anon, authenticated;
