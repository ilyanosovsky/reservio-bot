# Architecture

Path A: a deterministic TypeScript core making direct Reservio API v2 calls.
There is no LLM and no browser agent in the core flow (see `CLAUDE.md`). The only
LLM in the project parses free-form Telegram queries (`core/intent.ts`) and never
makes booking decisions.

## Module layout

```
src/
  reservio/client.ts       # API client: availability, createBooking, cancelBooking, getBooking
  reservio/types.ts        # types, businessId, court table (serviceId/resourceId)
  core/scheduler.ts        # drop windows and date arithmetic in Asia/Tbilisi
  core/state.ts            # StateStore interface (async) + MemoryStateStore
  core/state-sqlite.ts     # SqliteStateStore — the only import of better-sqlite3
  core/state-supabase.ts   # SupabaseStateStore — PostgREST over bare fetch (cloud state)
  core/repos.ts            # Supabase repositories: profiles, schedule rules, skips, settings, reports, invites
  core/profiles.ts         # multi-profile config (contact + BookingRule)
  core/booking-engine.ts   # polling + booking over the watch set: bookSlotDrop(profile, target, deps)
  core/book-now.ts         # on-demand booking of an already-free slot (buttons / free queries)
  core/slot-search.ts      # pure search for adjacent-hour packs on one court (no LLM)
  core/intent.ts           # Haiku intent parser: free-form text → BookingIntent (forced tool-use)
  core/notify.ts           # Telegram: sendTelegram + formatDropReport
  core/heartbeat-logic.ts  # pure watchdog checks: planner ran, one report per planned slot, bot alive
  run-drop.ts              # CLI for a manual drop run (dry-run by default, --live)
  trigger/daily-planner.ts # trigger.dev cron: plans the evening and enqueues one book-drop per slot (ENABLED)
  trigger/book-drop.ts     # trigger.dev task: one drop + Telegram report
  trigger/remind.ts        # trigger.dev task: the T-2h reminder
  trigger/drop-observe.ts  # trigger.dev task: passive drop observation (measurement, no booking)
  trigger/heartbeat.ts     # trigger.dev cron 22:12 Tbilisi: nightly watchdog + admin alert
  bot/                     # grammY: commands, buttons, wizard, reminders, free queries
  bot/index.ts             # bot entry point (long-polling)
trigger.config.ts          # trigger.dev config (project proj_your_project_ref) + syncEnvVars
docs/supabase-schema.sql   # DDL for the bookings table (Supabase SQL Editor)
supabase/migrations/       # SQL migrations: bookings, bot core, multicourt, heartbeat, invites
spike-reservio.ts          # manual protocol / booking / cancel check (phase 1)
spike-drop-watch.ts        # observing a specific drop + booking (phase 1, predates run-drop.ts)
tests/                     # vitest: engine, scheduler, state, profiles, client, notify, bot, planner, intent, ...
docs/PROTOCOL.md           # the confirmed Reservio API v2 protocol
```

All of the above is implemented and covered by tests (phases 1–5 complete).
Reconcile with `git log`/the open PR if you see a material discrepancy.

## Modules and their role

**`reservio/client.ts`** (`ReservioClient`) — the single point of HTTP contact
with Reservio. Methods: `getAvailability(serviceId, date)`,
`createBooking({serviceId, start, end, contact})`, `cancelBooking(bookingId, token)`,
`getBooking(bookingId, token)`. The default request timeout is 5 s, with up to 3
attempts and exponential backoff (1 s → 2 s → 4 s…, capped at 30 s, honouring
`Retry-After`) on `429`/`5xx` for GET/PATCH. **`createBooking` is never
retried** — a repeated POST risks creating a duplicate booking. A booking counts
as a success only when `data.id` is present; a cancellation only when
`data.attributes.state === "canceled"` in the response body, never by the HTTP
code (`docs/PROTOCOL.md`).

**`reservio/types.ts`** — `businessId`, the court table `COURTS` (name →
`serviceId`/`resourceId`, from `docs/PROTOCOL.md`), `courtByName()`, and the
`Slot`/`BookingCreated`/`ClientContact` types.

