# padel-bot — wiki

An autonomous court-booking bot for **Padel Port Batumi** (Reservio API v2).

Slots open **hourly**, rolling T+7: the slot for hour `H` on day T+7 appears in
availability at `H:59:00 ± 2 s` on day T — in the very same hour as the slot
itself. The bot has to grab the two evening hours faster than the competition
and report the outcome to Telegram. All times are in Batumi time
(`Asia/Tbilisi`, +04:00, no DST).

**Evening strategy.** The club keeps **Padel Court 2** and **Padel Court 3**
booked for its own groups on 20:00–22:00 most days of the week (an admin block),
so those hours never reach the public availability at all — no amount of polling
helps. A single-court priority therefore does not work. Instead the bot stands a
watch over a **set of courts** `{Padel Court 3, Padel Court 4, Padel Court 1}`
and books **every** court that shows up in the drop (engine mode `all`). The goal
is to assemble a **20:00+21:00 pack** on one court; if the drop hands out extra
bookings across different courts, the owner cancels the surplus by hand
(cancellation deadline: 1 hour before the slot).

**Architectural principle — path A:** deterministic code (cron + direct Reservio
API v2 calls), no LLM and no browser agents in the core flow. The only LLM in the
project parses free-form Telegram queries (Claude Haiku) and never makes booking
decisions — see the Status section below.

## Status

All phases 1–5 are implemented and covered by tests:

- **Protocol** (Reservio API v2) — confirmed against the live API
  (`docs/PROTOCOL.md`).
- **Booking engine** + multi-profile config — deterministic drop model, watch
  set, `all`/`priority` modes, idempotency.
- **Cloud drop** — trigger.dev tasks with shared state in Supabase Postgres.
- **Telegram bot** (`src/bot/`) — commands and buttons, DB-backed profiles and
  schedule rules in Supabase, a profile-creation wizard with invite links that
  bind a player's chat to their profile.
- **Heartbeat monitoring** — a nightly watchdog that verifies the evening ran
  and that exactly one report was delivered per planned slot.
- **Free queries via Haiku** — natural-language requests ("find two hours in a
  row on Saturday afternoon") parsed into a structured intent, then matched
  against availability by a pure search function.

The autoschedule (`daily-planner`) is **enabled** (`settings.planner_enabled`),
so the evenings run on their own. Details are in `Architecture`, `Bot`, and
`Runbook`.

The full list of phases with acceptance criteria: [`PLAN.md`](../../PLAN.md).

## Wiki pages

- [Architecture](Architecture.md) — modules, data flows, the hourly drop model
- [Bot](Bot.md) — Telegram bot commands and buttons, authorization, admin flow, free queries
- [Hosting](Hosting.md) — hosting comparison for the bot (Railway/Northflank/Vercel)
- [Dev-Process](Dev-Process.md) — branches, PRs, CI, review, merge
- [Runbook](Runbook.md) — running scripts, reading logs, cancelling bookings, seeding profiles, and starting the bot

## Other documentation in the repository

- [`CLAUDE.md`](../../CLAUDE.md) — rules for the agent, key facts, stack
- [`PLAN.md`](../../PLAN.md) — development phases and locked-in decisions
- [`docs/PROTOCOL.md`](../PROTOCOL.md) — the Reservio API v2 protocol (confirmed against the live API)

## Key facts (short)

- API: `https://api.reservio.com/v2`, JSON:API, businessId
  `1e32bd0a-0d5c-4e30-9788-ea488e713c4d`, no auth required.
- Each court is a separate `service`; the evening watch set is
  `{Padel Court 3, Padel Court 4, Padel Court 1}` — e.g. Court 3 =
  `303f3adf-8a99-4c1f-89fe-f9a9b56a620b` (the full table is in `PROTOCOL.md`).
- A slot is 59 minutes long; "a two-hour game" = two separate bookings
  (20:00 and 21:00).
- Bookings use the guest booking flow (`name/email/phone` in the payload), no
  login or OAuth.
- A booking is a success only when a `booking_id` is returned; a cancellation is
  `PATCH ... state:"canceled"` (exactly like that, one L) verified by the `state`
  in the response body, not by the HTTP code.
- Bot authorization is an allowlist of Telegram `chat_id → profile`; an unknown
  chat_id is met with complete silence. No passwords or OAuth (`Bot.md`).
