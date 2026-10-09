-- 매일 03:15 KST (18:15 UTC) 정리 함수(housekeeping) 호출: 로그인 시도 30일·미리보기 확인값·Jira 이벤트 90일·보관 1년 현장 첨부
select cron.schedule('housekeeping', '15 18 * * *', $c$ select net.http_post(
       url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/housekeeping',
       body := '{}'::jsonb,
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
       timeout_milliseconds := 20000) $c$)
where not exists (select 1 from cron.job where jobname = 'housekeeping');
