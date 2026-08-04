-- Схема state'а padel-bot в Supabase Postgres (project id kbwmrqoxjlydmwyxirqm).
--
-- Как применить: Supabase Dashboard -> SQL Editor -> New query -> вставить целиком -> Run.
-- Скрипт идемпотентен: повторный запуск ничего не ломает и не трогает данные.
--
-- Тот же DDL лежит миграциями supabase/migrations/*.sql (для `supabase db push`):
-- 20260730123000_bookings, 20260730140000_bookings_hardening,
-- 20260731110000_bot_core, 20260801110000_multicourt, 20260804140000_heartbeat.
-- Этот файл — источник правды и путь без CLI; держать в синхроне, иначе схема
-- разъедется с адаптером.
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

-- Один слот профиля НА ОДНОМ КОРТЕ = максимум одна бронь. Корт в ключе с
-- 01.08.2026 (миграция 20260801110000_multicourt.sql): клуб держит Court 2/3 на
-- 20:00–22:00 под свои группы, вечером в дроп выходит то один корт, то другой,
-- поэтому бот ловит НАБОР кортов и бронирует каждый появившийся — лишнее
-- владелец отменяет руками. Старый индекс (profile_id, date, time) это запрещал.
drop index if exists public.bookings_profile_date_time;

-- В этот индекс целится upsert адаптера
-- (POST ?on_conflict=profile_id,date,time,court + Prefer: resolution=merge-duplicates):
-- без него PostgREST ответит 42P10 и запись брони не подтвердится.
create unique index if not exists bookings_profile_slot_court
  on public.bookings (profile_id, "date", "time", court);

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
-- Ядро Telegram-бота (фаза 3). Тот же DDL лежит миграциями
-- supabase/migrations/20260731110000_bot_core.sql и 20260801110000_multicourt.sql
-- (mode/label у schedule_rules) — держать файлы в синхроне.
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
  courts       jsonb not null,  -- ["Padel Court 3","Padel Court 4"] — набор кортов сценария
  days_of_week jsonb,           -- [1,2,3] (вс=0); null = каждый день
  enabled      boolean not null default true,
  -- 'priority' — первый доступный корт по приоритету и стоп (старое поведение);
  -- 'all'      — бронировать КАЖДЫЙ появившийся корт набора (вечерняя вахта).
  mode         text not null default 'priority',
  label        text not null default '',  -- имя сценария в боте; '' = сгенерировать
  created_at   text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"'),
  -- jsonb принимает и число, и строку, и объект: без этих проверок правило
  -- {"times": "20:00"} тихо доехало бы до планировщика и не забронировало ничего.
  constraint schedule_rules_times_array  check (jsonb_typeof(times) = 'array' and jsonb_array_length(times) > 0),
  constraint schedule_rules_courts_array check (jsonb_typeof(courts) = 'array' and jsonb_array_length(courts) > 0),
  constraint schedule_rules_days_array   check (days_of_week is null or jsonb_typeof(days_of_week) = 'array')
);

create index if not exists schedule_rules_profile_idx on public.schedule_rules (profile_id);

-- Для БД, созданной до 01.08.2026: create table выше её не трогает, колонки
-- добавляем отдельно (миграция 20260801110000_multicourt.sql). Дефолт
-- 'priority' специально — миграция не меняет поведение уже созданных правил.
alter table public.schedule_rules add column if not exists mode  text not null default 'priority';
alter table public.schedule_rules add column if not exists label text not null default '';

-- Мусор в mode тихо доехал бы до движка и выбрал бы не ту стратегию вечера.
-- add constraint if not exists в Postgres нет — проверяем сами (идемпотентно).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schedule_rules_mode_check') then
    alter table public.schedule_rules
      add constraint schedule_rules_mode_check check (mode in ('priority', 'all'));
  end if;
end $$;

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
-- Остальные ключи (пишет код, руками трогать не нужно):
--   planner_last_run     — 'YYYY-MM-DDTHH:MM:SS.mmm+04:00' конца рана планировщика,
--                          с префиксом 'disabled@', если он отработал выключенным;
--   planner_last_plan    — JSON {date, at, slots:[{profileId,time}]}: дропы,
--                          которые планировщик реально поставил (сверяет heartbeat);
--   bot_alive_at         — отметка живости процесса бота (раз в 5 минут);
--   bot_alive_required   — 'true' включает проверку живости бота в heartbeat;
--                          ставится ВРУЧНУЮ вместе с хостингом бота
--                          (docs/wiki/Runbook.md -> «Heartbeat»).
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

-- ===========================================================================
-- Heartbeat (фаза 4). Тот же DDL лежит миграцией
-- supabase/migrations/20260804140000_heartbeat.sql — держать файлы в синхроне.
-- Читает/пишет только src/core/repos.ts (DropReportsRepo).
-- ===========================================================================

-- Квитанция о вечернем отчёте. Инвариант CLAUDE.md: каждый вечер уходит ровно
-- одно сообщение о дропе, молчаливый провал — худший баг проекта. Изнутри рана
-- «сообщение ушло» не проверить: если ран не стартовал вовсе (умер воркер, не
-- сработал планировщик), рассказать об этом некому. Поэтому каждый ран
-- book-slot-drop оставляет здесь квитанцию, а таск heartbeat в 22:12 Тбилиси
-- сверяет квитанции с планом вечера и будит админов, если чего-то нет.
create table if not exists public.drop_reports (
  id          uuid primary key default gen_random_uuid(),
  -- Без внешнего ключа на profiles специально: DRY-прогоны пишут квитанцию под
  -- id с суффиксом ':dry' (см. book-drop.ts), а такого профиля в profiles нет.
  profile_id  text not null,
  "date"      text not null,           -- YYYY-MM-DD, дата игры в Asia/Tbilisi
  "time"      text not null,           -- HH:MM, начало слота
  ok          boolean not null,        -- исход дропа: бронь есть / брони нет
  telegram_ok boolean not null,        -- отчёт РЕАЛЬНО доставлен в Telegram
  created_at  text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"')
);

-- Heartbeat читает квитанции ровно одним запросом «за дату игры». Уникальности
-- нет намеренно: повторный ран (Replay) оставляет ВТОРУЮ квитанцию.
create index if not exists drop_reports_date_idx on public.drop_reports ("date");

alter table public.drop_reports enable row level security;
revoke all on table public.drop_reports from anon, authenticated;

-- PostgREST кэширует схему; в Supabase кэш обновляется сам, но если сразу после
-- Run адаптер жалуется на PGRST205 "Could not find the table" — выполнить это:
notify pgrst, 'reload schema';
