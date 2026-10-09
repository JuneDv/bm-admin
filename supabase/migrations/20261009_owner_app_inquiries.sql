-- 건축주 앱 '앱 사용 문의': 운영자 제보함(feedback)에 '질문'으로 접수 → 운영자 답글은 건축주에게 푸시
-- 읽기는 기존 정책(본인 것 / 운영자)으로 충분. 건축주는 새 질문 등록만 (상태·답글은 운영자만)
create policy "owner app inquiry insert" on public.feedback for insert
  with check (
    user_id = auth.uid() and public.is_owner_user()
    and kind = 'question' and coalesce(status, 'open') = 'open'
    and reply is null and pushed_at is null and coalesce(paths, '{}') = '{}'
  );
