# Runbook

Status: all of `src/*` for phases 1–2 (client, scheduler, state in three
implementations, engine profiles, `booking-engine.bookSlotDrop`, `notify.ts`,
`run-drop.ts`, `trigger/book-drop.ts`) is implemented and covered by tests
(vitest). The cloud evening run goes through trigger.dev with a report to
Telegram — see "Evening cloud run". Phase 3 added an inbound Telegram **bot**
(`src/bot/`, commands and buttons, DB profiles/schedule rules/skips in
Supabase) — see "Bot: seeding profiles and local start" below and the full
breakdown of commands in `Bot.md`. The auto-booking scheduler
(`trigger/daily-planner.ts`) is written but **disabled by default** — see
"Scheduler" at the end of this file.

Before any run: `cp .env.example .env` and fill in `CLIENT_NAME`,
`CLIENT_EMAIL`, `CLIENT_PHONE` (the email is from the owner's Reservio account;
the booking will be tied to their personal cabinet). For a second engine
profile — the `PROFILE_<K>_NAME/EMAIL/PHONE/TIMES/COURTS` variables (example —
the comment in `src/core/profiles.ts` and the commented-out block in
`.env.example`). For the cloud run and for the bot you need `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` and `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

## `run-drop.ts` — manual drop run (dry-run / `--live`)

```bash
npx tsx src/run-drop.ts --profile ilya --date 2026-08-06 --time 20:00                 # dry-run: safe
npx tsx src/run-drop.ts --profile ilya --date 2026-08-06 --time 20:00 --live          # REAL booking
npx tsx src/run-drop.ts --profile ilya --date 2026-08-06 --time 20:00 --court "Padel Court 2"
```

Flags: `--profile` (profile id, defaults to `ilya`), `--date` YYYY-MM-DD,
`--time` HH:MM — both required, `--live` enables the real `POST`, `--court`
overrides the profile's court priority with one specific court, `--force`
lifts the `daysOfWeek` check from the profile's rule (without it, a run on a
"non-matching" day of the week stops with exit code 2 and books nothing),
`--sqlite` forces local state (see below).

**State is shared between the CLI and the cloud.** If `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set in the environment, the script uses the same
`SupabaseStateStore` as the trigger.dev task and does a trial read before the
window (broken access shows up immediately). This is the only thing that stops a
local run from creating a **second** real booking for a slot already booked by a
cloud run: `./state.db` and the `bookings` table are different sources of truth.
If Supabase is unavailable, the script exits with a hint; `--sqlite` will
continue on the file, but then there is no protection against a cross-host
duplicate — make sure there is no trigger.dev run on this slot.

- **Without `--live` (dry-run, the default)** — the engine works for real: it
  waits for the start of the watch window, polls availability, on the slot's
  appearance it checks idempotency, but instead of a real `createBooking` it
  writes to the log `[DRY] would have booked: serviceId=... start → end` and
  returns a synthetic `BookingCreated` (`bookingId: dry-<timestamp>`,
  `token: 'dry-token'`). Safe to run for checking timings and fallback logic.
  **The dry-run's state is separate**: both the profile id (`ilya:dry`, as in
  the cloud) and the file `state.dry.db`. A phantom booking under the live key
  would have blocked a subsequent `--live` run of the same slot
  (`AlreadyBooked`, not a single `POST`).
- **With `--live`** — the same engine, but `createBooking` is real: an actual
  `POST /bookings`, a real booking. Use only on an explicit request from the
  user in the current session.

If started before the watch window, the script itself waits for its start and
once every 30 s logs how many seconds are left (`watch window has not started
yet, starting in ~Ns`); all timestamps are in the club's zone (+04:00), as in
the engine. If the window has already closed or will open more than a day from
now (a miss in `--date`), the script exits with code 2 and a hint to check
`--date/--time`. At the end there is a `--- Result ---` block (✅/✗) and a
`DropReport` as JSON; the `token` in the output is replaced with
`<saved in …>` and the storage name (it is printed in full only if saving it to
state FAILED — in which case it is the only trace of the booking).

## What to look for in the logs

Every line from `ReservioClient`/the engine starts with an ISO timestamp.
Pay attention to:

- **`availability`**: the HTTP status and the number of slots on each polling
  request; the appearance of the target `start` in the list — that is exactly
  the recorded drop; compare the moment against the `H:59:00 ± 2 s` model of
  day T (see `Architecture.md` → "Drop model", `docs/PROTOCOL.md`) and record
  any noticeable discrepancy in `docs/PROTOCOL.md`.
- **Backoff, two levels**: (1) within a single HTTP request, `ReservioClient`
  retries `GET`/`PATCH` up to 3 times on `429`/`5xx` (the line `retry in Nms
  (attempt X/3)`, 1 s→2 s→4 s, capped at 30 s, respects `Retry-After`);
  (2) between polling rounds, `booking-engine` keeps its own backoff
  2 s→4 s→8 s→16 s→30 s if a whole poll round failed with an error. On
  `createBooking` (POST) there are no retries at all on either level: each court
  gets **exactly one** `POST` attempt per run, and when the attempts are
  exhausted, the engine stops polling early.
- **Ambiguous `POST` failure** (5 s timeout, dropped connection, `5xx`, `2xx`
  without `data.id`) — the booking MIGHT have been created on the server, so the
  engine does NOT move on to the next court but ends the drop with
  `Timeout`/`ApiChanged` and the text "the booking might have been created".
  Check the profile's email and the club manually: such a booking has neither a
  `bookingId` nor a `token`, and cannot be canceled via the API. On a
  deterministic failure (`4xx`, e.g. `409` — the slot was snatched) the engine
  immediately moves on to the next court in the profile's priority.