**`core/scheduler.ts`** — pure date arithmetic with no bare `new Date()` without
an offset: `targetDate(now)` (T+7 in Asia/Tbilisi), `slotStartISO`/`slotEndISO`
(`'2026-08-06'+'20:00'` → `'2026-08-06T20:00:00+04:00'`/`…T20:59:00+04:00'`),
`dropWatchWindow(dayT, time)` → `{start, deadline}` — the watch window for hour
`H` opens at `H:58:30` on day T (the same hour!) and lasts 5 minutes,
`dropDayOf(date)` — the observation day T for a target date T+7,
`weekdayOf(date)`/`tbilisiStamp(now)` — the weekday and a timestamp label in
+04:00.

**`core/state.ts`** (`StateStore`) — the interface
`getBooking(profileId, date, time, court)` (pinpoint, "is THIS court taken") /
`listBookingsForSlot(profileId, date, time)` (the whole hour across all courts)
/ `saveBooking(b)` / `listBookings(profileId?)` / `markCanceled(bookingId)`,
**all methods asynchronous** (`Promise`): the interface may sit over the network.
This file also holds `MemoryStateStore` (an in-memory `Map`) and pulls in no
native imports, so it drops cleanly into the cloud bundle. The concrete stores
live elsewhere: `core/state-sqlite.ts` (`SqliteStateStore`, `better-sqlite3`,
`WAL`, an on-disk file — local runs and tests) and `core/state-supabase.ts`
(`SupabaseStateStore`, PostgREST over bare `fetch`, no `@supabase/supabase-js` —
the shared store for the cloud and the bot; DDL in `docs/supabase-schema.sql`).
The dedup key is the same everywhere: `(profileId, date, time, court)` — a unique
index (`bookings_profile_slot_court`, migration
`20260801110000_multicourt.sql`). The court has been part of the key since
2026-08-01: the club holds Court 2/3 on 20:00–22:00 for its own groups, and in
the evening drop it is sometimes one court and sometimes another, so the bot
watches a **set of courts** and books every one that appears — two bookings for
the same hour on different courts are legitimate, and the owner cancels the
surplus by hand. `SqliteStateStore` rebuilds any old-schema SQLite file
(`PRIMARY KEY` without the court) when it opens it.

**`core/repos.ts`** — the Supabase-backed repositories the bot reads and writes
through: profiles, `schedule_rule`s, skips, `settings`, drop-report receipts, and
invite tokens. PostgREST over bare `fetch`, same style as `state-supabase.ts`.
The `settings` table (planner flags, `skip` dates, heartbeat markers, and so on)
is here — that is where `planner_enabled` lives.

**`core/notify.ts`** — outbound Telegram: `telegramFromEnv(env)` (→ `null` when
the bot is not configured — not an error), `sendTelegram(target, text)`
(`parse_mode=HTML`, 5 s timeout, never throws outward and never leaks the
botToken baked into the URL), and `formatDropReport(report, extra)` — a compact
message for a `DropReport` with no `token` and no profile contact data.

**`core/profiles.ts`** (`loadProfiles(env)`) — a profile is `{id, label, contact,
telegramChatId?, rule: {times, courts, daysOfWeek?}}`. The default profile
(`id: 'ilya'`) is assembled from `CLIENT_NAME/EMAIL/PHONE` with defaults
`times: ['20:00','21:00']` and the evening watch set
`courts: ['Padel Court 3','Padel Court 4','Padel Court 1']`. Extra profiles are
added without touching code via `PROFILE_<K>_NAME/EMAIL/PHONE/TIMES/COURTS` (for
example a second player with their own times and court set). At runtime the bot's
profiles and schedule rules live in Supabase (`core/repos.ts`); env profiles
remain the source for the CLI and for tests.

