-- 내부 호출 비밀값 (Vault): DB 트리거·cron → send-push, owner-callback 함수 → n8n 웹훅
-- 함수들은 공개 주소라 "누가 불렀는지"를 이 값으로 확인함. 서비스 역할만 읽을 수 있음
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'push_internal_key', 'send-push 내부 호출 확인용 (DB 트리거·cron)')
where not exists (select 1 from vault.secrets where name = 'push_internal_key');
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'callback_webhook_key', 'n8n 전화 요청 웹훅 확인용 (owner-callback 함수)')
where not exists (select 1 from vault.secrets where name = 'callback_webhook_key');

create or replace function public.internal_secret(p_name text)
returns text language sql stable security definer set search_path to ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1 $$;
revoke execute on function public.internal_secret(text) from public, anon, authenticated;
grant execute on function public.internal_secret(text) to service_role;

-- 트리거: 비밀 헤더를 붙여 호출
create or replace function public.notify_push_on_message()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  perform net.http_post(
    url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('message_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
    timeout_milliseconds := 8000);
  return new;
end $$;

create or replace function public.notify_push_on_feedback()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    perform net.http_post(
      url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
      body := jsonb_build_object('feedback_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
      timeout_milliseconds := 8000);
  elsif (old.status is distinct from new.status) or (old.reply is distinct from new.reply) then
    new.updated_at := now();
    perform net.http_post(
      url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
      body := jsonb_build_object('feedback_id', new.id, 'event', 'reply'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
      timeout_milliseconds := 8000);
  end if;
  return new;
end $$;

-- cron 2건도 같은 헤더로
select cron.alter_job(jobid, command := $c$ select net.http_post(
       url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
       body := '{"digest":true}'::jsonb,
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
       timeout_milliseconds := 8000) $c$)
from cron.job where jobname = 'push-digest';
select cron.alter_job(jobid, command := $c$ select net.http_post(
       url := 'https://ljxonejavjagwqrorfui.supabase.co/functions/v1/send-push',
       body := '{"owner_digest":true}'::jsonb,
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-key', public.internal_secret('push_internal_key')),
       timeout_milliseconds := 8000) $c$)
from cron.job where jobname = 'owner-push-digest';
