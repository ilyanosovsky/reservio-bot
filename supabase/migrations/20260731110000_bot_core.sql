-- Ядро Telegram-бота (фаза 3): профили, правила расписания, скипы дней,
-- настройки. Таблица bookings из 20260730123000 не трогается.
--
-- ВНИМАНИЕ: 20260730123000 и 20260730140000 уже применены — их редактировать
-- нельзя, любая правка схемы едет отдельной миграцией (этой).
--
-- Читает/пишет только src/core/repos.ts (PostgREST через fetch, ключ
-- SUPABASE_SERVICE_ROLE_KEY). Тот же DDL продублирован в docs/supabase-schema.sql
-- (путь без CLI: SQL Editor -> вставить -> Run) — держать файлы в синхроне.
--
-- Все created_at — text с явным +04:00, как и в bookings: state хранит строки
-- ровно так, как их видит бот (CLAUDE.md → таймзона клуба Asia/Tbilisi, без DST).

-- --- Профили ---------------------------------------------------------------
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

-- --- Правила расписания ----------------------------------------------------
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

-- --- Скипы -----------------------------------------------------------------
-- Скип целого дня: планировщик не ставит на эту дату ни одного дропа, а уже
-- поставленная бронь-джоба проверяет скип ещё раз перед окном.
create table if not exists public.skips (
  profile_id text not null references public.profiles (id) on delete cascade,
  date       text not null,  -- YYYY-MM-DD, день игры в Asia/Tbilisi
  created_at text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"'),
  -- В этот уникальный ключ целится upsert репозитория
  -- (POST ?on_conflict=profile_id,date + Prefer: resolution=merge-duplicates):
  -- без него PostgREST ответит 42P10 и скип не сохранится.
  constraint skips_profile_date_key unique (profile_id, date)
);

-- --- Настройки -------------------------------------------------------------
-- Глобальные флаги бота. Ключ planner_enabled='true' — единственный способ
-- включить автоматический планировщик (фаза 4, по явному одобрению пользователя).
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- --- Доступ ----------------------------------------------------------------
-- Как и у bookings: ходит только service-ключ. Два независимых барьера —
-- RLS без политик и отзыв грантов у публичных ролей. Здесь лежат email,
-- телефоны и chat_id, то есть персональные данные.
alter table public.profiles       enable row level security;
alter table public.schedule_rules enable row level security;
alter table public.skips          enable row level security;
alter table public.settings       enable row level security;

revoke all on table public.profiles       from anon, authenticated;
revoke all on table public.schedule_rules from anon, authenticated;
revoke all on table public.skips          from anon, authenticated;
revoke all on table public.settings       from anon, authenticated;

-- PostgREST кэширует схему: после ручного прогона в SQL Editor кэш может
-- отстать и репозитории пожалуются на PGRST205 «Could not find the table».
notify pgrst, 'reload schema';