**`core/booking-engine.ts`** — exports
`bookSlotDrop(profile, {date, time, courts, mode}, deps: EngineDeps): Promise<DropReport>`
(`EngineDeps = {client, state, now?, sleep?, log?}` — `now`/`sleep` are injected
in tests for determinism). Idempotency comes first: if an outstanding record
(`state !== 'canceled'`) already exists, no `POST` is made at all and
`{ok: false, error: {kind: 'AlreadyBooked'}}` is returned. The check depends on
the mode: `listBookingsForSlot(profileId, date, time)` in `priority` (any booking
for the hour blocks the run) and the pinpoint
`getBooking(profileId, date, time, court)` in `all` (only that court is closed —
bookings on different courts of the same hour are legitimate). The same check is
repeated after the sleep-to-window and immediately before every `POST` — otherwise
two runs that started before the window would create a duplicate. The window is
computed from `dropDayOf(date)` (the target date − 7 days), not from "today"; if
the window is already closed or opens more than a day out, the engine returns
`Timeout` with an explanation right away rather than sleeping unbounded. Then
comes the polling: each round checks **all** of the profile's courts in a row (no
pause between courts — the pause is only between rounds), and on the first `start`
match it fires the `POST` immediately. The `POST` is not retried: **one attempt
per court per run**, and once the attempts are spent, polling stops early. A
deterministic failure (`4xx`) → move to the next court; an ambiguous one
(timeout/reset/`5xx`/`2xx` without `data.id`) → in `priority` the whole drop
stops, because the booking may have been created on the server (a second attempt
would mean two real bookings), while in `all` only that court is closed (the
others are different resources, so no duplicate there) and it is flagged
`ambiguous` to warn the owner. Client errors with `code=unexpectedResponse` are
classified as `ApiChanged`, not `Timeout`. The polling rounds have their own
backoff on 429/5xx/network errors: 2 s → 4 s → 8 s → 16 s → 30 s (a layer on top
of the retry inside `reservio/client.ts` itself). `DropReport`:
`{ok, profileId, date, time, court?, bookingId?, token?, msFromSeenToBooked?,
results: {court, ok, bookingId?, msFromSeenToBooked?, error?, ambiguous?}[],
timeline: {at, event}[], error?: {kind, detail?}}` (the root
`court`/`bookingId`/`token` are the FIRST booking of the run; the full picture
for the set is always in `results`; `ambiguous` flags a court whose `POST` may
still have created a booking — the task sends a separate `⚠️` for it even in a
green report), `DropErrorKind = 'SlotTaken' | 'ApiChanged' | 'Timeout' |
'AlreadyBooked'`. No exception escapes: a malformed `date`/`time` and any `state`
failure are turned into a `DropReport` (otherwise not a single message would reach
Telegram — the silent failure the project forbids).

**`core/book-now.ts`** — booking on demand (the "📆 Book" button and manual
flows). Unlike `booking-engine.bookSlotDrop` there is no drop window, no polling
and no scanning across courts here — the person has already picked a
date/time/court from what is actually free, and we make exactly one attempt. The
drop stays the only place where seconds are raced. What it keeps from the engine
by design: one `POST` per call, no retries, idempotency on
`(profileId, date, time, court)` through `StateStore`, and success only by a
`bookingId` from the API. The module is host-agnostic (no env, no trigger.dev
SDK, no Telegram); reminder scheduling is injected via `deps.scheduleReminder`.

**`core/slot-search.ts` + `core/intent.ts`** — the free-query stack (phase 5).
`intent.ts` (`parseIntent`) turns free-form chat text into a structured
`BookingIntent` using Claude Haiku (`claude-haiku-4-5`) with **forced tool-use**:
the model returns only the tool arguments, never prose to the user, and makes no
booking decision. `slot-search.ts` (`searchSlots`) is a pure function — no
network, no state, no Telegram — that takes already-fetched availability and
returns a deterministically ordered list of options; a pack
(`durationHours > 1`) is consecutive hours **on one court within a single day**
(23:00 + 00:00 is never a pack). Each option becomes a "Book" button that leads
to the existing confirmation screen. There is a per-profile daily quota on free
queries. Details in `docs/wiki/Bot.md` → "Free queries".

**`core/heartbeat-logic.ts`** — the pure checks behind the nightly watchdog
(planner ran today, one delivered report per planned slot, bot alive), plus the
single source of truth for the `settings` table keys shared by the planner and
the watchdog. No SDK, no network — the wiring lives in `trigger/heartbeat.ts`.

