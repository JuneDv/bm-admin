-- 읽음 표의 현장 FK 인덱스 (unread_counts 조인용)
create index if not exists message_reads_bm_key_idx on public.message_reads (bm_key);
