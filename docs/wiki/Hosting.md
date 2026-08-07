# Hosting

Where to keep a permanently running process for the Telegram bot
(`src/bot/index.ts`, grammY, long-polling). The deployment itself is phase 4
(`PLAN.md`), after explicit user approval; this document is a comparison of
options and a draft plan, so that by that point the decision doesn't have to be
made from scratch.

## Why this is a separate question at all

The bot in this project uses **long-polling** (`bot.start()`) — the process
itself keeps up a continuous HTTP poll of `api.telegram.org` rather than
waiting for incoming requests to its own address. Consequences:

- the process must run 24/7; a bot that "falls asleep" on classic serverless
  hosting (it wakes up on an external request) silently loses every update
  until it wakes — perfect for the drop task (there `delay` in trigger.dev
  wakes it), but not for a human who pressed "Book" in the chat and is waiting
  for a reply right now;
- a **webhook** (Telegram itself makes an HTTP request to our public endpoint
  on every update) removes the "process always alive" requirement and fits
  serverless — but it requires rewriting `bot.start()` to handle an incoming
  HTTP request (`bot.handleUpdate()` behind an endpoint), i.e. a different code
  scaffold, not just different hosting.

This is a separate story from the cloud drop: `trigger.dev` (cron tasks,
phase 4) is already serverless by nature and is in no way tied to the choice of
bot hosting — the two decisions are independent.

## Comparison for our case

| | Railway | Northflank | Vercel |
|---|---|---|---|
| Fit for our code | long-polling as-is, no changes in `src/bot/` | long-polling as-is, no changes in `src/bot/` | needs a webhook — rewrite `bot.start()` as a serverless function |
| Price | Hobby ~$5/mo (after the trial period), the process runs continuously | Has a free tier, but with resource/idle limits — its terms change more often than is worth relying on without checking | Serverless functions are free on the Hobby plan — but for the webhook model, not for a long-lived process |
| Setup | git push → auto-deploy, simple Dockerfile/Nixpacks | also git push, more "infrastructure-oriented" UI (projects/environments) | zero-config for functions, but not for a process like ours as-is |
| Secrets | Environment Variables in the UI | Environment Variables in the UI, per environment | Environment Variables in the UI, but the code must be stateless between calls |
| Risk for our case | Low — paid, but no code rework | Medium — the free limit at the time of phase 4 may not cover 24/7; verify before deploying | High — architectural rework of the bot for the sake of savings |

## Recommendation

**Railway** (Hobby, ~$5/mo). Rationale:

- Our bot is a single process with a single entry point (`src/bot/index.ts`);
  no code needs to change — it deploys as-is, the same way it runs locally
  (`pnpm bot`).
- $5/mo is not critical for one person's personal project; saving with
  Northflank's free tier costs the time to verify its limits and the risk of
  running past them exactly when the bot is critically needed (before a drop).
- A webhook on Vercel is the cheapest option in money, but pays for it with
  architectural complexity: a public HTTPS endpoint, registering the webhook
  with Telegram (`setWebhook`), handling cold starts (the first update after
  idle pays the initialization time), and effectively a separate code path that
  runs differently locally than long-polling. Justified only if price is the
  sole criterion.

Northflank remains the fallback if its free tier at the time of phase 4 really
does cover a round-the-clock process without surprises — that's worth
re-checking right before deploy rather than relying on the state of the pricing
tiers as of the time this document was written.

## Draft deployment plan (phase 4, do not execute without separate approval)

1. Railway: New Project → Deploy from GitHub repo (branch `main`) →
   Environment Variables: `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` and `TRIGGER_SECRET_KEY_PROD`. Profile contacts
   (`CLIENT_*`/`PROFILE_<K>_*`) are not needed by the bot right now — all data
   for display and on-request booking is taken by the bot from the `profiles`
   table, not from env. The trigger.dev key is needed specifically by the bot
   process: without it `src/bot/reminder.ts` can't schedule the deferred
   `remind` task, and bookings made from the chat will be left without the
   "in 2 hours" reminder. This doesn't crash the bot and doesn't interfere with
   booking in any way — it just quietly (one line in the log) disables
   reminders, which is why the variable is easy to forget.
2. Start command: `pnpm bot`. As of phase 3 there is no build step; the process
   runs through `tsx` the same way as locally.
3. Default restart policy (Railway restarts a crashed process) — this is enough
   for a long-polling bot: Telegram's `getUpdates` will itself re-deliver the
   updates accumulated during downtime, within the TTL.
4. After the first deploy — manually verify that the bot replies to the menu
   for a known chat_id and stays silent to an unknown one (`Bot.md` →
   "Authorization").
5. Update this file and `Runbook.md` if the actual process in production
   differs from the plan above.
