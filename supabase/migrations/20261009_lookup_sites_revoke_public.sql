-- 번호만으로 현장을 조회하던 예전 방식 닫기 (건축주 앱은 휴대폰 번호 + 계약번호 로그인 후 owner_dashboard 사용)
-- 함수는 지우지 않고 서버(service_role)만 쓸 수 있게
revoke execute on function public.lookup_sites(text) from public, anon, authenticated;
