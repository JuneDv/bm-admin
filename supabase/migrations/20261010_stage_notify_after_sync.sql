-- 공사 단계 알림: 매시 확인 대신 Jira 동기화(4시간마다)가 끝날 때 한 번 — 데이터가 바뀌는 시점이 그때뿐이라
-- n8n 동기화 마지막 단계가 sync_runs 에 기록을 남기면 이 트리거가 send-push {stage_notify} 를 부름
select cron.unschedule('stage-notify') where exists (select 1 from cron.job where jobname = 'stage-notify');

create or replace function public.notify_stage_after_sync()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  perform net.http_post(
    url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
    body := '{"stage_notify":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
    timeout_milliseconds := 20000);
  return new;
end $$;
revoke execute on function public.notify_stage_after_sync() from public, anon, authenticated;

create or replace trigger sync_runs_stage_notify after insert on public.sync_runs
for each row execute function public.notify_stage_after_sync();
