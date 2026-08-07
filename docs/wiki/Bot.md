# Bot

The bot's inbound Telegram interface (`src/bot/`, grammY, long polling). It
complements the outbound drop reports (`core/notify.ts`, see `Runbook.md` →
"Evening cloud run") — a profile can now not only receive messages but
also manage its bookings and schedule through commands and buttons.

Status: all phases implemented (`PLAN.md`). The auto-booking planner
(`daily-planner`) is **disabled by default in code** and turned on per
deployment via `settings.planner_enabled` — see `Runbook.md` → "Scheduler".

## Running

```bash
pnpm bot                    # = npx tsx src/bot/index.ts
```

You need `TELEGRAM_BOT_TOKEN` (the same one used for outbound reports) and
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the repositories for profiles,
schedules, skips, and settings — `src/core/repos.ts`). Before the first run,
seed the owner profile: `npx tsx scripts/seed-profiles.ts` (details in
`Runbook.md`).

The bot runs on long polling (not webhooks): the process must stay up
continuously, otherwise inbound commands are lost silently. Options for
always-on hosting are in `Hosting.md`.

## Authorization: chat_id allowlist

`src/bot/auth.ts` is the first middleware in the chain. On every update:

```
profile = await profiles.getByChatId(String(ctx.chat.id))
```

No profile with that `telegram_chat_id` in the `profiles` table → the bot
answers with **complete silence**: not a single message, only a debug log with
no chat_id in production. This is by design (`CLAUDE.md` → «Мультипрофили»):
the bot can be found in Telegram search, but only someone whose chat_id an
admin has entered in advance can actually use it. If a profile exists, it is
placed in `ctx.state.profile` and is available to every handler further down
the chain.

No passwords, confirmation codes, or OAuth — the only "secret" in the system is
the `telegram_chat_id` itself, which the admin obtains from the person in
person (outside the bot) and enters with `/add_profile`.

**Commands are accepted only from a private chat.** The bot ignores updates
from a group/supergroup even if that group's id is in
`profiles.telegram_chat_id`: any member of the group can post under it, so it is
no good as proof of identity. This matters because since phase 2
`TELEGRAM_CHAT_ID` is the address for OUTBOUND reports, and that may well be a
group; `scripts/seed-profiles.ts` writes the same value into the owner profile
and warns if it is a group. Sending reports and reminders to a group still
works as usual.

The assembly order ("auth first, handlers after") is fixed in
`src/bot/setup.ts` and checked by the `tests/bot-auth.test.ts` tests: a handler
registered before the middleware would answer a stranger's chat.

## Menu

Reply keyboard (`src/bot/menu.ts`):

```
[📅 My bookings] [🔍 Slots]
[📆 Book]        [❌ Cancel]
[⏭ Skip]        [⏰ Schedule]
                 [👤 Profiles]     ← is_admin only
```

A regular (non-admin) profile has no Profiles button at all; if such a profile
nonetheless sends `/add_profile` by hand, the command stays silent — exactly as
if a completely unknown chat_id had sent it.

## Handlers

Message formatting and command parsing are pure functions (`src/bot/format.ts`,
`src/bot/parse.ts`) with vitest tests; the handlers (`src/bot/handlers/*.ts`)
are a thin glue layer between the grammY context and those functions plus calls
to `ReservioClient`/the repositories.

**📅 My bookings** — `listBookings(profileId)` from state, only records with
`state !== 'canceled'` and only future ones (date+time ≥ now in Asia/Tbilisi).
Row format: `date time court`.

**🔍 Slots** — inline chain: date (today…T+7) → court (all six club courts from
`BOOKABLE_COURTS` — 4 padel courts and Park Court 1/2) → the list of free slots
for that day/court from `ReservioClient.getAvailability`. View only, no booking.

**📆 Book** — date → court → time (already drawn from the court/day's actually
free slots, not from every possible hour) → confirmation (inline "yes"/"no") →
`bookNow(profile, {date, time, court}, deps)` (`src/core/book-now.ts`) → a reply
with the outcome: success with the booking number (and a reminder automatically
scheduled 2 hours ahead) or a human-readable reason for refusal — the slot is
already taken, or the same profile already has an active booking for it.

