-- 건축주 앱: 한 계정을 가족이 같이 쓸 때 '내가 보낸 메시지'를 기기 단위로 구분 (앱이 기기마다 만든 임의 ID, 표시용)
alter table public.site_messages add column if not exists sender_device text check (sender_device is null or char_length(sender_device) <= 64);
