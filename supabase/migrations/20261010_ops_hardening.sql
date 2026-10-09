-- 운영 보강: 인덱스, RLS 정책 성능(auth.uid()를 (select …)로), 건축주 정보 열람 범위, anon 실행 권한 정리, 길이 제약, 푸시 실패 리셋

-- 1) 자주 조인·조회하는 열 인덱스
create index if not exists owner_sites_bm_key_idx on public.owner_sites (bm_key);
create index if not exists site_messages_user_idx on public.site_messages (user_id);
create index if not exists site_messages_deferred_idx on public.site_messages (push_result) where pushed_at is null;
create index if not exists message_files_bm_key_idx on public.message_files (bm_key);
create index if not exists feedback_user_idx on public.feedback (user_id);
create index if not exists feedback_open_idx on public.feedback (created_at) where status = 'open';
create index if not exists owner_session_prefs_user_idx on public.owner_session_prefs (user_id);
create index if not exists preview_tickets_expires_idx on public.preview_tickets (expires_at);
create index if not exists owner_login_attempts_fail_idx on public.owner_login_attempts (phone, at) where not ok;

-- 2) 정책의 auth.uid()/auth.jwt()를 (select …)로 — 행마다 다시 평가하지 않게 (advisor auth_rls_initplan)
alter policy "self read" on public.admin_users using (id = (select auth.uid()));
alter policy "feedback insert own" on public.feedback with check (user_id = (select auth.uid()) and public.is_approved());
alter policy "feedback read own or owner" on public.feedback using (user_id = (select auth.uid()) or public.my_admin_role() = 'owner');
alter policy "owner app inquiry insert" on public.feedback with check (user_id = (select auth.uid()) and public.is_owner_user() and kind = 'question'
  and coalesce(status, 'open') = 'open' and reply is null and pushed_at is null and coalesce(paths, '{}'::text[]) = '{}'::text[]);
alter policy "own reads select" on public.message_reads using (user_id = (select auth.uid()));
alter policy "own reads insert" on public.message_reads with check (user_id = (select auth.uid()));
alter policy "own reads update" on public.message_reads using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "insert files to own message" on public.message_files with check (public.is_approved() and exists (select 1 from public.site_messages m where m.id = message_files.message_id and m.user_id = (select auth.uid())));
alter policy "owner inserts files to own talk message" on public.message_files with check (exists (select 1 from public.site_messages m where m.id = message_files.message_id and m.user_id = (select auth.uid()) and m.channel = 'owner'));
alter policy "own prefs" on public.notification_prefs using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "own subscriptions" on public.push_subscriptions using (user_id = (select auth.uid()) and public.is_approved()) with check (user_id = (select auth.uid()) and public.is_approved());
alter policy "owner own push subscriptions" on public.push_subscriptions using (user_id = (select auth.uid()) and public.is_owner_user()) with check (user_id = (select auth.uid()) and public.is_owner_user());
alter policy "owner own session prefs" on public.owner_session_prefs using (user_id = (select auth.uid()) and public.is_owner_user())
  with check (user_id = (select auth.uid()) and public.is_owner_user() and session_id = (nullif((select auth.jwt()) ->> 'session_id', ''))::uuid);
alter policy "delete own recent message" on public.site_messages using (user_id = (select auth.uid()) and created_at > now() - interval '5 minutes');
alter policy "owner writes own talk" on public.site_messages with check (channel = 'owner' and user_id = (select auth.uid()) and not call_owner and public.owner_has_site(bm_key, true));
alter policy "write messages to visible sites" on public.site_messages with check (public.is_approved() and user_id = (select auth.uid())
  and exists (select 1 from public.sites s where s.bm_key = site_messages.bm_key and s.archived_at is null)
  and (channel = 'staff' or exists (select 1 from public.owner_talk_sites o where o.bm_key = site_messages.bm_key)));

-- 3) 건축주 정보: 직원은 자기가 볼 수 있는 현장(sites RLS)에 연결된 건축주만 (전에는 승인 직원 전원이 모든 건축주 번호를 볼 수 있었음)
alter policy "owner reads self or staff reads" on public.owner_users
  using (user_id = (select auth.uid()) or (public.is_approved() and exists (
    select 1 from public.owner_sites os join public.sites s on s.bm_key = os.bm_key where os.user_id = owner_users.user_id)));
alter policy "owner reads own links or staff reads" on public.owner_sites
  using (user_id = (select auth.uid()) or (public.is_approved() and exists (select 1 from public.sites s where s.bm_key = owner_sites.bm_key)));

-- 4) 로그인 없이(anon) 부를 이유가 없는 security definer 함수는 anon 실행 권한 제거
--    (정책 안에서 쓰이는 is_*/my_*/owner_has_site/owner_can_read_file 은 anon 조회 시 오류가 나지 않도록 그대로 둠)
revoke execute on function public.chat_active_roles(text) from anon;
revoke execute on function public.push_status() from anon;
revoke execute on function public.role_accounts() from anon;
revoke execute on function public.next_open_at(timestamp, integer, integer) from anon;
revoke execute on function public.is_work_time(timestamptz) from anon;
revoke execute on function public.handle_new_auth_user() from anon, authenticated;
revoke execute on function public.notify_push_on_message() from anon, authenticated;
revoke execute on function public.notify_push_on_feedback() from anon, authenticated;
revoke execute on function public.sites_norm_phones() from anon, authenticated;

-- 5) 제보·문의 부가 열 길이 제약 (본문은 이미 4000자 제한)
alter table public.feedback add constraint feedback_page_len check (page is null or length(page) <= 200) not valid;
alter table public.feedback add constraint feedback_ua_len check (ua is null or length(ua) <= 400) not valid;
alter table public.feedback add constraint feedback_platform_len check (platform is null or length(platform) <= 20) not valid;
alter table public.feedback validate constraint feedback_page_len;
alter table public.feedback validate constraint feedback_ua_len;
alter table public.feedback validate constraint feedback_platform_len;

-- 6) 푸시 전송 성공 시 실패 횟수 리셋 (일시 장애 뒤 멀쩡한 기기가 8회 누적으로 빠지지 않게)
create or replace function public.push_ok(p_ids bigint[])
returns void language sql security definer set search_path to 'public'
as $$ update public.push_subscriptions set fail_count = 0 where id = any(p_ids) and fail_count > 0 $$;
revoke execute on function public.push_ok(bigint[]) from public, anon, authenticated;
