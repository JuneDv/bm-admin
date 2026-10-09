-- 공간 Talk 메시지의 보낸 사람 이름·역할을 서버가 정함 (건축주는 이미 그랬고, 직원도 추가)
--  건축주: owner_users 이름 + 이 기기의 관계 호칭
--  직원: admin_users 의 staff_name → google_name → email. 역할은 그 현장의 담당(영업/설계/인테리어) 또는 계정 역할 중 하나만 허용
--  → 클라이언트가 다른 사람 이름이나 '건축주'로 위장해 글을 쓸 수 없음
create or replace function public.owner_message_sender()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare nm text; lb text; au record; s record; allowed text[];
begin
  select name into nm from public.owner_users where user_id = new.user_id;
  if found then
    select label into lb from public.owner_session_prefs
     where session_id = nullif(auth.jwt()->>'session_id', '')::uuid and user_id = new.user_id;
    new.sender_name := coalesce(nullif(trim(nm), ''), '건축주') || coalesce(' (' || nullif(nullif(trim(lb), ''), '본인') || ')', '');
    new.sender_role := '건축주';
    return new;
  end if;
  select staff_name, google_name, email, role::text as role into au from public.admin_users where id = new.user_id;
  if found then
    new.sender_name := coalesce(nullif(trim(au.staff_name), ''), nullif(trim(au.google_name), ''), au.email, '직원');
    select manager, designer, interior into s from public.sites where bm_key = new.bm_key;
    allowed := array_remove(array[
      case when au.staff_name is not null and trim(coalesce(s.manager, ''))  = trim(au.staff_name) then '영업' end,
      case when au.staff_name is not null and trim(coalesce(s.designer, '')) = trim(au.staff_name) then '설계' end,
      case when au.staff_name is not null and trim(coalesce(s.interior, '')) = trim(au.staff_name) then '인테리어' end,
      case au.role when 'manager' then '담당자' when 'gongmu' then '공무' when 'pm' then 'PM' when 'admin' then '관리자'
                   when 'master' then '마스터(구)' when 'owner' then '운영자' end
    ], null);
    if new.sender_role is null or not (new.sender_role = any(allowed)) then
      new.sender_role := coalesce(allowed[1], '직원');
    end if;
  end if;
  return new;
end $$;
