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

`TIMESHEET_API_TOKEN` is required by the Vercel API route. Requests without it are rejected.

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

Delete the duplicates:

```bash
npm run cleanup:duplicates -- --startDate 2026-04-13 --endDate 2026-04-17 --execute
```

After deletion, rerun the generator for the same date range if you want Jira to be rebuilt using the current deterministic schedule.

## Worklog timing rules

Generated Jira worklogs now follow your office schedule with randomized placement:

- First half: `09:30` to `12:30`
- Second half: `14:30` to `19:30`
- Fixed daily allocation: `PF-6863` for `0.5h` once in the first half and `0.5h` once in the second half
- Daily total hours: random between `8.00h` and `10.00h`
- At least one generated day stays exactly `8.00h`
- Extra time above `8.00h` is scheduled after `19:30` as evening work
- The schedule is deterministic per date, so rerunning the same date range updates the same Jira worklogs instead of creating duplicates

Worklog timestamps are uploaded using `JIRA_WORKLOG_TIMEZONE_OFFSET`.
If this variable is not set, the generator uses `+0000` so Jira will keep `09:30`, `14:30`, etc. in UTC-style 24-hour display.
If your Jira user profile is set to India time and you want true IST conversion, set `JIRA_WORKLOG_TIMEZONE_OFFSET=+0530`.

That means each generated workday is scheduled as:

- One random `PF-6863` slot somewhere between `09:30` and `12:30`
- One random `PF-6863` slot somewhere between `14:30` and `19:30`
- Commit-based logs fill the rest of the first half and second half
- If the day is above `8.00h`, the remaining time is added after `19:30`
