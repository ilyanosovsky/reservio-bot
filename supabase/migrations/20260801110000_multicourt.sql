-- Мультикорт: одна и та же пара (дата, время) может иметь брони на РАЗНЫХ кортах.
--
-- Зачем: клуб держит Padel Court 2 и 3 на 20:00–22:00 под своими группами, и в
-- публичный дроп вечером выходит то один корт, то другой (21:00 стабильно только
-- Court 4). Единственная рабочая стратегия — вахта по НАБОРУ кортов и бронь
-- КАЖДОГО появившегося; лишнее владелец отменяет руками. Старый уникальный
-- индекс (profile_id, date, time) это прямо запрещал: вторая бронь того же часа
-- на другом корте затирала первую (upsert merge-duplicates).
--
-- ВНИМАНИЕ: 20260730123000, 20260730140000 и 20260731110000 уже применены —
-- их редактировать нельзя, любая правка схемы едет отдельной миграцией (этой).
--
-- Тот же DDL продублирован в docs/supabase-schema.sql (путь без CLI: SQL Editor
-- -> вставить -> Run) — держать файлы в синхроне, иначе схема разъедется с
-- адаптером src/core/state-supabase.ts.

-- --- bookings: ключ слота теперь включает корт -----------------------------
-- Сначала снимаем старый индекс: пока он жив, вторая бронь того же часа на
-- другом корте падает с 23505 (или молча затирает первую через upsert).
drop index if exists public.bookings_profile_date_time;

-- В этот индекс целится upsert адаптера
-- (POST ?on_conflict=profile_id,date,time,court + Prefer: resolution=merge-duplicates):
-- без него PostgREST ответит 42P10 и бронь не сохранится.
create unique index if not exists bookings_profile_slot_court
  on public.bookings (profile_id, "date", "time", court);

-- --- schedule_rules: режим сценария и его имя для UI -----------------------
-- mode:
--   'priority' — старое поведение: первый доступный корт по приоритету, дальше стоп;
--   'all'      — бронировать КАЖДЫЙ появившийся корт из набора (вечерняя вахта).
-- Дефолт 'priority' специально: миграция не должна менять поведение уже
-- существующих правил (их владелец не переключал).
alter table public.schedule_rules add column if not exists mode text not null default 'priority';

-- label — имя сценария в интерфейсе бота («20:00+21:00 · C3,C4,C1»). Пустая
-- строка = имя не задано, бот сгенерирует его сам из времён и кортов.
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

-- PostgREST кэширует схему: после ручного прогона в SQL Editor кэш может
-- отстать, и адаптеры пожалуются на PGRST204 «Could not find the column».
notify pgrst, 'reload schema';
