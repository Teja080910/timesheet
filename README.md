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