**❌ Cancel** — the list of the profile's future `confirmed` bookings → pick →
confirm → `client.cancelBooking(bookingId, token)` (`token` comes from the
stored record in state and is never shown in chat) → `state.markCanceled` +
reply. The cancellation deadline is one hour before the slot starts
(`docs/PROTOCOL.md`); if it has already passed, the bot says so in human terms
("can't cancel anymore — less than an hour to game time") rather than a raw API
error.

**⏭ Skip** — the next 7 dates, each marked with whether the profile skips that
day (the `skips` table; a skip covers a whole day, not a single slot). A tap
toggles it: skipped → clear (`SkipsRepo.remove`), not skipped → set
(`SkipsRepo.add`). While the loop is still manual (phase 3), the button is a
placeholder for the auto-planner: once `daily-planner` is enabled (phase 4), the
very same button will arrive on its own in the pre-drop message every evening.

### ⏰ Schedule: scenario builder

Before (phase 3): a flat list of the profile's rules, toggled on/off with a tap.
Now (this PR): a full CRUD wizard with breadcrumbs and a "⬅️ Back" button — the
same UX pattern as "📆 Book" (a wizard step is editable state carried in
`callback_data`, with NO server-side state; the wizard style was fixed by commit
`a08faa8` "breadcrumbs on every step + Back button").

**Scenario list** (`SchedulesRepo.listByProfile`) — for each: `label` (the
scenario name), days of week, times, courts, mode, on/off. Per-scenario buttons:
`[on/off]` `[✏️]` `[🗑 delete]` (deletion goes through an intermediate
confirmation, like "❌ Cancel"). The `[➕ New scenario]` button launches the same
wizard as editing, with empty state.

**Wizard (create and edit share one flow)**, 5 steps, breadcrumbs on each
("Step N of 5: …") and "⬅️ Back" on every step but the first:

1. **Days of week** — multi-select with checkmarks (0=Sun … 6=Sat) + "every day"
   (equivalent to an empty `days_of_week`, book every day) + "Done".
2. **Times** — multi-select from the grid of hourly slots 07:00–23:00 + "Done".
   If an edit has an hour checked outside this grid (a rule created via
   `/add_rule`, which accepts any `HH:MM`), the wizard also renders a button for
   it — otherwise that checkmark could not be cleared and the edit would
   silently put the extra hour back in the database.
3. **Courts** — multi-select from `BOOKABLE_COURTS` (all six club courts — 4
   padel courts and Park Court 1/2, the same set as in "🔍 Slots"/"📆 Book") +
   "Done".
4. **Mode**: "first available by priority" (`mode: 'priority'`, order = the order
   the courts were selected in step 3, the old behavior) / "book every one that
   appears" (`mode: 'all'`, the watch set — see `Runbook.md` →
   "Multi-court evening").
5. **Confirmation** — a summary (days, times, courts, mode, label) + a Save
   button. Below the summary, a note for the owner: "a booking is caught at the
   moment of the drop: the slot for hour H opens at H:59:00, 7 days out" (the
   same figure as in `docs/PROTOCOL.md`) — so the source of the race timing is
   visible.

**Encoding the wizard state in `callback_data`** (Telegram's 64-byte limit; the
wizard keeps no server-side state): the multi-selects are bitmasks — 7 bits for
days of week, 6 bits for courts (one per court in `BOOKABLE_COURTS`), 24 bits for
times (one per hourly slot) — in hex. The wizard step, the `ruleId` (for the
edit flow), and all the bitmasks ride together in a single `callback_data` — the
same principle as the date/court in the "📆 Book" wizard.

**Label** — the scenario name. The wizard does not ask for it and does NOT write
the `label` column: the caption is computed on the fly from the times and
courts — `"20:00+21:00 · C3,C4,C1"` (times joined with `+`, courts abbreviated
and comma-separated). That way it always matches the content: a stored
auto-name would stay the same after an edit and the button in the list would lie
(the owner turns a scenario off by tapping its name). A name a human set
directly in the DB is not overwritten by an edit — it keeps showing instead of
the auto-name.

