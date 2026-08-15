'use strict';

/**
 * Google Calendar integration for fetching calendar events.
 *
 * Environment variables required:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  – Service account email (from Google Cloud)
 *   GOOGLE_SERVICE_ACCOUNT_KEY    – Private key of the service account
 *   GOOGLE_CALENDAR_ID            – Calendar ID to fetch events from
 *
 * Optional:
 *   GOOGLE_CALENDAR_MAX_EVENTS    – Max events per fetch (default: 500)
 *   GOOGLE_CALENDAR_EVENT_LABEL    – Label prefix (default: "Meeting")
 */

const { google } = require('googleapis');

const TICKET_REGEX = /PF-\d+/i;

/**
 * Small helper to extract a readable error message from any error object.
 */
function getErrorMessage(error) {
  if (error.response) {
    const details = typeof error.response.data === 'string'
      ? error.response.data
      : JSON.stringify(error.response.data);
    return `${error.response.status} ${error.response.statusText}: ${details}`;
  }

  if (error.request) {
    return `No response received: ${error.message}`;
  }

  return error.message || String(error);
}

function getCalendarConfig() {
  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const rawKey = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  const calendarId = (process.env.GOOGLE_CALENDAR_ID || '').trim();

  if (!email || !rawKey || !calendarId) {
    return null;
  }

  // Normalise private key: strip surrounding quotes and replace literal \n with actual newlines
  const key = rawKey
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n');

  return { email, key, calendarId };
}

function getMaxEvents() {
  const raw = (process.env.GOOGLE_CALENDAR_MAX_EVENTS || '').trim();
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

function getEventLabel() {
  return (process.env.GOOGLE_CALENDAR_EVENT_LABEL || 'Meeting').trim();
}

/**
 * Follows `nextPageToken` until either the range is exhausted or `maxEvents` items have been
 * collected. `fetchPage({ pageToken, maxResults })` must return a Google-Calendar-API-shaped
 * `{ data: { items, nextPageToken } }` response — kept separate from fetchCalendarEvents so it's
 * unit-testable without a real (or mocked) googleapis client.
 * @returns {Promise<{ items: Array<object>, truncated: boolean }>}
 */
async function collectPaginatedEvents(fetchPage, maxEvents) {
  const items = [];
  let pageToken;

  do {
    const response = await fetchPage({
      pageToken,
      maxResults: Math.min(maxEvents - items.length, 250),
    });

    items.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken && items.length < maxEvents);

  return { items, truncated: Boolean(pageToken && items.length >= maxEvents) };
}

/**
 * Fetch calendar events for the given date range.
 * @param {{ startDateStr: string, endDateStr: string }} range
 * @returns {Promise<Array<object>>} List of calendar events
 */
async function fetchCalendarEvents(range) {
  const config = getCalendarConfig();
  if (!config) {
    console.log('Google Calendar not configured – skipping calendar fetch.');
    return [];
  }

  console.log(
    `Fetching Google Calendar events from ${range.startDateStr} to ${range.endDateStr}...`,
  );

  const auth = new google.auth.JWT({
    email: config.email,
    key: config.key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });

  const calendar = google.calendar({ version: 'v3', auth });
  const maxEvents = getMaxEvents();

  let result;
  try {
    result = await collectPaginatedEvents(
      ({ pageToken, maxResults }) => calendar.events.list({
        calendarId: config.calendarId,
        timeMin: new Date(`${range.startDateStr}T00:00:00.000Z`).toISOString(),
        timeMax: new Date(`${range.endDateStr}T23:59:59.999Z`).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults,
        pageToken,
      }, { timeout: 30000 }),
      maxEvents,
    );
  } catch (error) {
    console.error(`Failed to fetch calendar events: ${getErrorMessage(error)}`);
    return [];
  }

  if (result.truncated) {
    console.warn(
      `Calendar fetch stopped at GOOGLE_CALENDAR_MAX_EVENTS=${maxEvents}; more events exist in `
      + `${range.startDateStr}..${range.endDateStr} but were not fetched. Raise GOOGLE_CALENDAR_MAX_EVENTS if needed.`,
    );
  }

  const items = result.items;
  const parsed = [];

  for (const event of items) {
    // Skip all-day / multi-day events without a specific time
    if (!event.start?.dateTime || !event.end?.dateTime) {
      continue;
    }

    const startTime = new Date(event.start.dateTime);
    const endTime = new Date(event.end.dateTime);
    const durationMinutes = Math.round((endTime - startTime) / 60000);

    if (durationMinutes <= 0) {
      continue;
    }

    const rawDate = event.start.dateTime.slice(0, 10);
    const date = rawDate;
    const summary = (event.summary || '(No title)').trim();
    const ticketId = extractTicketFromEvent(summary);

    parsed.push({
      id: event.id,
      summary,
      description: (event.description || '').trim(),
      ticketId,
      date,
      startTime,
      endTime,
      startTimeStr: event.start.dateTime,
      endTimeStr: event.end.dateTime,
      durationMinutes,
      htmlLink: event.htmlLink || '',
      isCalendarEvent: true,
    });
  }

  console.log(`Found ${parsed.length} calendar event(s).`);
  return parsed;
}

/**
 * Try to extract a Jira ticket ID from an event summary.
 */
function extractTicketFromEvent(summary) {
  const match = summary.match(TICKET_REGEX);
  return match ? match[0].toUpperCase() : null;
}

module.exports = {
  fetchCalendarEvents,
  getCalendarConfig,
  extractTicketFromEvent,
  // Exported for unit tests (test/scheduling.test.js) — not part of the module's public surface.
  collectPaginatedEvents,
};