- **`AlreadyBooked`**: in `priority` mode — if there is ANY unresolved record
  for this `(profileId, date, time)` (on any court), the engine does not `POST`
  at all; in `all` mode — the same logic, but per court: a booked court is
  skipped, the rest of the watch set continue to participate. This is expected
  idempotency, not a bug, but on an unexpected appearance it is worth checking
  where the record came from (a duplicate run, an old run).
- **`createBooking: id=... state=...`** — the only confirmation of a successful
  booking. If the log shows `WARNING — no token in the response`, that is
  critical: without the token the booking can be neither read nor canceled;
  investigate immediately.
- **`cancelBooking: ... → canceled`** — a successful cancellation. If instead an
  error `booking not canceled, state="..."` is thrown, the API returned a
  200-echo without a real cancellation (see "How to cancel a booking" below).
- The final `DropReport` (`ok`/`error.kind`) at the end of `run-drop.ts` shows
  whether there was a fallback to a second court and exactly what error occurred
  if the booking failed.

## How to cancel a booking

There is no separate cancel CLI command in `run-drop.ts` yet — use the phase 1
spike script:

```bash
npx tsx spike-reservio.ts --cancel <bookingId> --token <token>
```

Under the hood it is the same as `ReservioClient.cancelBooking`:
`PATCH /businesses/{businessId}/bookings/{bookingId}?token={token}` with the body
`{"data":{"type":"booking","id":"{bookingId}","attributes":{"state":"canceled"}}}`.

Important (see `docs/PROTOCOL.md`):
- Exactly `"canceled"` (one L). `"cancelled"` the API silently ignores and
  returns a 200-echo with the old `state` — verify the cancellation success by
  `data.attributes.state` in the response, not by the HTTP code.
- The cancellation deadline is 1 hour before the slot start.
- `bookingId` and `token` come from the output of `run-drop.ts --live` (a field
  in the `DropReport`) or directly from state (locally `state.db`, in the cloud
  — the `bookings` table in Supabase, see below); the API does not give a guest
  a list of all bookings (`GET /bookings` → 403). In the cloud run's report and
  in Telegram the `token` is intentionally absent.

## Where the state lives

Three implementations of one `StateStore` interface (all methods async):

- `src/core/state.ts` — the interface + `MemoryStateStore` (tests, emergency
  mode). No native dependencies, so the file is safe to include in the cloud
  bundle.
- `src/core/state-sqlite.ts` — `SqliteStateStore` (`better-sqlite3`, WAL). The
  only place with an import of a native module. `src/run-drop.ts` opens
  `./state.db` for `--live` and `./state.dry.db` for dry-run — files in the repo
  root, in `.gitignore` (`*.db`).
- `src/core/state-supabase.ts` — `SupabaseStateStore` (PostgREST over plain
  `fetch`, no SDK). This is the cloud state: a shared table for all trigger.dev
  runs and the future bot. The DDL is `docs/supabase-schema.sql`, which must be
  run once in the Supabase SQL Editor.

The deduplication key everywhere is the same: `(profileId, date, time, court)` —
at most one active record per slot of one profile on ONE court; several bookings
of one profile for the same `(date, time)` but on different courts are a
legitimate case (see "Multi-court evening" below), the unique index does not
block them. A pinpoint check by court is `getBooking(profileId, date, time,
court)`; all bookings of a slot at once —
`listBookingsForSlot(profileId, date, time)`. It is from these that the engine
derives idempotency (`AlreadyBooked`) — which method in which mode, see
"Multi-court evening".

## Bot: seeding profiles and local start

The new Supabase tables of this phase are `profiles`, `schedule_rules`, `skips`,
`settings` (migration `supabase/migrations/20260731110000_bot_core.sql`,
repositories — `src/core/repos.ts`: `ProfilesRepo`/`SchedulesRepo`/`SkipsRepo`/
`SettingsRepo`). This is a separate set of tables from `bookings` — about the
difference between a DB profile and an engine profile see `Bot.md` → "DB profile
vs engine profile".

**Seeding the owner** (once, after the migration is applied in Supabase):

```bash
npx tsx scripts/seed-profiles.ts
```

Idempotently creates (or updates) the `ilya` profile in the `profiles` table
from the same `CLIENT_NAME/EMAIL/PHONE` + `TELEGRAM_CHAT_ID` already in `.env`,
sets `is_admin = true` and — only if the profile has no schedule rule yet —
creates a default one (20:00+21:00, Court 3 → Court 2, every day). A repeat run
updates the profile's contact from env, but does NOT touch the schedule rules:
otherwise the seed would overwrite what has already been configured with the
"⏰ Schedule" button in the bot itself. Other profiles are not created by the
seed — for them there is `/add_profile` (`Bot.md`).

**Local bot start:**

```bash
pnpm bot                    # = npx tsx src/bot/index.ts
```

Needs `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. The bot
works via long-polling — it holds the process; `Ctrl+C` stops it. Until an
unknown `chat_id` is entered into `profiles` (via `seed-profiles.ts` or
`/add_profile` from an admin), the bot answers it with complete silence — this
is intentional behavior, not a bug (`Bot.md` → "Authorization"). Permanent
hosting for the production mode is `Hosting.md` (phase 4, not yet done).

The full list of commands, buttons and the admin flow for adding a second
profile is in `Bot.md`.

## Adding a player: checklist

The full description of the wizard and the invite flow is in `Bot.md` → "Adding
a player: wizard + invite link". Here is the order of actions for the admin.

1. In the bot (from your own, admin chat_id) → "👤 Profiles" → "➕ Add
   profile".
2. Answer the three wizard questions with messages: the player's name, the email
   of their Reservio account (the booking will be tied to it when booking
   manually through the bot), the phone in `+995…` format.
3. Check the summary at step 4 and press "✅ Create".
4. The bot will send a link of the form `https://t.me/<bot>?start=inv_<code>` —
   forward it to the player personally (through the same channel used earlier to
   communicate the `chat_id` — with the link there's now no need to ask for the
   chat_id separately).
