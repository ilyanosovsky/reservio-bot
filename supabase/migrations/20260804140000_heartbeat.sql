-- Heartbeat (фаза 4): квитанции о вечерних отчётах.
--
-- ВНИМАНИЕ: 20260730123000, 20260730140000, 20260731110000 и 20260801110000 уже
-- применены — их редактировать нельзя, любая правка схемы едет отдельной
-- миграцией (этой).
--
-- Зачем таблица. Инвариант CLAUDE.md: каждый вечер в Telegram уходит ровно одно
-- сообщение о дропе, а молчаливый провал — худший баг проекта. Проверить сам
-- факт «сообщение ушло» изнутри рана нельзя: если ран не стартовал вовсе (умер
-- воркер, не сработал планировщик), рассказать об этом некому. Поэтому каждый
-- ран book-slot-drop оставляет здесь КВИТАНЦИЮ, а таск heartbeat в 22:12
-- Тбилиси сверяет квитанции с планом вечера и будит админов, если чего-то нет.
--
-- Читает/пишет только src/core/repos.ts (DropReportsRepo, PostgREST через fetch,
-- ключ SUPABASE_SERVICE_ROLE_KEY). Тот же DDL продублирован в
-- docs/supabase-schema.sql (путь без CLI: SQL Editor -> вставить -> Run) —
-- держать файлы в синхроне.

create table if not exists public.drop_reports (
  id          uuid primary key default gen_random_uuid(),
  -- Без внешнего ключа на profiles специально: DRY-прогоны пишут квитанцию под
  -- id с суффиксом ':dry' (см. book-drop.ts), а такого профиля в profiles нет и
  -- быть не должно. Плюс удалённый профиль не должен уносить историю вечеров.
  profile_id  text not null,
  -- Слот, за который отчитались: дата игры (T+7) и час начала, Asia/Tbilisi.
  -- text, как и везде в этом проекте: state хранит строки ровно так, как их
  -- видит бот (типы date/time Postgres нормализовал бы '20:00' -> '20:00:00').
  "date"      text not null,           -- YYYY-MM-DD
  "time"      text not null,           -- HH:MM
  ok          boolean not null,        -- исход дропа: бронь есть / брони нет
  telegram_ok boolean not null,        -- отчёт РЕАЛЬНО доставлен в Telegram
  created_at  text not null default to_char(now() at time zone 'Asia/Tbilisi', 'YYYY-MM-DD"T"HH24:MI:SS"+04:00"')
);

-- Heartbeat читает квитанции ровно одним запросом «за дату игры» — под него и
-- индекс. Уникальности здесь нет намеренно: повторный ран (Replay) должен
-- оставить ВТОРУЮ квитанцию, а не переписать первую.
create index if not exists drop_reports_date_idx on public.drop_reports ("date");

-- --- Доступ ----------------------------------------------------------------
-- Как у остальных таблиц: ходит только service-ключ. Два независимых барьера —
-- RLS без политик и отзыв грантов у публичных ролей. Здесь лежат id профилей и
-- расписание игр конкретных людей.
alter table public.drop_reports enable row level security;
revoke all on table public.drop_reports from anon, authenticated;

-- PostgREST кэширует схему: после ручного прогона в SQL Editor кэш может
-- отстать и репозиторий пожалуется на PGRST205 «Could not find the table».
notify pgrst, 'reload schema';
