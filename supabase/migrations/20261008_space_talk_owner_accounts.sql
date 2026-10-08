-- 공간 Talk 건축주 대화 (시범) — 2026-10-08 Supabase에 적용한 변경 기록
-- 적용: apply_migration space_talk_owner_accounts, owner_accounts_skip_staff_list
-- 요약
--  * sites.contract_no: Jira 계약번호(customfield_10076), n8n 동기화가 채움 ('0'·빈값은 null)
--  * site_messages.channel ('staff' 내부 / 'owner' 건축주와 함께), call_owner(건축주 호출 표시) — 기존 메시지는 모두 staff
--  * owner_talk_sites: 공간 Talk를 연 현장 목록(시범: BM-6077). 목록은 누구나 읽음, 운영자만 수정
--  * owner_users / owner_sites: 건축주 계정(전화번호)과 현장 연결 — 서버 함수 owner-login만 만듦
--  * owner_login_attempts: 틀린 시도 기록 (번호 1시간 5회, IP 30회 넘으면 잠시 막음)
--  * owner_has_site(), owner_can_read_file(): 건축주 RLS 판단용 (security definer)
--  * handle_new_auth_user(): 건축주 계정(app_metadata.kind='owner' 또는 …@owner.invalid)은 직원 승인 대기 목록에 넣지 않음
--  * RLS: 직원은 공간 Talk를 연 현장에서만 건축주 채널에 씀 / 건축주는 자기 현장 건축주 채널 메시지·첨부만 읽고 씀
-- 공간 Talk를 다른 현장에도 열 때:  insert into public.owner_talk_sites (bm_key, note) values ('BM-xxxx', '메모');

alter table public.sites add column if not exists contract_no text;
alter table public.site_messages add column channel text not null default 'staff';
alter table public.site_messages add constraint site_messages_channel_check check (channel in ('staff', 'owner'));
alter table public.site_messages add column call_owner boolean not null default false;
alter table public.site_messages add constraint site_messages_call_owner_check check (not call_owner or channel = 'owner');
create index if not exists site_messages_bm_channel_idx on public.site_messages (bm_key, channel, created_at);

create table public.owner_talk_sites (bm_key text primary key references public.sites(bm_key) on delete cascade, opened_at timestamptz not null default now(), note text);
alter table public.owner_talk_sites enable row level security;
create policy "anyone reads owner talk sites" on public.owner_talk_sites for select to anon, authenticated using (true);
create policy "owner manages owner talk sites" on public.owner_talk_sites for all to authenticated using (public.my_admin_role() = 'owner') with check (public.my_admin_role() = 'owner');
insert into public.owner_talk_sites (bm_key, note) values ('BM-6077', '시범 운영 (블로어테스트)');

create table public.owner_users (user_id uuid primary key references auth.users(id) on delete cascade, phone text not null unique, name text, created_at timestamptz not null default now(), last_login_at timestamptz);
create table public.owner_sites (user_id uuid not null references public.owner_users(user_id) on delete cascade, bm_key text not null references public.sites(bm_key) on delete cascade, linked_at timestamptz not null default now(), primary key (user_id, bm_key));
create table public.owner_login_attempts (id bigserial primary key, phone text, ip text, ok boolean not null, at timestamptz not null default now());
create index owner_login_attempts_phone_at on public.owner_login_attempts (phone, at);
create index owner_login_attempts_ip_at on public.owner_login_attempts (ip, at);
alter table public.owner_users enable row level security;
alter table public.owner_sites enable row level security;
alter table public.owner_login_attempts enable row level security;
create policy "owner reads self or staff reads" on public.owner_users for select using (user_id = auth.uid() or public.is_approved());
create policy "owner reads own links or staff reads" on public.owner_sites for select using (user_id = auth.uid() or public.is_approved());

create or replace function public.owner_has_site(p_bm_key text, p_write boolean default false)
 returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.owner_sites os join public.owner_talk_sites t on t.bm_key = os.bm_key join public.sites s on s.bm_key = os.bm_key
  where os.user_id = auth.uid() and os.bm_key = p_bm_key and (not p_write or s.archived_at is null)) $$;
create or replace function public.owner_can_read_file(p_path text)
 returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.message_files f join public.site_messages m on m.id = f.message_id
  where f.path = p_path and m.channel = 'owner' and public.owner_has_site(m.bm_key)) $$;

create or replace function public.handle_new_auth_user()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if coalesce(new.raw_app_meta_data->>'kind', '') = 'owner' or lower(coalesce(new.email, '')) like '%@owner.invalid' then
    return new;
  end if;
  insert into public.admin_users (id, email, google_name, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    case when lower(coalesce(new.email,'')) = 'tareura@gmail.com' then 'owner'::public.admin_role else 'pending'::public.admin_role end)
  on conflict (id) do nothing;
  return new;
end
$function$;

alter policy "write messages to visible sites" on public.site_messages with check (
  public.is_approved() and user_id = auth.uid()
  and exists (select 1 from public.sites s where s.bm_key = site_messages.bm_key and s.archived_at is null)
  and (channel = 'staff' or exists (select 1 from public.owner_talk_sites o where o.bm_key = site_messages.bm_key)));
create policy "owner reads own talk" on public.site_messages for select using (channel = 'owner' and public.owner_has_site(bm_key));
create policy "owner writes own talk" on public.site_messages for insert
  with check (channel = 'owner' and user_id = auth.uid() and target_role is null and not call_owner and public.owner_has_site(bm_key, true));
create policy "owner reads talk files" on public.message_files for select
  using (public.owner_has_site(bm_key) and exists (select 1 from public.site_messages m where m.id = message_files.message_id and m.channel = 'owner'));
create policy "owner inserts files to own talk message" on public.message_files for insert
  with check (exists (select 1 from public.site_messages m where m.id = message_files.message_id and m.user_id = auth.uid() and m.channel = 'owner'));
create policy "chat files owner read" on storage.objects for select using (bucket_id = 'chat-files' and public.owner_can_read_file(name));
create policy "chat files owner upload" on storage.objects for insert with check (bucket_id = 'chat-files' and public.owner_has_site(split_part(name, '/', 1), true));
