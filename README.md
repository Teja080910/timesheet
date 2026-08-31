# Timesheet Generator

This project can now run in two modes:

- Local CLI: `node generate-timesheet.js --dry-run`
- Vercel deployment: static UI at `/` and API at `/api/timesheet`

## Vercel setup

1. Import this repository into Vercel.
2. Set the project root to this folder if needed.
3. Add these environment variables in Vercel:

- `BITBUCKET_BASE_URL`
- `BITBUCKET_TOKEN`
- `BITBUCKET_REPOS`
- `BITBUCKET_BRANCHES` or `BITBUCKET_BRANCH_PATTERNS`
- `BITBUCKET_MAX_BRANCHES`
- `BITBUCKET_AUTHOR_EMAILS`
- `JIRA_BASE_URL`
- `JIRA_API_VERSION`
- `JIRA_AUTH_TYPE`
- `JIRA_TOKEN` or basic-auth Jira credentials
- `JIRA_WORKLOG_TIMEZONE_OFFSET` (optional, defaults to `+0000`)
- `TIMESHEET_API_TOKEN`
- `TIMESHEET_FIXED_TICKET` (optional, defaults to `PF-6863`)
- `TIMESHEET_DEFAULT_TICKET` (optional, defaults to `PF-16716`)
- `TIMESHEET_MEETING_TICKET` (optional, defaults to `PF-6870`)
- `TIMESHEET_REQUIREMENT_MEETING_TICKET` (optional, defaults to `PF-6866`)
- `TIMESHEET_MAX_DAILY_HOURS` (optional, defaults to `10.5`)
- `TIMESHEET_DAILY_TARGET_MIN_HOURS` (optional, defaults to `9`)
- `TIMESHEET_DAILY_TARGET_MAX_HOURS` (optional, defaults to `10`)

`TIMESHEET_API_TOKEN` is required by the Vercel API route. Requests without it are rejected.

The four `TIMESHEET_*` ticket variables let you change the hardcoded ticket IDs the
generator falls back to (daily fixed allocation, unmatched commits, and untagged
calendar meetings) without editing code.

### Daily target range (`TIMESHEET_DAILY_TARGET_MIN_HOURS` / `_MAX_HOURS`)

Each day's total logged time (fixed slot + commit work + meetings) is picked deterministically
somewhere between these two bounds — the same date always lands on the same target when
regenerated, but different dates land on different totals rather than an identical number every
day. Set both to the same value to pin every day to one fixed total (e.g. the old behavior was
equivalent to min=max=8).

**If you raise this range, raise `TIMESHEET_MAX_DAILY_HOURS` too** — it's a safety ceiling *above*
the target, not the target itself, and needs headroom over `_MAX_HOURS` or it will start
skipping legitimate entries on days whose target lands close to or above the cap.

### Daily hour cap (`TIMESHEET_MAX_DAILY_HOURS`)

Before creating a *brand-new* worklog, the generator checks how much time **it has itself
already logged** in Jira for that date — summed across every ticket it manages — and refuses to
add more if doing so would push its own contribution over this cap. This is a hard safety net
against runaway duplication: if a future code change (e.g. renaming the internal scheduling
segments, as happened once already) breaks the matching that lets re-runs update existing
worklogs instead of creating new ones, this tool's own contribution can never silently balloon
past the cap no matter how many times you re-run the generator.

Notes:
- The cap only blocks *creating* new worklogs. Updating an already-existing one always proceeds
  — that's correcting existing data, not adding new time, so it's never blocked.
- **It deliberately excludes manually-typed worklogs.** The generator has no way to judge
  whether a manual entry is legitimate or an accidental duplicate, so counting it toward the cap
  would mean a heavy manual-logging day silently blocks this tool from ever recording real
  commit-based work — which defeats the point of running it. The cap only ever governs what this
  tool itself is responsible for.
- If a day is skipped this way, you'll see `[SKIPPED] ... exceed the X.Xh daily cap` in the
  output and a `skipped-daily-cap` status in the result JSON — that means *this tool's own*
  worklogs for that day already hit the cap, most likely from stale duplicates. Run
  `cleanup-jira-duplicates.js` for that date to investigate.
