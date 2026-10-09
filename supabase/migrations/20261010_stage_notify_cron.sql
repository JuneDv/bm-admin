-- 매시 7분: 건축주 현장의 공사 단계를 다시 계산해 바뀐 현장 건축주에게 알림 (send-push stage_notify)
select cron.schedule('stage-notify', '7 * * * *', $c$ select net.http_post(
       url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
       body := '{"stage_notify":true}'::jsonb,
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
       timeout_milliseconds := 20000) $c$)
where not exists (select 1 from cron.job where jobname = 'stage-notify');
