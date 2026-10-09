-- 건축주 앱 '내 정보' 연결된 기기 개별 해제
--  · 알림 등록에 기기 세션 번호를 남겨, 기기를 해제하면 그 기기로 가는 알림도 같이 정리
--  · expire_owner_session: 세션을 즉시 만료(행은 남김) + 갱신 토큰 회수 → 그 기기는 다음 토큰 갱신 때 로그아웃
--    (owner-account 함수에서 service_role로만 호출)
alter table public.push_subscriptions add column if not exists session_id uuid;
create index if not exists push_subscriptions_session_idx on public.push_subscriptions (session_id) where session_id is not null;

create or replace function public.expire_owner_session(p_user uuid, p_session uuid)
returns boolean language plpgsql security definer set search_path to ''
as $$ declare n int; begin
  update auth.sessions set not_after = now() where id = p_session and user_id = p_user and (not_after is null or not_after > now());
  get diagnostics n = row_count;
  update auth.refresh_tokens set revoked = true where session_id = p_session and not revoked;
  return n > 0; end $$;
revoke execute on function public.expire_owner_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.expire_owner_session(uuid, uuid) to service_role;
