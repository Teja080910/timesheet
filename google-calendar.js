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
 *   GOOGLE_CALENDAR_MAX_EVENTS    – Max events per fetch (default: 100)
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
  if (!raw) return 100;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

function getEventLabel() {
  return (process.env.GOOGLE_CALENDAR_EVENT_LABEL || 'Meeting').trim();
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

  let response;
  try {
    response = await calendar.events.list({
      calendarId: config.calendarId,
      timeMin: new Date(`${range.startDateStr}T00:00:00.000Z`).toISOString(),
      timeMax: new Date(`${range.endDateStr}T23:59:59.999Z`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: getMaxEvents(),
    });
  } catch (error) {
    console.error(`Failed to fetch calendar events: ${getErrorMessage(error)}`);
    return [];
  }

  const items = response.data.items || [];
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

    const date = startTime.toISOString().slice(0, 10);
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

module.exports = { fetchCalendarEvents, getCalendarConfig, extractTicketFromEvent };