**A double tap on "💾 Save"** creates no duplicate: the button is stateless (a
new scenario has an empty `ruleId` in `callback_data`), so before inserting, the
handler looks among the profile's scenarios for an exact match on
times/courts/days/mode and updates it — the same protection as `/add_rule`.
Otherwise you would get two identical enabled scenarios: two pre-drop messages
per evening and one extra run.

**Turning off or deleting a scenario does not cancel a drop already scheduled
for today** (`daily-planner` sends a run at 20:30 with all parameters in the
payload, and `book-slot-drop` re-reads only the skips). The screens say this
outright: the only lever for the current evening is "⏭ Skip" on the game date.

**Compatibility and authorization**: old `callback_data` (the flat list with one
on/off per rule, before this PR) keeps working with no client migration; an
unknown `chat_id` at any wizard step gets silence, as everywhere else in the bot
("Authorization" above).

**`/add_rule`** remains the admin fallback for manual entry without the wizard;
the format is extended with a mode (an optional last segment, defaulting to
`priority` — old calls without it don't break):

```
/add_rule profile_id;20:00,21:00;Padel Court 3,Padel Court 4,Padel Court 1;1,2,3,4,5;all
```

⚠️ The contact (`name/email/phone`) is still taken by the engine ONLY from the
env profile (`CLIENT_*`/`PROFILE_<K>_*`, see "DB profile vs engine profile"
below) — this did not change in this PR. But `courts`/`mode` are no longer just
the text of the pre-drop message: `book-slot-drop` accepts them straight from the
payload (`courts?: string[]`, `mode?: 'priority' | 'all'`) — and `daily-planner`
sends them EXPLICITLY together with `force: true`; if the payload does not carry
them (a manual run, old runs), the task pulls them from the profile's
`schedule_rule` in the DB. The court set and mode configured in the "⏰ Schedule"
wizard now actually drive the drop, not just the notification text — the old
mismatch "the message promises one court but the bot takes another" for
`courts`/`mode` is closed. A contact for a new player must still be set up by
hand in env, separately from the DB profile (see the table below).

**👤 Profiles** (`is_admin` only; otherwise the button is absent and the command
itself is silent):

- a list of all profiles (`ProfilesRepo.list()`);
- `/add_profile id;label;name;email;phone;chat_id` — upsert a profile.
  `chat_id` may be left empty (a profile with no bot access, e.g. a test one).
  The format and the hint on a parse error are right in the command's reply;
- `/add_rule profile_id;20:00,21:00;Padel Court 3,Padel Court 4,Padel Court 1;1,2,3,4,5;all` —
  upsert a schedule rule. Days of week (empty = every day) and mode
  (`priority`/`all`, default `priority`) are the last two segments, both
  optional. Days use the same 0–6 (Sun=0) as everywhere in the project
  (`weekdayOf` in `core/scheduler.ts`). The full field description, and the same
  thing via the button wizard, is in "⏰ Schedule: scenario builder" above.

Tokens, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, and any other secrets
never reach the chat under any scenario — they are neither in the formatters nor
in the handlers' error texts. The chat_id of other profiles is not logged even
in debug (see "Authorization" above).

### Adding a player: wizard + invite link

Before this PR, a second profile could only be created by hand — the admin asked
the player for their `chat_id` outside the bot and put it into `/add_profile`.
The "➕ Add profile" button in "👤 Profiles" (`is_admin` only, like this whole
branch) removes that step: the player binds their own `chat_id` by following a
one-time invite link.

**The wizard is step-by-step text entry** (via messages, not inline buttons,
except for the final confirmation):

1. "Player name (shown in lists)" → `label` and `name`.
2. "The player's Reservio account email" → the same validation (`EMAIL_RE`) as
   in `/add_profile` (`src/bot/parse.ts`).
3. "Phone (+995...)" → the same validation (`PHONE_RE`) as in `/add_profile`.
4. A summary of the entered data + inline buttons "✅ Create" / "❌ Cancel".

On "✅ Create": a profile is created (`id = 'p' + 8 hex`, `is_admin = false`,
`telegram_chat_id = null`), an invite code is generated for it
(`InvitesRepo.create(profileId)`), and the admin receives:

> Profile created. Send the player this invite link:
> `https://t.me/{bot_username}?start=inv_{code}` — following it, the bot will
> bind their chat and open the menu

`bot_username` comes from `ctx.me.username` (not hardcoded — the same bot can run
under different names in dev/prod).

**The wizard state** is in `src/bot/wizard-state.ts`, an in-memory `Map` keyed by
the admin's `chat_id`, TTL 15 minutes. "❌ Cancel" and the `/cancel` command
clear the draft explicitly. **A bot restart loses the draft** (it is in-memory,
not a table) — if the admin was mid-step during a redeploy, they have to start
over. While the admin has an active draft, the wizard "eats" their ordinary text
messages (interpreting them as the answer to the current step); the reply-menu
buttons keep working as usual meanwhile and also clear the draft along the way —
with an explicit note that it was canceled, so unfinished input isn't lost
silently.

An expired draft is explained exactly once ("it lives 15 minutes, start over")
and only to its owner — on their NEXT message. The memory sweep, however, runs
over all drafts at once (otherwise a stranger's abandoned wizard would hang in
the process forever, along with the player's email and phone), but the hint is
tied to the owner of each swept draft: with two admins, one's activity must not
leave the other without a reply to their own input. The bot sends no unprompted
messages while doing this — it only replies.

Email and phone are personal data, so they are not logged (see the privacy note
in `src/bot/handlers/profiles.ts`), but at step 4 the summary shows them to the
admin in full: they just entered them themselves, so it is not a leak.

**Accepting the link** (`src/bot/auth.ts`) is the one deliberate exception to
"unknown chat_id gets complete silence" (see "Authorization" above): a private
chat with no profile of its own, text exactly `/start inv_<code>`.

1. `InvitesRepo.claim(code, chatId)` — an atomic `PATCH … used_at
   WHERE code=eq AND used_at=is.null`. An empty response (the code doesn't exist
   OR it is already used — indistinguishable from the outside) → **silence**: we
   don't reveal to a stranger even that the bot is alive.
2. Success → the profile by `profileId`. If it ALREADY has a
   `telegram_chat_id` (the link was forwarded to the wrong person, or reused
   after being handed to the player) → also **silence**: an invite to an
   occupied profile is dead.
3. Otherwise — the profile's `telegram_chat_id` is set to the current `chatId`,
   and the reply is a greeting (the profile name, a short "what the bot does")
   plus the ordinary menu ("📅 My bookings" / "🔍 Slots" / "📆 Book" etc., with
   no "👤 Profiles" — a new profile is not an admin).

If a `chat_id` already bound to some profile sends `/start inv_<code>`, the
invite is ignored — it is an ordinary `/start` (re-triggering someone else's
link from your own chat changes nothing, the profile does not move). In
`src/bot/setup.ts` the invite branch sits BEFORE the general allowlist check —
otherwise the chat-specific code would never be reached.

The code is one-time (`used_at` is set atomically on the first successful
`claim`): a double tap on the same invite link — the very race `claim` resolves —
leads to exactly one binding; the second tap sees `used_at` already set and gets
silence, as in point 1.

**Reissuing the link.** In the "👤 Profiles" list, every profile WITHOUT a bound
chat has a "🔗 Link for &lt;name&gt;" button (`handlers/profiles.ts` →
`reissueInvite`): it issues the same profile a new code and sends the ready link
as a separate message — convenient to forward to the player whole. There is no
need to create the person again.

This is not a convenience but a fix for three real cases:

- the link was lost (the message deleted, the chat cleared) before the first
  visit;
- the player opened the link, `claim` already consumed the code, but the
  `telegram_chat_id` write did not go through (Supabase timed out): the code is
  dead, the profile is left with no chat, and the player got silence — you can
  learn this only from the process log and from the "chat not bound" row in the
  list;
- the profile was written but the code issuance right after it failed — then the
  admin sees "⚠️ Couldn't…", while the profile is already in the database.

A profile with a chat ALREADY bound gets no button rendered, and one pressed from
an old message issues no code (the reply is "chat already bound"): an invite to
an occupied profile is dead anyway, and an extra live code is an extra secret.
The previous link, if not yet opened, stays valid: whichever is opened first
wins, the second is dead after the binding.

After binding, the player configures themselves without the admin: times and
courts via the "⏰ Schedule" button (the scenario wizard above), skipping a
specific day via "⏭ Skip". The admin is no longer needed at this stage — except
for the env contact, see the next section.

## Free-form queries

Phase 5 (`PLAN.md`), the base part. Besides the menu and wizards, an authorized
profile can write to the bot in plain text — "find 2 hours in a row on Saturday
afternoon", "is there a 20:00 on Friday on court 4?" — and get the same search
and confirmation screens as from the buttons. Path A from `CLAUDE.md`: the LLM
here is ONLY a parser of text into structure, no text from the model to the user
and no booking decisions by the model. A booking is still created only through a
human confirmation button on an EXISTING screen ("📆 Book" above) — free-form
text is one more way to reach it, not a new way to book.

**Priority for handling inbound text** (`src/bot/handlers/index.ts`):

1. an active wizard draft (a profile or a schedule scenario) — it "eats" any text
   first; a free-form query is not parsed while it is active;
2. commands and reply-menu buttons — as before;
3. everything else — a candidate free-form query.

**Parsing text into structure** — `src/core/intent.ts`, `parseIntent(text, ctx,
opts)`. A plain `fetch` to `https://api.anthropic.com/v1/messages` (no Anthropic
SDK — the same reasoning as dropping `@supabase/supabase-js` in
`core/repos.ts`: pulling an SDK into core for a single call is not worth it),
model `claude-haiku-4-5`, forced tool use (`tool_choice: {type: 'tool', name:
'set_intent'}`) — the model physically cannot answer with free text instead of a
`BookingIntent` structure. The `system` prompt carries only today's date and day
of week in Asia/Tbilisi, the court list, and the T+7 horizon — the user's text
rides EXCLUSIVELY in the `user` message, and the profile's personal data
(name/email/phone) never reaches the request to Anthropic at all. Timeout 5 s;
any error or a response without tool use → `null`. The key
(`ANTHROPIC_API_KEY`) is never logged — the same discipline as the bot token and
the Supabase key.

The model's response is not the source of truth: the code re-checks every field
(`courtIndexOf` for court names, the horizon bounds for dates, the time format)
and sanitizes or nulls out whatever fails the check, down to `null` for a plainly
unusable response.

**The limit** is 20 queries per day per profile, settings key
`llm_quota:{profileId}:{dateTbilisi}` in the same `settings` table as
`planner_enabled` (`SettingsRepo`; the counter is incremented on each query and
resets when the date in the key changes). Going over → a polite refusal without
touching the Anthropic API at all. The counter is read and written with two calls
(`get` → `set`), and that is correct precisely because the bot processes updates
sequentially (grammY's built-in long polling, `bot.start()`). Moving to webhooks
or `@grammyjs/runner` (the hosting candidates in `CLAUDE.md`) brings parallel
processing — then, together with it, you need `sequentialize` by `chat_id` or an
atomic increment in storage, otherwise a burst of messages slips past the daily
cap.

**`ANTHROPIC_API_KEY` not set** — free-form queries are silently disabled: the
profile gets a friendly "free-form queries aren't configured, use the buttons"
once a day, and after that the bot simply does not respond to free text for the
rest of the day (the same "don't nag with the same thing" principle as the
expired wizard draft).

**Then, based on the `parseIntent` result:**

- `null`/`kind: 'unknown'` — a hint with 2–3 example queries;
- `kind: 'find'` — availability for the required courts/dates via
  `client.getAvailability` (in parallel, no more than 14 requests — days×courts
  that the intent itself set; on a broader request the bot asks to narrow it),
  then a pure search `src/core/slot-search.ts` (`searchSlots`): it filters by
  dates/time/courts/duration, gathers runs of consecutive hours **on the same
  court** into a `SlotOption` (crossing midnight, e.g. 23:00→00:00, does not
  count as a run), sorts — runs before singles, earlier by date/time first — and
  trims to at most 8 options (an "and N more" line). Each option is a separate
  inline "Book" button leading to the same confirmation screen as "📆 Book";
- `kind: 'book'` — straight to the confirmation screen for a specific
  (date, time, court) with a preliminary availability check, the same flow as a
  manual choice through the buttons.

Reservio API errors on any of these paths are ordinary human-readable text, as
everywhere in the bot (`errors.ts`); at no LLM outcome does it make a booking —
the final step is always `bookNow` from a pressed button.

**Privacy.** Only the message text plus service context (date/day of
week/court list/horizon) goes to the Anthropic API — email, phone, `chat_id`,
booking tokens, and other personal profile data reach the request neither in the
system nor in the user message.

A separate guard is on the text itself: a message that looks like an **email or a
phone** does not reach the model at all (`looksLikeContact` in
`src/bot/handlers/free-query.ts`); the person gets a hint. This closes a
non-obvious path: the bot explains the expired "➕ Add profile" wizard draft
exactly once, and the admin's next line — while the wizard collects a THIRD
person's name, email, and phone — is no longer "eaten" by anyone, and would
become an ordinary free-form query. A lone address or `+995…` is never a query
about courts, so the refusal breaks nothing.

## DB profile vs engine profile — an important fork

These are two independent configs with the same `id`; they must be kept in sync:

- **The engine profile** (`core/profiles.ts`, `loadProfiles(env)`) — from
  `CLIENT_NAME/EMAIL/PHONE` (the `ilya` profile) and `PROFILE_<K>_*` (extra
  profiles, env). This is what `trigger/book-drop.ts` reads by `profileId` from
  the payload — the only contact the real `POST /bookings` goes out with.
- **The bot profile** (the `profiles` table, `src/core/repos.ts`) — the source of
  `telegram_chat_id → profile`, the displayed data, and the schedule rules
  (`schedule_rules`) for the bot and the future `daily-planner`.

What comes from where in the automatic drop (`daily-planner` → `book-slot-drop`):

| Field | Source | Who reads it |
|---|---|---|
| `times` | DB (`schedule_rules.times`) | the planner, one drop per time |
| `days_of_week` | DB | the planner (`ruleAppliesOnDate`); the env day check is bypassed by `force:true` |
| `enabled`, `skips` | DB | the planner + a re-check of the skip in `book-drop` |
| `courts`, `mode` | DB (`schedule_rules.courts/mode`), if the payload doesn't pass them | the planner puts them from the rule into the `book-slot-drop` payload; an explicit payload may override |
| **contact** (`name/email/phone`) | **env** (`CLIENT_*` / `PROFILE_<K>_*`) | the engine, goes out in the real `POST /bookings` |

An important consequence for multi-profile: an on-demand booking ("📆 Book" in
the chat, `core/book-now.ts`) takes the contact from the DB profile, while the
automatic drop takes it from env. For a profile created only via `/add_profile`,
a manual booking will work, but the evening drop will fail with "Profile not
found".

`scripts/seed-profiles.ts` creates the `ilya` profile in the DB **from the same
env variables** the engine already reads — so for it both configs match by
construction. If the admin adds a second live player via `/add_profile` (DB) with
a new `id`, a real booking on their behalf still needs a matching
`PROFILE_<K>_NAME/EMAIL/PHONE/...` in env — both in `.env` and (for cloud drops)
in the trigger.dev variables, where a fixed list of seven keys is currently
synced (`trigger.config.ts` → `syncEnvVars`, see `Runbook.md` → "Deploy").
Without this, a `book-slot-drop` with the new player's `profileId` will fail with
"Profile not found" — the `syncEnvVars` list will have to be extended in a
separate change once a second production player appears.
