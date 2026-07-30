-- Брони: общий state для trigger.dev-джоб и Telegram-бота.
-- Доступ ТОЛЬКО service-ключом (обходит RLS). RLS включён без политик:
-- anon/authenticated через Data API не видят ничего.
--
-- Источник правды по схеме — docs/supabase-schema.sql (тот же DDL + пояснения,
-- применяется вручную через SQL Editor). Менять схему — в обоих файлах сразу.
create table if not exists public.bookings (
  profile_id text not null,
  date       text not null, -- YYYY-MM-DD (день слота, Asia/Tbilisi)
  time       text not null, -- HH:MM начала слота
  court      text not null,
  booking_id text not null,
  token      text not null, -- guest-ключ Reservio: единственный способ отменить бронь
  state      text not null, -- confirmed | canceled
  created_at text not null  -- ISO с +04:00
);

create unique index if not exists bookings_profile_date_time
  on public.bookings (profile_id, date, time);

-- markCanceled ищет бронь по booking_id.
create index if not exists bookings_booking_id_idx on public.bookings (booking_id);

alter table public.bookings enable row level security;

-- Второй, независимый от RLS барьер: Supabase по умолчанию даёт anon/authenticated
-- права на новые таблицы схемы public, а здесь лежат guest-token'ы.
revoke all on table public.bookings from anon, authenticated;