- This cap says nothing about the day's *grand total* in Jira (managed + manually-typed). If
  that number looks too high, the fix is reviewing the manual entries yourself — see "Keeping
  totals sane" below.

### Google Calendar (optional)

You can also pull meetings from Google Calendar. The events will appear as time entries
in the timesheet (marked as `[MEETING]`), and commit-based allocations adjust automatically.

| Variable | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from Google Cloud |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Private key of the service account |
| `GOOGLE_CALENDAR_ID` | Calendar ID to fetch events from |
| `GOOGLE_CALENDAR_MAX_EVENTS` | Max events per fetch, across all pages (default: `500`) |
| `GOOGLE_CALENDAR_EVENT_LABEL` | Label prefix (default: `Meeting`) |

**Setup steps:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services**
2. Enable the **Google Calendar API**
3. Create a **Service Account** → download the JSON key
4. Copy the `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
5. Copy the `private_key` → `GOOGLE_SERVICE_ACCOUNT_KEY`
6. Share your Google Calendar with the service account email (at least **View** permission)
7. Find your Calendar ID in Google Calendar settings → **Integrate calendar**

Calendar events that contain a ticket ID (e.g. `PF-12345`) in the title will be tagged with
that ticket. Untagged events default to `TIMESHEET_MEETING_TICKET` (`PF-6870`), or
`TIMESHEET_REQUIREMENT_MEETING_TICKET` (`PF-6866`) if the title mentions "requirement".

Calendar entries **are** uploaded to Jira as their own worklog, just like commit-based
entries — the worklog comment always leads with the meeting title (e.g.
`Meeting: 5.3 Release - Scrum Call (30min) [...]`) so it's clear which meeting a given
worklog came from. Commit-based work for the day is scheduled around the meeting rather
than on top of it, so the day's total still adds up to exactly `8.00h`.

**Note on timezone:** meeting worklogs use the meeting's real local wall-clock time
(e.g. a 9:25 AM meeting is submitted as `09:25`), tagged with `JIRA_WORKLOG_TIMEZONE_OFFSET`
— the same convention used for commit/fixed-slot worklogs. See "Worklog timing rules" below
for why this matters more than it sounds like it should.

## API usage

Endpoint:

```bash
POST /api/timesheet
```

Example:

```bash
curl -X POST "$VERCEL_URL/api/timesheet" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "your-timesheet-api-token",
    "dryRun": true,
    "days": 7
  }'
