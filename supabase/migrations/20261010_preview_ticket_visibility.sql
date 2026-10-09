-- '건축주 화면 보기' 미리보기: 호출한 직원이 관리자 앱에서 볼 수 있는 현장만 (sites RLS 'admin read sites'와 같은 기준)
-- 전에는 승인 여부만 봐서 담당자(manager)가 다른 현장의 공사비·연락처를 미리보기로 볼 수 있었음
create or replace function public.create_preview_ticket(p_bm_key text)
returns text language plpgsql volatile security definer set search_path to 'public'
as $$
declare t text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.is_approved() then raise exception 'not allowed'; end if;
  if not exists (
    select 1 from public.sites s
    where s.bm_key = p_bm_key and s.archived_at is null
      and (public.is_full_access()
           or (public.my_admin_role() = 'manager' and public.my_staff_name() is not null
               and public.my_staff_name() in (trim(coalesce(s.manager, '')), trim(coalesce(s.designer, '')), trim(coalesce(s.interior, '')))))
  ) then raise exception 'not allowed'; end if;
  insert into public.preview_tickets (token, bm_key, created_by) values (t, p_bm_key, auth.uid());
  return t;
end $$;
