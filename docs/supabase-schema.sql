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

-- ===========================================================================
-- Ядро Telegram-бота (фаза 3). Тот же DDL лежит миграцией
-- supabase/migrations/20260731110000_bot_core.sql — держать файлы в синхроне.
-- Читает/пишет только src/core/repos.ts (PostgREST через fetch, service-ключ).
-- ===========================================================================

-- Профиль = человек, за которого бот бронирует. Авторизация в боте — ТОЛЬКО по
-- telegram_chat_id (allowlist): чужой chat_id не находит профиль, и бот молчит.
create table if not exists public.profiles (
  id               text primary key,          -- 'ilya', 'nina', ...
  label            text not null,             -- как звать в интерфейсе бота
  name             text not null,             -- контакт guest-брони (Reservio)
  email            text not null,             -- email кабинета: к нему привяжется бронь
  phone            text not null,
  telegram_chat_id text unique,               -- null = профиль без доступа к боту
  is_admin         boolean not null default false,
  created_at       text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"')
);

-- Правило = «во столько-то, на такие-то корты, в такие-то дни». Никаких
-- «20:00 Court 3» в коде — только здесь (CLAUDE.md → Мультипрофили).
create table if not exists public.schedule_rules (
  id           uuid primary key default gen_random_uuid(),
  profile_id   text not null references public.profiles (id) on delete cascade,
  times        jsonb not null,  -- ["20:00","21:00"] — каждое время это отдельный дроп и отдельная бронь
  courts       jsonb not null,  -- ["Padel Court 3","Padel Court 2"] — порядок = приоритет
  days_of_week jsonb,           -- [1,2,3] (вс=0); null = каждый день
  enabled      boolean not null default true,
  created_at   text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"'),
  -- jsonb принимает и число, и строку, и объект: без этих проверок правило
  -- {"times": "20:00"} тихо доехало бы до планировщика и не забронировало ничего.
  constraint schedule_rules_times_array  check (jsonb_typeof(times) = 'array' and jsonb_array_length(times) > 0),
  constraint schedule_rules_courts_array check (jsonb_typeof(courts) = 'array' and jsonb_array_length(courts) > 0),
  constraint schedule_rules_days_array   check (days_of_week is null or jsonb_typeof(days_of_week) = 'array')
);

create index if not exists schedule_rules_profile_idx on public.schedule_rules (profile_id);

-- Скип целого дня: планировщик не ставит на эту дату ни одного дропа, а уже
-- поставленная бронь-джоба проверяет скип ещё раз перед окном.
create table if not exists public.skips (
  profile_id text not null references public.profiles (id) on delete cascade,
  date       text not null,  -- YYYY-MM-DD, день игры в Asia/Tbilisi
  created_at text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"'),
  -- В этот уникальный ключ целится upsert репозитория
  -- (POST ?on_conflict=profile_id,date + Prefer: resolution=merge-duplicates).
  constraint skips_profile_date_key unique (profile_id, date)
);

-- Глобальные флаги бота. Ключ planner_enabled='true' — единственный способ
-- включить автоматический планировщик (фаза 4, по явному одобрению пользователя).
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- Доступ — как у bookings: только service-ключ, два независимых барьера.
-- Здесь лежат email, телефоны и chat_id, то есть персональные данные.
alter table public.profiles       enable row level security;
alter table public.schedule_rules enable row level security;
alter table public.skips          enable row level security;
alter table public.settings       enable row level security;

revoke all on table public.profiles       from anon, authenticated;
revoke all on table public.schedule_rules from anon, authenticated;
revoke all on table public.skips          from anon, authenticated;
revoke all on table public.settings       from anon, authenticated;

-- PostgREST кэширует схему; в Supabase кэш обновляется сам, но если сразу после
-- Run адаптер жалуется на PGRST205 "Could not find the table" — выполнить это:
notify pgrst, 'reload schema';