```

You can also provide `startDate` and `endDate` in `YYYY-MM-DD` format.

## Local usage

Install dependencies:

```bash
npm install
```

Run a dry run:

```bash
node generate-timesheet.js --dry-run --days 7
```

Run with explicit dates:

```bash
node generate-timesheet.js --dry-run --startDate 2026-03-20 --endDate 2026-03-25
```

## Duplicate cleanup

If old Jira runs created duplicate worklogs, use the cleanup script.
It only targets worklogs created by this generator for the selected date range.

Dry run first:

```bash
npm run cleanup:duplicates -- --startDate 2026-04-13 --endDate 2026-04-17
```

clear the duplicates:

```bash
npm run cleanup:duplicates -- --startDate 2026-04-13 --endDate 2026-04-17 --execute
```

After deletion, rerun the generator for the same date range if you want Jira to be rebuilt using the current deterministic schedule.

## Keeping totals sane

Two different things can inflate a day's total in Jira, and they need different fixes:

**1. This generator's own duplicates.** Matching relies on an exact marker in the worklog
comment (`[commitHash-segment]`, `[calendar-eventId]`, etc.). Any change to how those markers
are built — renaming a scheduling segment, changing the comment format — breaks matching for
*already-generated* dates, and the next run creates fresh duplicates instead of updating them.
This has happened more than once. **Whenever you change anything in the scheduling or comment-
building code, re-run `cleanup-jira-duplicates.js --dry-run` for whatever date range you've
already generated before trusting the numbers.** The `TIMESHEET_MAX_DAILY_HOURS` cap (above)
limits the damage automatically, but it's a safety net, not a substitute for checking after a
code change.

**2. Manually-typed worklogs.** If you (or the habit of logging things by hand) also type
entries directly into Jira for things this generator already covers — daily standups, the fixed
admin slot, calendar meetings — you end up logging the same real time twice: once by hand, once
by the generator. The generator has no way to detect this; it only recognizes its own managed
markers and leaves everything else alone by design. **The fix is behavioral, not technical: once
you trust the generator to log your meetings (via Google Calendar sync) and daily admin time
(`PF-6863`), stop logging those same things manually.** If you want to audit how much manual
data has already accumulated, filter for worklogs whose comment does *not* contain `Entry [`,
`Daily fixed allocation slot [`, or `[calendar-` — those are the ones this generator never
touched.

**3. Shared tickets used by more than one person.** `PF-6863` (and potentially others) get
worklogs from anyone on the team running this same generator against their own commits/calendar
— not just you. Matching is now scoped to worklogs authored by the account this Jira client
actually authenticates as (checked via `/rest/api/2/myself`), so it will never mistake a
colleague's comment-matching worklog for one of ours to update — it creates its own instead. If
you ever see `[FAILED] ... you do not have permission to edit/delete the specified worklog` on a
shared ticket, that almost always means a colleague's copy of this tool got there first for that
exact slot on that exact day — nothing to fix on your end; the next run creates your own worklog
alongside theirs instead of fighting over it.

## Delete worklogs

Delete all managed worklogs in a date range. Dry run first:

```bash
npm run delete:worklogs -- --startDate 2026-05-15 --endDate 2026-05-19
```

To actually delete:

```bash
npm run delete:worklogs -- 2026-05-15 2026-05-19 --execute
```

## Worklog timing rules

Generated Jira worklogs now follow your office schedule with randomized placement:

- First half: `09:30` to `12:30`
- Second half: `14:30` to `19:30`
- Fixed daily allocation: `PF-6863` (override with `TIMESHEET_FIXED_TICKET`) for `0.5h` once in the first half and `0.5h` once in the second half
- Daily total hours: a deterministic value between `TIMESHEET_DAILY_TARGET_MIN_HOURS` and `TIMESHEET_DAILY_TARGET_MAX_HOURS` (default `9`–`10`) for every day, calendar meetings included — see "Daily target range" above
- If a calendar meeting overlaps the first-half or second-half window, commit work (and the fixed slot, if needed) is pushed around it and never overlaps the meeting. Any commit time that no longer fits in the daytime windows because of that overlap — or because the day's target itself exceeds first-half + second-half capacity (150min + 270min) — spills over to after `19:30` as evening work; the day's logged total still lands exactly on its target
- The schedule is deterministic per date, so rerunning the same date range updates the same Jira worklogs instead of creating duplicates

**Important — do not set `JIRA_WORKLOG_TIMEZONE_OFFSET` to your real UTC offset (e.g. `+0530`).**
Jira does not convert a worklog's "started" time per viewer when displaying it — it shows
exactly the UTC-equivalent instant you submit, verbatim, with no further conversion. So if you
submit the *real* local time with its *real* offset (e.g. `09:30+0530` for 9:30 AM IST), Jira
computes the true UTC instant (`04:00`) and then displays that raw UTC value — meaning your
9:30 AM entry shows up as "4:00" in Jira, 5.5 hours off from what you actually want to see.

The fix used throughout this generator is: always submit the *local* wall-clock digits you
want Jira to display, tagged with `+0000` regardless of your real timezone. That's why
`JIRA_WORKLOG_TIMEZONE_OFFSET` defaults to (and should normally stay at) `+0000` — it's not
describing your real timezone, it's telling Jira "display these digits as-is." Every worklog
this tool creates (commits, fixed slots, and calendar meetings) follows this same convention,
so they all display consistently at their real local time. Only change this value if you've
independently confirmed your specific Jira instance actually re-converts worklog times per
viewer on display (most Jira Server/Data Center instances do not).

That means each generated workday is scheduled as:

- One random `PF-6863` slot somewhere between `09:30` and `12:30`
- One random `PF-6863` slot somewhere between `14:30` and `19:30`
- Commit-based logs fill the rest of the first half and second half
- If the day is above `8.00h`, the remaining time is added after `19:30`