5. The player opens the link in Telegram and presses Start — the bot itself ties
   their `chat_id` to the profile and sends a greeting with a menu. From there
   the player configures "⏰ Schedule" (days/times/courts/mode) and "⏭ Skip"
   themselves, without the admin.
6. The link is single-use: if the player has already opened it before or the
   profile is already tied to someone's chat, a repeat visit returns nothing at
   all (this is not a bug — the same silence as for an unknown `chat_id`, see
   `Bot.md` → "Authorization").
7. **The link was lost or didn't work — reissue it with a button.** "👤
   Profiles" → a profile with the line "chat not linked" has a button "🔗
   Link for &lt;name&gt;"; it issues a new code for the same profile. There is
   NO need to create the person again. When this comes in handy:
   - the link was deleted/lost before the first visit;
   - the player presses Start but the bot stays silent, and in the list the
     profile is still "chat not linked": the code was burned but the link was
     not recorded (Supabase fell over between the `claim` and the `upsert`). In
     the process log there is the line `invite: the invite did not go through —
     …`. Cured by exactly the reissue;
   - the wizard replied "⚠️ Didn't work: …" AFTER the profile was already
     created (issuing the code failed) — the profile is in the list, but there
     is no link. Do NOT repeat the wizard, otherwise you'll get a duplicate
     profile: press "🔗 Link".
   If the profile got tied to the wrong chat by mistake — a reissue won't help
   (it has no button, and an invite to an occupied profile is dead by
   construction): clearing `profiles.telegram_chat_id` is only possible in the
   Supabase SQL Editor, after which the button appears again.
8. **For a manual booking through the bot this is enough.** For an AUTOMATIC
   evening drop (`daily-planner`/`book-slot-drop`) of a new profile you also
   need to register its contact in the engine env (`PROFILE_<K>_NAME/EMAIL/
   PHONE`, see `Bot.md` → "DB profile vs engine profile") and, for cloud runs,
   extend the `syncEnvVars` list in `trigger.config.ts` (right now there are the
   fixed seven owner keys, see "Deploy" below) — without this, `book-slot-drop`
   with the new player's `profileId` will fail with "Profile not found".

## Reminders (`remind`)

`src/trigger/remind.ts` — the trigger.dev task `remind`, payload
`{profileId, date, time, court, chatId}`. It is scheduled automatically on a
successful booking — both from `book-now.ts` (booking through the bot) and from
`book-drop.ts` (booking by drop): `tasks.trigger('remind', payload, {delay: <slot
start minus 2 hours, absolute ISO with +04:00>, idempotencyKey:
'remind-'+bookingId})`. The scheduling is wrapped in `try/catch` — if it fails,
the booking itself still stays successful (`bookNow`/`bookSlotDrop` are not
rolled back because of a failed reminder).

At firing time the task **re-reads state first**: if there is no longer a booking
with this `bookingId`, or it is `canceled`, it quietly finishes without a single
message. That is why no separate "cancel the reminder" step is needed on booking
cancellation — `markCanceled` in state is already enough, and the
`idempotencyKey` guarantees that a reminder is scheduled exactly once per
booking. In the CLI (`run-drop.ts`) the reminder is not scheduled at all (there
is no trigger.dev SDK there, and it makes less sense for a one-off manual run) —
this is not an error, there is simply no call.

## Manual launch via trigger.dev (without cron)

The `book-slot-drop` task (`src/trigger/book-drop.ts`, project
`proj_your_project_ref`) is launched **only manually** — via the dashboard, the
`trigger.dev` CLI or `mcp__trigger__trigger_task` with the payload
`{profileId, date, time, live, force?, courts?, mode?}`, including deferred
(`options.delay`). `courts`/`mode` are optional — without them the task takes
them from the profile's `schedule_rule` (details in "Multi-court evening"
below). The task is limited to `concurrencyLimit: 1` (two parallel runs won't
collide) and does not retry automatically; the `token` is NOT printed to the
logs or the run output while it sits in state (the booking can be managed via the
link in the confirmation email). There is one exception: if state degraded and
the token is saved nowhere — then it stays in the run output, otherwise there
would be nothing to cancel the booking with. In the config (`trigger.config.ts`)
there is no `schedules` — this is a deliberate limitation: automatic bookings by
cron are enabled only in phase 4 after explicit user approval (see `CLAUDE.md`).

What the task does besides the drop itself:

