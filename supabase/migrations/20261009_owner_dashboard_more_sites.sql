-- 건축주 앱: 같은 번호로 등록됐지만 아직 계정에 연결하지 않은 현장 수(more) — '계약번호로 현장 추가' 안내용 (현장 정보는 주지 않음)
create or replace function public.owner_dashboard()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select case when public.is_owner_user()
    then public.site_bundle(array(select os.bm_key from public.owner_sites os where os.user_id = auth.uid()))
         || jsonb_build_object('more', (
              select count(*) from public.sites s, public.owner_users ou
              where ou.user_id = auth.uid() and ou.phone = any(s.phones) and s.archived_at is null
                and not exists (select 1 from public.owner_sites os where os.user_id = auth.uid() and os.bm_key = s.bm_key)))
    else null end
$$;
