-- Схема state'а padel-bot в Supabase Postgres (project id kbwmrqoxjlydmwyxirqm).
--
-- Как применить: Supabase Dashboard -> SQL Editor -> New query -> вставить целиком -> Run.
-- Скрипт идемпотентен: повторный запуск ничего не ломает и не трогает данные.
--
-- Тот же DDL лежит миграцией supabase/migrations/20260730123000_bookings.sql
-- (для `supabase db push`). Этот файл — источник правды и путь без CLI; держать
-- их в синхроне, иначе схема разъедется с адаптером.
--
-- Читает/пишет только адаптер src/core/state-supabase.ts (PostgREST через fetch,
-- ключ SUPABASE_SERVICE_ROLE_KEY). Пока таблицы нет, адаптер кидает ошибку со
-- ссылкой на этот файл.

create table if not exists public.bookings (
  -- Все колонки text специально: state хранит СТРОКИ ровно как их видит бот.
  -- Типы date/time/timestamptz Postgres нормализовал бы ('20:00' -> '20:00:00',
  -- '2026-07-30T19:58:51+04:00' -> UTC), и roundtrip перестал бы совпадать с
  -- SQLite/Memory. Таймзона клуба (+04:00) уже зашита в сами строки — см. CLAUDE.md.
  profile_id text not null,                 -- id профиля бота (ilya, nina, ...)
  "date"     text not null,                 -- YYYY-MM-DD, дата слота в Asia/Tbilisi
  "time"     text not null,                 -- HH:MM, начало слота в Asia/Tbilisi
  court      text not null,                 -- 'Padel Court 3' и т.п.
  booking_id text not null,                 -- id брони из Reservio (внешняя валидация успеха)
  token      text not null,                 -- guest-token: без него бронь не прочитать и не отменить
  state      text not null,                 -- confirmed / canceled (одна L, как в Reservio)
  created_at text not null                  -- ISO с явным оффсетом, например 2026-07-30T19:58:51+04:00
);

-- Один слот профиля = максимум одна бронь. В этот индекс целится upsert адаптера
-- (POST ?on_conflict=profile_id,date,time + Prefer: resolution=merge-duplicates):
-- без него PostgREST ответит 42P10 и запись брони не подтвердится.
create unique index if not exists bookings_profile_date_time
  on public.bookings (profile_id, "date", "time");

-- markCanceled ищет бронь по booking_id — отдельный индекс, как в SQLite-схеме.
create index if not exists bookings_booking_id_idx on public.bookings (booking_id);

-- --- Доступ ---------------------------------------------------------------
-- К таблице ходит ТОЛЬКО service-ключ (роль service_role). anon-ключ публичен и
-- лежит во фронтендах, поэтому доступ ему закрыт двумя независимыми способами.
--
-- 1) RLS без единой политики: anon/authenticated не видят ни одной строки.
--    service_role это не трогает — у него bypassrls. Команда идемпотентна:
--    на уже включённом RLS она ничего не меняет, поэтому выполняем её всегда
--    (иначе на новом проекте таблица с guest-token'ами осталась бы открытой,
--    и Security Advisor честно ругался бы на rls_disabled_in_public).
alter table public.bookings enable row level security;
--
-- 2) Гранты. Supabase по умолчанию выдаёт anon/authenticated права на новые
--    таблицы в схеме public. Отзываем — тогда anon получает "permission denied"
--    ещё до всякого RLS. Строка ниже безопасна и при уже включённом RLS.
revoke all on table public.bookings from anon, authenticated;

-- PostgREST кэширует схему; в Supabase кэш обновляется сам, но если сразу после
-- Run адаптер жалуется на PGRST205 "Could not find the table" — выполнить это:
notify pgrst, 'reload schema';