- **selects the state**: if `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set
  → `SupabaseStateStore`, otherwise `MemoryStateStore` with a warning. If
  Supabase fell over (no table, wrong key, network), the task **does not
  crash**: it lives out the run on memory and writes the reason into the report.
  The booking matters more than persistence;
- **separates DRY and LIVE**: with `live: false` state is written under the
  profile id `<profile>:dry` (in the report it will be exactly that — `ilya:dry`).
  Otherwise a phantom booking `dry-…` would take the live key
  `(profile, date, time)` and a real run of the same slot would come out with
  `AlreadyBooked` without doing a single `POST` — exactly the same reason
  `run-drop.ts` keeps a separate `state.dry.db`;
- **sends exactly one message to Telegram** per run — success, failure or a
  crash of the run itself; sending is given up to three attempts with a 1.5 s
  pause, so that a random 429/502 doesn't turn the evening into silence. If the
  profile has its own `PROFILE_<K>_TELEGRAM_CHAT_ID`, the report will go to its
  chat — the global `TELEGRAM_CHAT_ID` can then be left unset entirely.

## Evening cloud run

The production scenario: the code lives in trigger.dev, the run is created in
advance with a `delay` to a specific second, the report comes to Telegram. After
that the laptop can be closed — unlike `run-drop.ts`, which holds the process on
the machine.

### 1. What must be ready (once)

- The DDL from `docs/supabase-schema.sql` (the `bookings` table + the unique
  index) is applied in Supabase. Without it the task won't crash, but will fall
  back to memory — see the warnings below.
- In `.env`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID` and `CLIENT_NAME/EMAIL/PHONE` are filled in.
  **`TELEGRAM_CHAT_ID` is the most often forgotten one**: without it
  `telegramFromEnv` returns `null` and the evening passes in silence. The
  easiest way to find your own chat_id is to message the bot and open
  `https://api.telegram.org/bot<TOKEN>/getUpdates`.
- `npx trigger.dev@latest login` (once per machine).

### 2. Deploy

```bash
npx trigger.dev@latest deploy          # environment prod by default
```

(from the agent — `mcp__trigger__deploy` with `environment: "prod"`; there is
also `skipSyncEnvVars` there if the variables need to be left as they are.)

During the build `syncEnvVars` from `trigger.config.ts` runs: it reads the local
`.env` and uploads to the trigger.dev environment **exactly seven** variables —
`CLIENT_NAME`, `CLIENT_EMAIL`, `CLIENT_PHONE`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
Everything else (`TRIGGER_SECRET_KEY_*`, `ANTHROPIC_API_KEY`, local experiments)
stays on the machine. Values are never printed anywhere; if some key is missing,
only its name goes into the build log:
`syncEnvVars: TELEGRAM_CHAT_ID is not set — these variables won't go to the
cloud`. All of them except `SUPABASE_URL` are marked as **secret** — in the
dashboard their value is not shown after being written (this is normal, they are
overwritten on every deploy).

After the deploy, open the **Environment Variables** of the `prod` environment
in the dashboard and visually confirm that the seven variables are in place.
Variables are changed in `.env` → a new `deploy` is needed; they won't pull
through on their own.

### 3. Deferred launch (`delay`)

One run = one slot (in `all` mode — one slot on a WATCH SET of courts, see
"Multi-court evening"). For a 20:00–22:00 game you need **two** runs: the drop of
slot `H:00` happens at `H:59:00 ± 2 s` of day T = date−7 days, and the engine
opens the watch window at `H:58:30`.

The run should be set to start 2–3 minutes before the window: the task's
`maxDuration` is 600 s, and a run started far in advance will simply burn out on
timeout while waiting for the window. The working rule is **`delay` to
`H:56:00` of day T**.

Example for a 06.08 game (watch day T = 30.07):

```jsonc
// mcp__trigger__trigger_task
{
  "taskId": "book-slot-drop",
  "environment": "prod",                     // ← DEFAULT HERE IS "dev"!
  "payload": { "profileId": "ilya", "date": "2026-08-06", "time": "20:00", "live": true },
  "options": { "delay": "2026-07-30T20:56:00+04:00", "ttl": "15m", "tags": ["drop", "20:00"] }
}
// second run — the same with "time": "21:00" and delay "2026-07-30T21:56:00+04:00"
```

Gotchas:

- **`environment` defaults to `dev`.** A run in `dev` executes not in the cloud
  but on your machine, and only while `npx trigger.dev@latest dev` is running.
  For the evening run always `prod`.
- **The task rejects too early a start itself.** If there is more than 4 minutes
  to the window, the run fails with text like "Run started too early: the drop
  window opens at 2026-07-30T20:58:30.000+04:00 … Set the run with delay to
  2026-07-30T20:56:00.000+04:00" — and sends ❌ to Telegram. This is better than
  quietly burning out on `maxDuration`, sleeping through the window. The needed
  `delay` string can simply be copied from that message.
- **`ttl`** is counted not from creation but from the moment the run left the
  `delay` for the queue. The MCP tool's default is `10m`, which is enough; an
  explicit `15m` just removes the question.
- `delay` takes an ISO string with an offset — write **`+04:00`** explicitly,
  don't rely on the machine's timezone.
- A deferred run can be canceled/rescheduled in the dashboard (status `Delayed`)
  or via `runs.cancel` / `runs.reschedule`.
- A rehearsal without a real booking is the same call with `"live": false`. DRY
  writes state under `ilya:dry` and doesn't take the live key, so a rehearsal can
  be run even on the same slot.

### 4. Where to watch the run

- trigger.dev dashboard → project `proj_your_project_ref` → **Runs**, `prod`
  environment. Before firing, the run hangs in status `Delayed`.
- From the agent: `mcp__trigger__list_runs` (`environment: "prod"`,
  `taskIdentifier: "book-slot-drop"`) → `mcp__trigger__get_run_details` with the
  `runId` — the whole log is there: client lines, polling timings, `DropReport`.
