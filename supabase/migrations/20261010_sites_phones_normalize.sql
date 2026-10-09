-- 현장 전화번호 정규화: Jira에서 두 번호가 붙어서 오거나(0109…0103…), 하이픈·공백이 섞여 와도
-- 숫자만 남기고 11자리씩 나눠 저장. 휴대폰(01x)이 아닌 번호(사무실 등)는 그대로 둠 — 표시용
-- (건축주 로그인은 sites.phones ∋ 휴대폰 번호 비교라 이게 틀리면 계약번호가 맞아도 못 들어옴)
create or replace function public.norm_phones(p text[])
returns text[] language sql immutable
as $$
  select coalesce(array_agg(x order by ord), '{}'::text[]) from (
    select x, min(ord) ord from (
      select raw.ord, parts.x from (
        select regexp_replace(coalesce(v, ''), '[^0-9]', '', 'g') d, ord from unnest(p) with ordinality u(v, ord)
      ) raw
      cross join lateral (
        select unnest(case
          when length(raw.d) > 11 and raw.d ~ '^(01\d{9})+$' then regexp_split_to_array(regexp_replace(raw.d, '(01\d{9})', '\1,', 'g'), ',')   -- 11자리 휴대폰이 이어 붙음
          when length(raw.d) > 10 and raw.d ~ '^(01\d{8})+$' then regexp_split_to_array(regexp_replace(raw.d, '(01\d{8})', '\1,', 'g'), ',')   -- 10자리(011 등)가 이어 붙음
          else array[raw.d] end) as x
      ) parts
      where parts.x <> ''
    ) s
    group by x
  ) t
$$;

create or replace function public.sites_norm_phones()
returns trigger language plpgsql
as $$
begin
  new.phones := public.norm_phones(new.phones);
  return new;
end $$;

create or replace trigger sites_norm_phones before insert or update of phones on public.sites
for each row execute function public.sites_norm_phones();

-- 기존 행 정리
update public.sites set phones = phones where exists (select 1 from unnest(phones) p where p !~ '^01\d{8,9}$');
