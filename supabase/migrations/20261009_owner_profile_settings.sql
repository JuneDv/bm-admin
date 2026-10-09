-- 건축주 프로필: 기기별 알림 설정 · 호칭 · 접속 기기 · 조용한 시간 요약 (Supabase에 적용됨: owner_profile_settings, owner_session_prefs_device)

-- 1) 기기별 알림 설정 (건축주만 사용, 직원 행은 기본값 그대로)
--    owner_mode: instant(바로) / digest(하루 한 번 아침 8시) / calls(담당자가 나를 호출했을 때만)
--    quiet: 조용한 시간 'H-H'(한국시간, 예 21-8) · 'off' · null=기본(21-8). 그 사이 알림은 끝나는 시각에 모아서
--    last_push_at: 이 기기에 마지막으로 보낸 시각 (요약 집계 기준)
alter table public.push_subscriptions add column if not exists owner_mode text not null default 'instant';
alter table public.push_subscriptions add column if not exists quiet text;
alter table public.push_subscriptions add column if not exists last_push_at timestamptz;
alter table public.push_subscriptions add constraint push_subscriptions_owner_mode_chk check (owner_mode in ('instant', 'digest', 'calls'));
alter table public.push_subscriptions add constraint push_subscriptions_quiet_chk
  check (quiet is null or quiet = 'off' or quiet ~ '^([01]?[0-9]|2[0-3])-([01]?[0-9]|2[0-3])$');

-- 2) 기기(로그인 세션)별 호칭·기기 이름: 한 계정을 가족이 같이 쓸 때 대화창에 '박준우 (배우자)'처럼
--    세션은 서버(owner-login)에서 만들어져 auth.sessions.user_agent 가 서버 값 → 기기 이름은 앱이 기록
create table if not exists public.owner_session_prefs (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text check (label is null or char_length(label) between 1 and 10),
  device text check (device is null or char_length(device) <= 60),
  updated_at timestamptz not null default now()
);
alter table public.owner_session_prefs enable row level security;
create policy "owner own session prefs" on public.owner_session_prefs for all
  using (user_id = auth.uid() and public.is_owner_user())
  with check (user_id = auth.uid() and public.is_owner_user() and session_id = nullif(auth.jwt()->>'session_id', '')::uuid);

-- 3) 건축주 메시지의 보낸 사람은 서버가 정함 (이름 + 이 기기 호칭, 역할 '건축주') — 앱에서 보낸 값은 무시
create or replace function public.owner_message_sender() returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nm text; lb text;
begin
  select name into nm from public.owner_users where user_id = new.user_id;
  if not found then return new; end if;
  select label into lb from public.owner_session_prefs
   where session_id = nullif(auth.jwt()->>'session_id', '')::uuid and user_id = new.user_id;
  new.sender_name := coalesce(nullif(trim(nm), ''), '건축주') || coalesce(' (' || nullif(trim(lb), '') || ')', '');
  new.sender_role := '건축주';
  return new;
end $$;
create trigger site_messages_owner_sender before insert on public.site_messages
  for each row execute function public.owner_message_sender();

-- 4) 접속 기기 목록 (이 계정의 로그인 세션, 최근 60일)
create or replace function public.owner_devices()
returns table(session_id uuid, created_at timestamptz, last_active timestamptz, user_agent text, label text, is_current boolean)
language sql stable security definer set search_path to 'public'
as $$
  select s.id, s.created_at, coalesce(s.refreshed_at at time zone 'UTC', s.updated_at), p.device, p.label,
         s.id = nullif(auth.jwt()->>'session_id', '')::uuid
  from auth.sessions s
  left join public.owner_session_prefs p on p.session_id = s.id
  where s.user_id = auth.uid() and public.is_owner_user()
    and (s.not_after is null or s.not_after > now())
    and coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) > now() - interval '60 days'
  order by 6 desc, 3 desc nulls last
$$;
revoke execute on function public.owner_devices() from public, anon;
grant execute on function public.owner_devices() to authenticated;

-- 5) 건축주 요약 대상 (send-push 가 매시 호출): 이번 시각(한국시간 p_hour)에 요약을 받을 기기와 그동안 쌓인 메시지 수
--    digest 모드 → 8시 / instant·calls 모드 → 조용한 시간이 끝나는 시각. calls 모드는 호출만 셈
create or replace function public.owner_digest_due(p_hour int)
returns table(sub_id bigint, user_id uuid, endpoint text, p256dh text, auth text, n bigint, calls bigint, sites bigint, one_site text)
language sql stable security definer set search_path to 'public'
as $$
  with subs as (
    select ps.*, coalesce(ps.quiet, '21-8') as q
    from public.push_subscriptions ps join public.owner_users ou on ou.user_id = ps.user_id
  ), due as (
    select * from subs
    where (owner_mode = 'digest' and p_hour = 8)
       or (owner_mode in ('instant', 'calls') and q <> 'off' and split_part(q, '-', 1) <> split_part(q, '-', 2)
           and split_part(q, '-', 2)::int = p_hour)
  )
  select d.id, d.user_id, d.endpoint, d.p256dh, d.auth,
         count(distinct m.id), count(distinct m.id) filter (where m.call_owner), count(distinct m.bm_key), min(m.bm_key)
  from due d
  join public.owner_sites os on os.user_id = d.user_id
  join public.owner_talk_sites t on t.bm_key = os.bm_key
  join public.site_messages m on m.bm_key = os.bm_key and m.channel = 'owner'
   and m.created_at > greatest(coalesce(d.last_push_at, d.created_at), now() - interval '3 days')
   and m.user_id is distinct from d.user_id and m.sender_role is distinct from '건축주'
   and (d.owner_mode <> 'calls' or m.call_owner)
  group by d.id, d.user_id, d.endpoint, d.p256dh, d.auth
  having count(distinct m.id) > 0
$$;
revoke execute on function public.owner_digest_due(int) from public, anon, authenticated;

-- 6) 매시 2분: 건축주 요약 (조용한 시간이 끝난 기기)
-- select cron.schedule('owner-push-digest', '2 * * * *', $c$ select net.http_post(
--   url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push', body := '{"owner_digest":true}'::jsonb,
--   headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 8000) $c$);
