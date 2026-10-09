-- Jira BM '프리패브 공법'(customfield_10144): 모듈러 / 패널라이징 등 — n8n 동기화가 채움
alter table public.sites add column if not exists prefab_method text;
comment on column public.sites.prefab_method is 'Jira 프리패브 공법 (customfield_10144): 모듈러/패널라이징';