- In the logs look for the same things as locally (the "What to look for in the
  logs" section), plus the line `state: Supabase available` — it means the
  storage is alive.
- The booking's `token` is **absent from the logs and the run output by
  construction** — it sits in Supabase and in the confirmation email. The only
  exception: if the report has a `⚠️` about state, it means it is not in
  Supabase, and the token stayed in the run output — save it from there, there
  won't be a second chance.

### 5. What the Telegram report looks like

Success:

> ✅ **2026-08-06 20:00** — profile ilya
> Court: Padel Court 3
> Booking: `e2f1…`
> Speed: 1120 ms from the slot appearing to the booking

Failure (plus a warning about state):

> ❌ **2026-08-06 20:00** — profile ilya
> Reason: the slot appeared, but we didn't manage to book it — it was taken before us
> Details: the slot did appear, but the POST was rejected on all courts (…)
> ⚠️ state is NOT persistent (Memory)

A crash of the run itself (fell before the report appeared):

> ❌ **The drop failed**
> ilya · 2026-08-06 20:00 · LIVE
> The run crashed before the report: …
> The slot is most likely NOT booked — check the run in trigger.dev.

The profile's contacts and `token` are not in the message and must not be.

### 6. What each warning means

| In the message | What happened | What to do |
|---|---|---|
| `⚠️ state is NOT persistent (Memory)` | There is no `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in the cloud — the task worked without shared storage | Check the Environment Variables in the dashboard and redeploy. Until then **do not run the task again on the same slot**: there is no protection against a duplicate |
| `⚠️ Supabase state unavailable (…) — the run finished on memory` | Storage was configured but responded with an error: most often no table (`run the DDL from docs/supabase-schema.sql`) or the wrong key | Run the DDL / check the service key. The booking might have gone through successfully — see the first line of the report |
| `⚠️ … the booking token was NOT saved` | The booking was created, but state degraded: the token didn't make it into Supabase or anywhere else | Take the `token` from the run output in the dashboard and save it by hand — otherwise the booking can only be canceled via the link in the email to `CLIENT_EMAIL` |
| `Reason: the slot appeared, but we didn't manage to book it` (`SlotTaken`) | We reached the `POST`, but the slot was snatched | Nothing is technically broken — this is a lost race. Verify the timings in the logs |
| `Reason: didn't wait for the slot before the deadline` (`Timeout`) | The slot didn't appear during the 5-minute window — either a date miss or the drop model shifted | Check the `date`/`time` payload; if it diverges from the model, record the fact in `docs/PROTOCOL.md` |
| `Reason: looks like the API format changed` (`ApiChanged`) | Reservio replied with something other than what the client expects | Investigate immediately: the phase 1 spike scripts, `docs/PROTOCOL.md` |
| `ℹ️ … Status: a booking for this slot was already created earlier` (`AlreadyBooked`) | Idempotency kicked in: state already has an unresolved record, the slot is booked, the `POST` was deliberately not made | This is normal on a repeat run, no manual booking needed. If the run was the first — check where the record came from |
| The profile in the report looks like `ilya:dry` | This was a DRY run (`live: false`) | There is no real booking. For a real one — `"live": true` |
| No message at all | `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` didn't make it through, or Telegram didn't respond to any of the three attempts | Check the run log: `Telegram not configured …` or `Telegram: report NOT delivered in 3 attempts …`. The drop result is always in the logs and in the run output |

## Multi-court evening: watch set of courts (`all` mode)

The club keeps Padel Court 2 and 3 occupied at 20:00–22:00 most days of the week
(the club's admin block, confirmed 31.07.2026 — `docs/PROTOCOL.md` → "SOLVED"),
and 20:00/21:00 may not come out in the drop on either of the "home" courts at
all. That is why the evening run is done not by the priority of a single court
but by a watch set: for each hour of the pack 20:00+21:00 one `book-slot-drop`
run is created that polls SEVERAL courts at once
(`{Padel Court 3, Padel Court 4, Padel Court 1}` by default) and books EVERY one
that appears in the drop, not just the first.

### Payload

```jsonc
// mcp__trigger__trigger_task
{
  "taskId": "book-slot-drop",
  "environment": "prod",
  "payload": {
    "profileId": "ilya",
    "date": "2026-08-07",
    "time": "20:00",
    "courts": ["Padel Court 3", "Padel Court 4", "Padel Court 1"],
    "mode": "all",
    "live": true
  },
  "options": { "delay": "2026-07-31T20:56:00+04:00", "ttl": "15m", "tags": ["drop", "20:00", "multicourt"] }
}
// second run — the same with "time": "21:00" and delay "…T21:56:00+04:00"
```

`courts`/`mode` are optional — without them the task takes them from the
profile's `schedule_rule` (legacy compatibility with old runs and with manual
runs without a DB). `daily-planner` passes them EXPLICITLY, together with
`force: true`: the evening plan is decided in the scheduler, and the drop must
run exactly the scenario that landed there. A separate manual run on top of a
planned one is NOT needed — it will queue behind it (`concurrencyKey =
profileId`, `concurrencyLimit = 1`) and arrive at an already-closed window.

- **`mode: "priority"`** — the old behavior: goes through the court list in
  order, idempotency by the whole slot (`listBookingsForSlot` — there is ANY
  confirmed booking of the slot → the `POST` is not made at all), the first
  successful `POST` ends the run.
- **`mode: "all"`** — the new one: per-court idempotency
  (`getBooking(profile, date, time, court)` — an already-booked court is simply
  skipped, the rest keep participating), on a slot appearing on a court — an
  immediate `POST` for that court, the run continues until the deadline as long
  as at least one un-booked court remains in the set.

As before — **exactly one `POST` attempt per court per run**. An ambiguous
`POST` failure of one court (timeout/drop/`5xx`/`2xx` without `data.id`) in `all`
mode does NOT block the rest of the watch set (unlike `priority`, where it stops
the whole drop) — it is simply flagged separately in the report for that court,
because a booking on it might have been created on the server. Success of an
`all`-mode run is at least one booking out of the set.

### Idempotency and legitimate duplicates

The unique index in state is `(profile_id, date, time, court)`, not
`(profile_id, date, time)`: several confirmed bookings of a profile for the same
time but on DIFFERENT courts are legitimate and nothing blocks them — this is
exactly the goal of the watch (assemble a pack on at least one court, and if
lucky — on several at once, the owner will sort it out). `getBooking(profileId,
date, time, court)` is a pinpoint check for a specific court;
`listBookingsForSlot(profileId, date, time)` is all bookings of a slot at once,
used by `mode: "priority"` for the old "any booking of the slot exists — no
`POST`" idempotency.

### Telegram report

To the usual report ONE line "Courts: …" is added — a summary over the whole set
(only when there is more than one court in the set):

> ✅ **2026-08-07 20:00** — profile ilya
> Court: Padel Court 3
> Booking: `booking-c3`
> Speed: 743 ms from the slot appearing to the booking
> Courts: ✅ Padel Court 3 (743 ms), Padel Court 4 (1.2 s) · ❌ Padel Court 1 — the slot didn't appear before the deadline

The root "Court/Booking/Speed" is the FIRST booking of the run (compatibility
with phase 2), the full picture is always in the "Courts:" line. If not a single
court of the set is booked — the report is ❌, as before.

A separate `⚠️` line carries a warning about an **ambiguous `POST` failure**
(timeout/drop/`5xx`/`2xx` without `data.id`): a booking on that court might have
been created on the server, but the id/token didn't reach us. It appears even in
a green report — when a neighboring court booked but this one fell over — and
requires a manual check of the profile's email and the club: a phantom booking
must be canceled in time, an hour before the slot.
A reminder (`remind`) is set on EVERY successful booking by its `bookingId` — for
a pack 20:00+21:00 caught on two courts, the player will get two reminders, one
per booking; this is expected, not a duplicate (see "Reminders" above).

### Manual cleanup of extras

If the watch booked a pack on several courts at once (e.g. both 20:00 and 21:00
were caught on Court 3 and Court 4) — that is NOT a bug, it is by design: the
engine does not cancel bookings itself, the decision of which court to keep is
the owner's. Check "📅 My bookings" in the bot and cancel the extras via "❌
Cancel booking" (or directly via the API) — the cancellation deadline as usual,
1 hour before the slot (see "How to cancel a booking" above).

### Schedule builder

The court set and the mode (`priority`/`all`) are configured in the bot itself —
"⏰ Schedule" → the scenario create/edit wizard, step 3 (courts) and step 4
(mode). Screen details are in `Bot.md` → "⏰ Schedule: scenario builder".

⚠️ Disabling or deleting a scenario does NOT cancel a run already set for today:
the scheduler sends `book-slot-drop` at 20:30 with all parameters in the payload,
and the run itself re-reads only the skips. To not book today — "⏭ Skip" on the
game date (or cancel the run in the trigger.dev dashboard).

## Scheduler (`daily-planner`, disabled by default)

`src/trigger/daily-planner.ts` — the trigger.dev task `daily-planner`, scheduled
on cron `30 16 * * *` (UTC) = **20:30 Tbilisi time**. Conceived as an automatic
replacement for the manual setup of two deferred runs from the section above:
every evening it finds the applicable `schedule_rule`s itself and sets
`book-slot-drop` with the needed `delay` itself.

**By default — a no-op.** The first line of `run()`: if
`SettingsRepo.get('planner_enabled') !== 'true'` — the task logs "scheduler
disabled" and finishes without touching a single profile. This is a deliberate
limitation (`CLAUDE.md`): automatic bookings by cron are enabled only in phase 4
and only after explicit user approval. The flag is toggled manually — with a row
in the `settings` table (Supabase SQL Editor:
`update settings set value = 'true' where key = 'planner_enabled';`, insert the
row if it isn't there yet); there is no separate bot command for this yet.

When the flag is enabled, for each `enabled` rule whose profile has a
`telegram_chat_id`, which applies to date T+7 (`ruleAppliesOn`) and for which
there is no `skip`, the task: (1) sends a pre-drop message to the profile's
Telegram with the plan and the buttons "⏭ Skip" / "✅ Book" (the buttons are
handled by `src/bot/handlers/*.ts` — "Skip" writes a `skip`, "Book" does
nothing, that's already the default behavior); (2) for each (profile, hour) sets
`tasks.trigger('book-slot-drop', {profileId, date, time, live: true, force:
true, courts, mode}, {delay: ..., idempotencyKey:
'drop-{profileId}-{date}-{time}-{ruleIds}', concurrencyKey: profileId})` — the
same task and the same "`delay` to `H:57:00`" principle as in the manual setup
above.

If a profile has SEVERAL enabled scenarios for the same hour, they collapse into
ONE run: the court set is the union (the priority order of the first scenario is
preserved), the mode is `all` if at least one asked for it. Otherwise two runs
would queue one behind the other (`concurrencyLimit = 1` on `concurrencyKey =
profileId`), the second would arrive at an already-closed window, wouldn't make a
single poll — and would send a second ❌-report for the evening, against the
"exactly one message" invariant.

`book-drop.ts` itself, before the window starts, checks the `skip` once more: if
the day was skipped after the run was set, no booking is made, and a report
"skipped by command" goes to Telegram — the third permitted state of the evening
message from the observability invariant in `CLAUDE.md`.

Disabling the flag in the evening does NOT withdraw runs already set — they will
run and book a court. Heartbeat accounts for this: it looks at the
`planner_last_run` mark for today, not at the current flag value, and keeps
demanding a report for every set slot (otherwise an extra 80 GEL booking would
go unnoticed; it can be canceled no later than an hour before the slot). To
really keep the evening from booking, the run must be canceled in the trigger.dev
dashboard or a `skip` set on the game date.

Do not enable `planner_enabled` without going through the checklist below and
without watching the first runs.

**Status: enabled 04.08.2026** (`settings.planner_enabled = 'true'`, the
production cron approved by the user — see `CLAUDE.md`, `PLAN.md` → Phase 4).

## Heartbeat (`heartbeat`)

`src/trigger/heartbeat.ts` — the trigger.dev task `heartbeat`, cron `12 18 * * *`
(UTC) = **22:12 Tbilisi time**, deliberately after both evening drops
(~20:59:00 and ~21:59:00) and their Telegram reports. This is the last line of
the observability invariant from `CLAUDE.md` ("a silent failure is the worst bug
of this project"): `daily-planner` and `book-slot-drop` try not to go silent on
their own, and the heartbeat catches the cases where it is precisely they that go
silent — the scheduler didn't run, a report wasn't recorded, Telegram didn't
deliver a message, or the bot process itself died.

### Before the first run: migration

The `drop_reports` table appears via the migration
`supabase/migrations/20260804140000_heartbeat.sql` — **it must be applied in
Supabase BEFORE deploying the tasks** (CLI or SQL Editor: the whole file
contents, it is idempotent — `create table if not exists` + `notify pgrst`).
Without it, `book-slot-drop` gets `PGRST205` in `recordReceipt` on every slot
(bookings and Telegram reports still work: recording the receipt is best-effort),
and the heartbeat at 22:12 sends "receipts for {date} could not be read …" every
night until the table is created.

### What is checked every evening

1. **`planner_last_run` for today.** `daily-planner` at the end of EVERY
   successful run writes to `settings` the mark `tbilisiStamp(now)` — with the
   scheduler disabled, prefixed with `disabled@` (it also "ran", it just did
   nothing). No mark for today's date → "the scheduler didn't run today". The
   check is skipped only if the scheduler is disabled AND there is no today's
   mark at all (there was nothing to book).
2. **Expected reports of the evening.** Whether to expect receipts is decided NOT
   by the current value of `planner_enabled` (the flag is toggled by hand at any
   hour, including between 20:30 and 22:12) but by today's `planner_last_run`
   mark: with the `disabled@` prefix — the evening was not planned, the check
   stays silent; without the prefix — the evening was planned, and receipts must
   exist even if the flag has since been removed (a removed flag does not
   withdraw a SET run — it will run and book a court). If there is no today's
   mark at all → we go by the flag.
   The list of expected `(profile, time)` is taken from
   `settings.planner_last_plan` — that is what the scheduler ACTUALLY set at
   20:30 (see below). From the plan, the hours whose drop hasn't closed by 22:12
   are dropped (computed from the time, not hardcoded as a list — right now that
   is effectively `20:00`/`21:00`).
   - No row in `drop_reports` for `targetDate` on an expected `(profile, time)` →
     "no report for {time} (profile {label})".
   - The row exists, but `telegram_ok = false` → "the report for {time} was not
     delivered to Telegram".
3. **Bot liveness** — does not depend on `planner_enabled` (the bot must answer
   commands regardless of the scheduler), but is enabled EXPLICITLY: with the row
   `bot_alive_required = 'true'` in `settings`. As long as the bot process is not
   on permanent hosting (`PLAN.md` → phase 4, `Hosting.md`), it lives on the
   owner's laptop and is started by hand (`pnpm bot`) — an enabled check would
   alert every night, including after a perfectly worked evening, and real
   findings in the same message would start getting swiped away unread. Enable
   the flag — as a step of the hosting deploy:
   `insert into settings (key, value) values ('bot_alive_required','true')
   on conflict (key) do update set value = excluded.value;`
   After enabling: `src/bot/alive.ts` pings `getMe()` once every 5 minutes and,
   if Telegram answered, updates `settings.bot_alive_at`. No mark or one older
   than 15 minutes → "the Telegram bot shows no signs of life since {stamp}". The
   probe is specifically `getMe`, not a bare timer: a process that lost its route
   to `api.telegram.org` stays alive (grammY retries `getUpdates` forever) and
   would report "alive" while being deaf.

### The evening plan (`planner_last_plan`)

`daily-planner`, after setting the drops, writes to `settings` the key
`planner_last_plan` — a compact JSON `{date, at, slots:[{profileId,time}]}` with
the list of set runs (including those whose `tasks.trigger` failed: it is exactly
about those that the watchdog is obliged to speak). The heartbeat reconciles the
receipts against precisely it.

Why, given there are `schedule_rules`: the schedule and the skips are edited by
the owner the WHOLE evening. Remove a skip from date T+7 at 21:00 (the first
button of the "⏭ Skip" menu is exactly this date) or create a new scenario in
the "⏰ Schedule" wizard — and the watchdog, reconstructing the plan from the
live rules at 22:12, would demand reports for drops that nobody set.

If there is no plan for the needed date (the scheduler crashed before recording,
the deploy is older than this branch, the value is unreadable) → the heartbeat
goes to a FALLBACK path: it reconstructs the plan from the live
`schedule_rules`/`skips` with the same selection logic as the scheduler
(`selectEligibleRules` + `splitTimesByDrop` — the applicability rules are not
duplicated as a separate copy). In the run output this shows up as a check line
for `planner_last_plan` with status `skipped` and the reason.

### Receipts (`drop_reports`)

After delivering (or failing to deliver) the evening report, `book-slot-drop`
(`src/trigger/book-drop.ts`) best-effort writes a row to `drop_reports`
(`DropReportsRepo.record`) — `{profileId, date, time, ok, telegramOk,
createdAt}`. The write is wrapped in its own `try/catch`: a failure to record the
receipt is only logged, the `book-slot-drop` run itself doesn't crash and the
Telegram behavior doesn't change. `drop_reports` is a secondary trail
specifically for the heartbeat, not a source of truth about the booking (the
source of truth is still `bookings`/state and the `DropReport` in the run
output).

### How the alert is delivered

If there are no problems — only `logger.info`, not a single message to Telegram
(silence is a healthy evening). If there is at least one problem — ONE message to
all profiles with `isAdmin = true` and a filled-in `telegramChatId`
(`sendTelegram` directly, three attempts with a pause — the same delivery pattern
as in `book-drop.ts`; no secrets or tokens in the text). If sending the alert
itself failed after three attempts, the task throws an exception: the `heartbeat`
run explicitly fails and is visible in the trigger.dev dashboard as `FAILED`.
This is the last line of defense: even if Telegram is entirely unavailable, there
will be no silence — there will be a red run visible in the dashboard. The run
output is a structural list of the performed checks and the outcome, not just the
message text.

### What to do on each alert

| Alert | What happened | What to do |
|---|---|---|
| "the scheduler didn't run today" | `daily-planner` didn't launch (the cron didn't fire) or crashed before the line recording `planner_last_run` | Check the `daily-planner` run for today in the trigger.dev dashboard (`mcp__trigger__list_runs`, `taskIdentifier: "daily-planner"`) — status and log; check `settings.planner_enabled` and the availability of Supabase |
| "no report for {time} (profile {label})" | Either `book-slot-drop` for this `(profile, time)` was not launched (a failure while setting it up in `daily-planner`), or the run went through but recording the receipt in `drop_reports` failed (best-effort, doesn't crash the run) | Find the `book-slot-drop` run for the needed `date/time/profileId` in the dashboard — if there is no run, check the `daily-planner` log; if there is a run, verify the booking fact by the `DropReport` in the run output and by the Telegram message — the receipt is secondary |
| "the report for {time} was not delivered to Telegram" | `book-slot-drop` finished (`telegram_ok = false` in `drop_reports`), but the report didn't arrive in any of the three attempts | Check the drop result in the output/log of the specific `book-slot-drop` run (the `DropReport` is always there), not only in Telegram; check `TELEGRAM_BOT_TOKEN` and the availability of the Telegram API |
| "the Telegram bot shows no signs of life since {stamp}" | The bot process (`src/bot/index.ts`) is not running, crashed, the hosting restarts it in a loop — or the process is alive but lost its connection to `api.telegram.org` (the `getMe` probe doesn't pass, and the mark is deliberately not updated) | Check the status of the bot's process/deploy at the hosting (`Hosting.md`) and the logs: the line "Telegram not responding…" means a host network problem, not a crash. After recovery `bot_alive_at` will update within the first seconds. If the bot is deliberately kept off — remove `settings.bot_alive_required` instead of enduring a nightly alert |
| "receipts for {date} could not be read … PGRST205" | The migration `20260804140000_heartbeat.sql` was not applied — there is no `drop_reports` table in Supabase | Apply the migration (see "Before the first run: migration" above) and check that the evening `book-slot-drop` runs stopped writing "the evening receipt was not recorded" to the log |
| The `heartbeat` run itself `FAILED` in the dashboard, no message in Telegram | Either Telegram is entirely unavailable (all three attempts to deliver the alert failed), or a bug in the task itself | Check the log of the crashed `heartbeat` run in the dashboard — the exception is not swallowed, deliberately for this case |

## Evening production run checklist

1. 30–40 minutes before the drop: `.env` is filled in and current
   (`CLIENT_*`/profiles, `SUPABASE_*`, `TELEGRAM_*`), the `bookings` AND
   `drop_reports` tables exist in Supabase. No `drop_reports` — apply
   `supabase/migrations/20260804140000_heartbeat.sql` BEFORE the deploy
   (otherwise the evening passes without receipts, and the heartbeat will alert
   every night; see "Heartbeat" → "Before the first run: migration").
2. Check `docs/PROTOCOL.md`/`PLAN.md` for open blockers for today's run.
3. `pnpm test && pnpm typecheck` → `npx trigger.dev@latest deploy`, then verify
   the Environment Variables in the dashboard (seven variables).
4. Rehearsal: the same `trigger_task` with `"live": false` on the nearest drop —
   it checks the availability of Supabase, the report format and delivery to
   Telegram, without creating a booking and without taking the live key
   (`ilya:dry`).
5. Set two production runs with `delay` to `H:56:00` of day T — for `20:00` and
   for `21:00` (these are two independent drops, ~20:59:00 and ~21:59:00). For a
   pack on C2/C3-blocked evenings use the multi-court payload
   (`courts`/`mode: "all"` — see "Multi-court evening" above) instead of the
   priority of a single court.
6. Wait for two messages in Telegram. Exactly two: one message per run — the
   observability invariant from `CLAUDE.md`. Silence = a bug, go into the run
   logs.
7. After the booking — wait for the email to `CLIENT_EMAIL`, verify the court and
   time.
8. If something went off-model (the slot appeared outside the expected window,
   other API behavior) — record the fact in `docs/PROTOCOL.md`, don't rely on
   memory.

Local alternative (when the cloud is unavailable or full control is needed):
`npx tsx src/run-drop.ts --profile ilya --date <T+7> --time 20:00 --live`, run no
more than a day before the drop — the script will itself wait for the `H:58:30`
window of day T, but requires that the machine not fall asleep.

⚠️ **Before this, withdraw the deferred run in trigger.dev** (or wait for its
report). With `SUPABASE_*` set, the CLI looks at the same table and will see the
cloud booking (`AlreadyBooked`, not a single `POST`) — but with `--sqlite` or
without `SUPABASE_*` this protection doesn't work, and the slot will end up with
two real bookings of 80 GEL each. Silence in Telegram ≠ the absence of a booking:
first look at the run in the dashboard.
