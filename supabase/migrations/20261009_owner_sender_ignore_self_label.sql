-- 관계 '본인'은 저장만 하고(=관계를 이미 물어봄) 대화창 이름에는 붙이지 않음
create or replace function public.owner_message_sender() returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nm text; lb text;
begin
  select name into nm from public.owner_users where user_id = new.user_id;
  if not found then return new; end if;
  select label into lb from public.owner_session_prefs
   where session_id = nullif(auth.jwt()->>'session_id', '')::uuid and user_id = new.user_id;
  new.sender_name := coalesce(nullif(trim(nm), ''), '건축주') || coalesce(' (' || nullif(nullif(trim(lb), ''), '본인') || ')', '');
  new.sender_role := '건축주';
  return new;
end $$;
revoke execute on function public.owner_message_sender() from public, anon, authenticated;
