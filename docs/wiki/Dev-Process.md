# Dev-Process

The process is fixed in `PLAN.md` ("Decisions locked in advance"). Below is what
it looks like step by step.

## Branches and `main`

`main` is protected; direct pushes to it are closed. All work happens in feature
branches, one per task/phase (example of the current one: `feat/booking-engine`
for phase 2).

## PR cycle

1. **Feature branch** off `main` → changes → push.
2. **PR** into `main`. The description says what and why, with a link to the
   `PLAN.md` phase/item where applicable.
3. **CI** (`.github/workflows/ci.yml`) runs automatically on `pull_request` and
   `push` to `main`:
   - `pnpm install --frozen-lockfile`
   - `pnpm typecheck` (`tsc --noEmit`)
   - `pnpm test` (`vitest run`)
   A PR is not ready for review until CI is green.
4. **Review — charliecreates.** Comments are addressed on the merits (a code
   fix, not just a reply) and **explicitly resolved** — no comment is left
   hanging without a reply/resolve.
5. **Merge** is done by the **repository owner** (the user), and only when the PR
   is fully green: CI passed + review with no open comments.

## Rules the review checks (from `CLAUDE.md`)

- No hardcoded `CLIENT_*` data or tokens — only via env.
- No `new Date()` without explicit `+04:00` handling (Asia/Tbilisi, no DST).
- Dates in code are ISO with an explicit offset (`2026-08-05T20:00:00+04:00`).
- Polling does not turn into a DDoS: interval ≥ 2 s, window ≤ 5 min, exponential
  backoff on 429/5xx.
- A booking's success is verified only by the `booking_id` in the API response
  (external validation), never by the absence of an error.
- Idempotency: re-running a job creates no duplicate booking.
- The observability invariant: every evening at 21:0x exactly one message goes to
  Telegram (success / error / "skipped by command"). A silent failure is not
  acceptable.
- `spike-reservio.ts --book` creates a real booking — it is not run automatically
  in PR/CI, only by hand and on the user's explicit request in the session.
- Cron / production auto-bookings are disabled until phase 4 and a separate
  explicit approval from the user — PRs for phases 0–3 must not enable it.

## The stack CI checks

TypeScript (strict), Node 20+ (Node 22 in CI), package manager pnpm, tests
vitest. Extra dependencies are not added to core modules without need.