**`run-drop.ts`** — a CLI for a single manual drop run:
`npx tsx src/run-drop.ts --profile ilya --date YYYY-MM-DD --time HH:MM [--live] [--court "Padel Court 3"] [--force] [--sqlite]`.
Without `--live` it is a dry-run: the whole engine runs for real (polling,
window, idempotency), but `createBooking` is swapped for a stub, there is no real
`POST`, and state is written under id `<profile>:dry` in a separate `state.dry.db`
file (a fake booking under the live key would block a real run of the same slot).
**State is selected by the same logic as in the cloud task**: given
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` → `SupabaseStateStore`, otherwise
`SqliteStateStore`. Otherwise the local and cloud runs would not see each other's
bookings and could calmly create two real bookings for one slot. `--sqlite` is an
emergency fallback to a file when Supabase is configured but unreachable (there is
no cross-host duplicate protection at that moment, and the script says so loudly).
The weekdays from `rule.daysOfWeek` are checked before the run (`--force` skips the
check); the `token` is never printed to stdout — only the fact that it was saved
to state. Details and examples in `Runbook.md`.

**`trigger/daily-planner.ts`** — the trigger.dev cron task `daily-planner`, the
**only** place in the project where `schedules.task` is allowed. It runs every day
at **20:30 Tbilisi** (16:30 UTC, no DST) and, when enabled, it:

1. computes the target game date T+7 (`scheduler.targetDate`) from the run's
   timestamp (not `Date.now()`, for determinism);
2. takes the enabled `schedule_rule`s whose profile has a `telegram_chat_id`,
   whose `daysOfWeek` allows T+7, and for whom there is no `skip` on T+7;
3. sends each profile a pre-drop message (the plan: date/times/courts) with inline
   "Skip" and "Book" buttons;
4. for each (profile, hour) enqueues `trigger/book-drop.ts` via
   `tasks.trigger('book-slot-drop', …, { delay, idempotencyKey, concurrencyKey })`
   — `delay` = `H:57:00` on day T, a global `idempotencyKey` so a re-run does not
   create a duplicate drop, and `concurrencyKey = profileId`. The courts and mode
   from **those** rules travel in the payload — the scenario choice is made here,
   not re-derived by time in `book-drop.ts`;
5. records the enqueued drops in `settings.planner_last_plan` and, on a successful
   run, stamps `settings.planner_last_run` — the two markers the 22:12 heartbeat
   reconciles against.

Activation is gated by `settings.planner_enabled`: while it is not `'true'` the
task reads the flag and exits quietly (the cron ticks but books nothing and messages
nobody). In production this flag is **on** (enabled 2026-08-04 with the user's
explicit approval), so the evenings run autonomously.

**`trigger/book-drop.ts`** + **`trigger.config.ts`** — the trigger.dev task
`book-slot-drop` (project `proj_your_project_ref`), running the same
`bookSlotDrop`, payload `{profileId, date, time, live, force?, courts?, mode?}`;
`concurrencyLimit: 1`, `maxAttempts: 1`, default machine, `maxDuration: 600`.
It has **no `schedules` of its own** — it is enqueued by `daily-planner` (or
triggered by hand from the dashboard / CLI / `mcp__trigger__trigger_task`, including
a deferred run via `options.delay`). What the task adds on top of the engine:

- **state selection**: given `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` →
  `SupabaseStateStore`, otherwise `MemoryStateStore` with a "state is NOT
  persistent (Memory)" warning. The first Supabase call is made **before** the
  drop window so that "no such table"/"wrong key" surface early. Any store failure
  moves the run onto memory PERMANENTLY (for that run) and adds a warning, but does
  **not** abort the booking: the booking matters more than persistence, and
  duplicate protection at that moment rests on `concurrencyLimit: 1` and the
  disabled retries. The Supabase request timeout here is shortened to 1.5 s
  (instead of the default 5 s): the engine reads state right before the `POST`,
  already inside the hot window, and a hung store must not eat seconds in the race
  for a court.
- **token on degradation**: if the booking succeeds but state falls over,
  `saveBooking` went to memory and dies with the run — the token is saved nowhere.
  In that (and only that) case it stays in the run output and a line "cancel only
  via the link in the email" is added to the message. Without this the only key to
  the booking would be lost entirely.
- **DRY vs LIVE separation**: with `live: false` the engine gets a profile with id
  `<profile>:dry`, so a fake `dry-…` booking does not occupy the live key
  `(profileId, date, time)` — otherwise the next real run of the same slot would
  come back `AlreadyBooked` without a single `POST` (the same reason `run-drop.ts`
  keeps a separate `state.dry.db`).
- **refusing runs that are bound to fail**: if the window opens more than 4 minutes
  out (`maxDuration` 600 s minus the watch window and slack), the task fails with a
  hint about which second to set `delay` to. Otherwise the run would be killed by
  `maxDuration` mid-sleep — no booking and no report.
- **exactly one Telegram message per run** — success, failure, or a crash of the
  run itself (a `try/catch` around the whole `run()` sends ❌ before re-throwing;
  if the formatter itself breaks, a fallback short text goes out). The send is
  attempted up to three times with a 1.5 s pause: a transient 429/502 from Telegram
  must not turn the invariant into zero messages. Failing all attempts does not
  crash the run but is logged. The recipient is `TELEGRAM_CHAT_ID`, or the
  profile's own `PROFILE_<K>_TELEGRAM_CHAT_ID` if it has one; with multiple profiles
  there may be no global chat_id at all — the bot token plus the profile's chat_id
  are enough. The profile contact (`CLIENT_*`), the `token`, and secret values
  reach neither the log, nor the output, nor the message — the report text and any
  error text pass through redaction.

`trigger.config.ts` additionally: `build.external: ['better-sqlite3']` (the native
module is not bundled) and `syncEnvVars` from `@trigger.dev/build` — before every
deploy it reads the local `.env` with its own mini-parser (no `dotenv`) and uploads
**only** an allowlist of keys (`CLIENT_*`, `SUPABASE_*`, `TELEGRAM_*`, plus the
`ANTHROPIC_API_KEY` used by the free-query parser), marking everything except
`SUPABASE_URL` as a secret. Values are never logged — only the names of missing
ones.

**`trigger/remind.ts`** and **`trigger/drop-observe.ts`** — the T-2h reminder task
and a passive drop-observation task (measurement only, never books). `drop-observe`
is how the drop model's live journal was collected (`docs/PROTOCOL.md`).

**`trigger/heartbeat.ts`** — the watchdog task, cron `12 18 * * *` (UTC) =
**22:12 Asia/Tbilisi**, after both evening drops (20:59 and 21:59) and their
reports. It is the guard for the observability invariant ("every evening exactly
one message"): the evening run holds that invariant only while it is alive, so if
the planner cron did not tick, a worker died, Supabase was down, or Telegram
rejected the message, the watchdog is what catches it. It reconciles the evening's
**plan** (`settings.planner_last_plan`) with the delivered **receipts**
(`drop_reports`, written by `book-drop.ts` after a report is sent) and, if anything
does not add up, sends **one** message to the admins; if everything checks out it
stays silent — silence here is "green". It also checks `bot_alive_at` is no older
than 15 minutes, gated by `settings.bot_alive_required` (off while the bot process
runs on the owner's laptop rather than a host, otherwise it would alert every
night). Details and alert triage in `docs/wiki/Runbook.md` → "Heartbeat".

**`bot/` (grammY)** — the inbound Telegram interface. Authorization is an
allowlist of `chat_id → profile` (`bot/auth.ts`); an unknown chat_id gets complete
silence. Commands and buttons cover "My bookings", "Cancel today's",
skip/book on the pre-drop message, the T-2h reminder, and free queries. There is a
profile-creation wizard (`bot/handlers/profiles.ts`, `bot/wizard-state.ts`) that
issues invite links binding a player's chat to their profile, and a liveness ping
(`bot/alive.ts`) that stamps `bot_alive_at` for the heartbeat. Full command and
button reference: `docs/wiki/Bot.md`. The outbound drop report itself does not need
the bot — it goes through `core/notify.ts`.

## Data flow for one drop

1. `scheduler.dropWatchWindow(dropDayOf(date), time)` computes the watch window for
   hour `H`.
2. `run-drop.ts` (or the trigger.dev task) calls `booking-engine.bookSlotDrop`,
   which starts polling through `reservio/client.getAvailability` from the start of
   the window.
3. The slot for hour `H` appears in availability → `booking-engine` checks against
   `core/state` that there will be no duplicate, and fires `POST bookings` for the
   courts in the watch set. In the evening mode `all` it books **every** court that
   shows the slot (extras are cancelled by the owner); in mode `priority` it takes
   the first court and moves on only on failure.
4. On success (`bookingId` received) the result is written to `core/state` via
   `saveBooking` (in the cloud, the `bookings` table in Supabase).
5. The `DropReport` goes out: `run-drop.ts` prints it to the console as JSON;
   `trigger/book-drop.ts` formats it through `core/notify.formatDropReport` and
   sends **exactly one** Telegram message (success/error/run crash — the
   observability invariant from `CLAUDE.md`).

## Drop model (from `docs/PROTOCOL.md`)

The drop is **hourly, rolling T+7**: the slot for hour `H` on day T+7 appears at
`H:59:00 ± 2 s` on day T — in the very same hour as the slot itself. The horizon
is exactly 7×24 h, counted from the END of the slot (`end − 7 days` = `H:59:00`).
For the 20:00+21:00 pair these are two separate drops: ~20:59:00 and ~21:59:00 on
day T. Confirmed by live measurements on 2026-07-30/31: the 06.08 10:00 slot was
absent at 10:58:49.4 and appeared at 10:58:59.9 (`POST` at 10:59:01 → `confirmed`,
1.1 s from the slot appearing to a confirmed booking); 07.08 20:00 on Court 3
appeared on 31.07 at 20:59:00–01.5 (booked in 743 ms); 07.08 21:00 on Court 4 at
21:59:00. Full journal in `docs/PROTOCOL.md`; `booking-engine` starts polling ahead
of time, from `H:58:30`. (The `(H-1):58:50` formula from the first draft of the
docs was wrong: it contradicts this measurement and made the bot poll an hour
before the drop.)

```mermaid
sequenceDiagram
    participant CLI as run-drop.ts / trigger task
    participant Scheduler as core/scheduler
    participant Engine as core/booking-engine (bookSlotDrop)
    participant API as Reservio API v2
    participant State as core/state (Supabase / SQLite / Memory)
    participant Notify as core/notify (Telegram)

    CLI->>Scheduler: dropWatchWindow(dropDayOf(date), "20:00")
    Scheduler-->>CLI: {start H:58:30, deadline +5 min}
    CLI->>State: getBooking(...) — probe the store before the drop window
    State-->>CLI: ok / error → fall back to Memory + warning
    CLI->>Engine: bookSlotDrop(profile, {date, time, courts, mode}, deps)
    Engine->>State: listBookingsForSlot / getBooking (per mode)
    State-->>Engine: null (no booking yet)

    loop polling every ≥2 s until the slot appears or the deadline
        Engine->>API: GET availability/booking-slots (each court in the watch set)
        API-->>Engine: list of free slots (20:00 not there yet)
    end

    Note over API: ~H:59:00 ± 2 s of day T — drop: the slot appears in availability

    Engine->>API: GET availability/booking-slots (watch set)
    API-->>Engine: 20:00 present for one or more courts
    loop for each court whose 20:00 appeared
        Engine->>API: POST bookings (court, 20:00)
        API-->>Engine: data.id (bookingId) + attributes.token
        Engine->>State: saveBooking({..., bookingId, token, state})
    end
    Note over Engine: mode "all" — book every court that appeared (owner cancels extras);<br/>mode "priority" — stop at the first success
    Engine-->>CLI: DropReport {ok, court, bookingId, token, results[], ...}
    CLI->>Notify: formatDropReport(report, {stateWarning?})
    Notify-->>Notify: exactly one Telegram message (no token, no contacts)
```
