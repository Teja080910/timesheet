'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWorklogComment,
  distributeUnits,
  generateHours,
  getWorklogTimezoneOffset,
  pushPastBusyIntervals,
  uploadToJira,
} = require('../generate-timesheet');

function withEnv(name, value, fn) {
  const original = process.env[name];
  process.env[name] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
}

// uploadToJira fetches the current Jira user once per non-dry-run call. Wrap a fake client's
// `get` with this so tests don't pay the 3-retry backoff for an unmocked /myself endpoint.
const MOCK_JIRA_USER = { name: 'test.user', emailAddress: 'test.user@example.com', key: 'JIRAUSER1' };

function withMockJiraUser(getHandler) {
  return (url, config) => {
    if (url.includes('/myself')) {
      return Promise.resolve({ data: MOCK_JIRA_USER });
    }
    return getHandler(url, config);
  };
}

function intervalOf(entry) {
  return { start: entry.startMinutes, end: entry.startMinutes + entry.durationMinutes };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function assertNoOverlaps(entries) {
  const intervals = entries.map(intervalOf);
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      assert.ok(
        !overlaps(intervals[i], intervals[j]),
        `entries overlap: ${JSON.stringify(intervals[i])} vs ${JSON.stringify(intervals[j])}`,
      );
    }
  }
}

test('distributeUnits sums exactly to the requested total with no negative allocations', () => {
  const allocations = distributeUnits(37, [0.2, 0.3, 0.5]);
  assert.equal(allocations.reduce((sum, value) => sum + value, 0), 37);
  for (const value of allocations) {
    assert.ok(value >= 0);
  }
});

test('distributeUnits handles a zero total without dividing by zero', () => {
  assert.deepEqual(distributeUnits(0, [0.5, 0.5]), [0, 0]);
});

test('pushPastBusyIntervals resolves a chain of back-to-back busy intervals', () => {
  const busy = [{ start: 100, end: 130 }, { start: 130, end: 150 }];
  assert.equal(pushPastBusyIntervals(100, 20, busy), 150);
});

test('pushPastBusyIntervals leaves a free candidate untouched', () => {
  const busy = [{ start: 200, end: 230 }];
  assert.equal(pushPastBusyIntervals(100, 20, busy), 100);
});

test('a heavy-meeting day: commit time is never over-scheduled on top of the meeting', () => {
  // Regression test: a long meeting used to cause commit work to be scheduled against the
  // fixed 84-slot (420min) daytime capacity instead of the true, meeting-reduced budget,
  // silently double-counting the meeting's duration.
  const groupedCommits = new Map([
    ['2026-08-10', new Map([['PF-1000', [{ hash: 'aaaaaaaaaaaa', message: 'work', repo: 'PF/repo' }]]])],
  ]);
  const calendarEvents = [{
    date: '2026-08-10',
    durationMinutes: 300,
    startTimeStr: '2026-08-10T09:30:00.000Z',
    id: 'ev1',
    summary: 'Long meeting',
    ticketId: null,
  }];

  const [day] = generateHours(groupedCommits, calendarEvents);

  const nonCalendarMinutes = day.entries
    .filter((entry) => !entry.isCalendarEvent)
    .reduce((sum, entry) => sum + entry.durationMinutes, 0);

  assert.equal(nonCalendarMinutes, (day.totalHours * 60) - day.meetingMinutes);
  assertNoOverlaps(day.entries);
});

test('a meeting mid-morning pushes the fixed slot out of the meeting window', () => {
  const groupedCommits = new Map([
    ['2026-08-11', new Map([['PF-2000', [{ hash: 'bbbbbbbbbbbb', message: 'work', repo: 'PF/repo' }]]])],
  ]);
  const calendarEvents = [{
    date: '2026-08-11',
    durationMinutes: 60,
    startTimeStr: '2026-08-11T10:00:00.000Z',
    id: 'ev2',
    summary: 'Standup',
    ticketId: null,
  }];

  const [day] = generateHours(groupedCommits, calendarEvents);
  assertNoOverlaps(day.entries);

  const fixedEntries = day.entries.filter((entry) => entry.isFixedAllocation);
  assert.equal(fixedEntries.length, 2);
});

test('a day with no meetings still totals exactly 8h (regression safety)', () => {
  const groupedCommits = new Map([
    ['2026-08-12', new Map([['PF-3000', [{ hash: 'cccccccccccc', message: 'work', repo: 'PF/repo' }]]])],
  ]);

  const [day] = generateHours(groupedCommits, []);
  const totalMinutes = day.entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);

  assert.equal(totalMinutes, 480);
  assert.equal(day.totalHours, 8);
  assertNoOverlaps(day.entries);
});

test('uploadToJira creates a Jira worklog for calendar entries, with the meeting title clear in the comment', async () => {
  const timesheet = [{
    date: '2026-08-10',
    totalHours: 8,
    meetingMinutes: 60,
    entries: [{
      date: '2026-08-10',
      ticketId: 'PF-6870',
      hours: 1,
      secondsSpent: 3600,
      durationMinutes: 60,
      repos: [],
      commitHashes: [],
      commitMessages: [],
      commitHash: 'CAL-abc1234',
      commitMessage: 'Meeting: Standup',
      matchingKey: 'calendar-abc1234',
      startMinutes: 600,
      isCalendarEvent: true,
      summary: 'Standup',
      startedTimestamp: '2026-08-10T10:00:00.000+0000',
    }],
  }];

  const posted = [];
  const fakeJiraClient = {
    get: withMockJiraUser(() => Promise.resolve({ data: { worklogs: [], total: 0, maxResults: 100 } })),
    post: (url, body) => {
      posted.push({ url, body });
      return Promise.resolve({ data: {} });
    },
    put: () => Promise.reject(new Error('should not update — no existing worklog to match')),
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /PF-6870/);
  assert.match(posted[0].body.comment, /Standup/);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'uploaded');
});

test('buildWorklogComment strips emoji/astral characters that break some Jira installs', () => {
  // Regression test: a real run failed with "Caught SQLException for insert into worklog" for
  // every meeting whose title contained an emoji (🧘, 🚨) — a classic legacy MySQL "utf8"
  // (3-byte) vs "utf8mb4" (4-byte) column mismatch. The comment must stay emoji-free while
  // keeping ordinary text (including other BMP symbols like ✔️) untouched.
  const comment = buildWorklogComment('PF-6870', {
    isCalendarEvent: true,
    summary: "🧘 Bro... Drop Everything, It's Sadhana Time! ✔️",
    durationMinutes: 30,
    matchingKey: 'calendar-abc123',
  });

  assert.ok(!/\u{1F9D8}/u.test(comment), 'emoji should be stripped');
  assert.match(comment, /Bro\.\.\. Drop Everything, It's Sadhana Time! ✔️/);
});

test('getWorklogTimezoneOffset reflects JIRA_WORKLOG_TIMEZONE_OFFSET', () => {
  const original = process.env.JIRA_WORKLOG_TIMEZONE_OFFSET;
  try {
    delete process.env.JIRA_WORKLOG_TIMEZONE_OFFSET;
    assert.equal(getWorklogTimezoneOffset(), '+0000');

    process.env.JIRA_WORKLOG_TIMEZONE_OFFSET = '+0530';
    assert.equal(getWorklogTimezoneOffset(), '+0530');
  } finally {
    if (original === undefined) {
      delete process.env.JIRA_WORKLOG_TIMEZONE_OFFSET;
    } else {
      process.env.JIRA_WORKLOG_TIMEZONE_OFFSET = original;
    }
  }
});

test('calendar entries use the literal wall-clock convention, not a real timezone conversion', () => {
  // Regression test: Jira does not convert worklog "started" times per viewer on display — it
  // shows exactly the UTC-equivalent instant you submit. Calendar entries used to preserve the
  // meeting's true +05:30 offset (correct timezone math), which Jira then displayed 5.5 hours
  // earlier than the real meeting time (a 9:25 AM IST meeting showed as "3:55"). Calendar entries
  // must use the same "wall-clock digits + configured offset" convention as commit/fixed entries.
  const original = process.env.JIRA_WORKLOG_TIMEZONE_OFFSET;
  try {
    delete process.env.JIRA_WORKLOG_TIMEZONE_OFFSET; // default +0000

    const groupedCommits = new Map();
    const calendarEvents = [{
      date: '2026-08-10',
      durationMinutes: 10,
      startTimeStr: '2026-08-10T09:25:00+05:30', // real Google Calendar format
      id: 'abc123',
      summary: 'Jai Gurudev :Good morning :Welcome to office',
      ticketId: null,
    }];

    const [day] = generateHours(groupedCommits, calendarEvents);
    const meeting = day.entries.find((entry) => entry.isCalendarEvent);

    // Must show the literal wall-clock digits (09:25) tagged +0000, NOT the real UTC-converted
    // instant (03:55) that the meeting's true +05:30 offset would produce.
    assert.equal(meeting.startedTimestamp, '2026-08-10T09:25:00.000+0000');
  } finally {
    if (original === undefined) {
      delete process.env.JIRA_WORKLOG_TIMEZONE_OFFSET;
    } else {
      process.env.JIRA_WORKLOG_TIMEZONE_OFFSET = original;
    }
  }
});

function managedComment(marker) {
  return `Worked on PF-EXISTING (development, fixes, improvements). Entry [${marker}]. Commit ${marker}.`;
}

test('the daily cap blocks a new worklog that would push this tool\'s own managed total over the ceiling', () => withEnv('TIMESHEET_MAX_DAILY_HOURS', '9', async () => {
  // Regression test: repeated re-runs (especially across a scheduling refactor that breaks
  // marker matching) could otherwise pile duplicate MANAGED worklogs onto a single day
  // indefinitely. This is the safety net: before CREATING a new worklog, check how much this
  // tool has already logged for that date and refuse if it would exceed the configured cap.
  const timesheet = [{
    date: '2026-08-01',
    totalHours: 8,
    meetingMinutes: 0,
    entries: [{
      date: '2026-08-01',
      ticketId: 'PF-1234',
      hours: 2,
      secondsSpent: 7200,
      durationMinutes: 120,
      repos: ['PF/repo'],
      commitHashes: ['abc12345'],
      commitMessages: ['work'],
      commitHash: 'abc12345',
      commitMessage: 'work',
      matchingKey: 'abc12345-first-half',
    }],
  }];

  const posted = [];
  const fakeJiraClient = {
    get: withMockJiraUser((url) => {
      if (url.includes('/search')) {
        return Promise.resolve({ data: { issues: [{ key: 'PF-EXISTING' }] } });
      }
      if (url.includes('PF-EXISTING') && url.includes('/worklog')) {
        // 8.5h already MANAGED (this tool's own) worklog time logged elsewhere for this date.
        return Promise.resolve({
          data: {
            worklogs: [{ started: '2026-08-01T09:00:00.000+0000', timeSpentSeconds: 30600, comment: managedComment('feedface') }],
            total: 1,
            maxResults: 100,
          },
        });
      }
      if (url.includes('PF-1234') && url.includes('/worklog')) {
        return Promise.resolve({ data: { worklogs: [], total: 0, maxResults: 100 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    post: (url, body) => {
      posted.push({ url, body });
      return Promise.resolve({ data: {} });
    },
    put: () => Promise.reject(new Error('should not update — no existing worklog to match')),
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  // 8.5h already managed + this 2h entry = 10.5h, over the 9h cap — must be skipped, not created.
  assert.equal(posted.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'skipped-daily-cap');
}));

test('the daily cap allows a new worklog that stays within the managed-total ceiling', () => withEnv('TIMESHEET_MAX_DAILY_HOURS', '9', async () => {
  const timesheet = [{
    date: '2026-08-01',
    totalHours: 8,
    meetingMinutes: 0,
    entries: [{
      date: '2026-08-01',
      ticketId: 'PF-1234',
      hours: 1,
      secondsSpent: 3600,
      durationMinutes: 60,
      repos: ['PF/repo'],
      commitHashes: ['def67890'],
      commitMessages: ['work'],
      commitHash: 'def67890',
      commitMessage: 'work',
      matchingKey: 'def67890-first-half',
    }],
  }];

  const posted = [];
  const fakeJiraClient = {
    get: withMockJiraUser((url) => {
      if (url.includes('/search')) {
        return Promise.resolve({ data: { issues: [{ key: 'PF-EXISTING' }] } });
      }
      if (url.includes('PF-EXISTING') && url.includes('/worklog')) {
        // Only 6h already managed — plenty of room under the 9h cap for one more hour.
        return Promise.resolve({
          data: {
            worklogs: [{ started: '2026-08-01T09:00:00.000+0000', timeSpentSeconds: 21600, comment: managedComment('cafebabe') }],
            total: 1,
            maxResults: 100,
          },
        });
      }
      if (url.includes('PF-1234') && url.includes('/worklog')) {
        return Promise.resolve({ data: { worklogs: [], total: 0, maxResults: 100 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    post: (url, body) => {
      posted.push({ url, body });
      return Promise.resolve({ data: {} });
    },
    put: () => Promise.reject(new Error('should not update — no existing worklog to match')),
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  assert.equal(posted.length, 1);
  assert.equal(results[0].status, 'uploaded');
}));

test('manually-typed worklogs never count toward the daily cap, so heavy manual logging never blocks this tool\'s own work', () => withEnv('TIMESHEET_MAX_DAILY_HOURS', '9', async () => {
  // Regression test: a day with a large volume of manually-typed worklogs (unrelated to this
  // tool) used to block ALL of this tool's own entries once the raw total crossed the cap —
  // meaning real commit-based work silently never got logged. The cap must only ever look at
  // what this tool itself has logged.
  const timesheet = [{
    date: '2026-08-01',
    totalHours: 8,
    meetingMinutes: 0,
    entries: [{
      date: '2026-08-01',
      ticketId: 'PF-1234',
      hours: 1,
      secondsSpent: 3600,
      durationMinutes: 60,
      repos: ['PF/repo'],
      commitHashes: ['aaaa1111'],
      commitMessages: ['work'],
      commitHash: 'aaaa1111',
      commitMessage: 'work',
      matchingKey: 'aaaa1111-first-half',
    }],
  }];

  const posted = [];
  const fakeJiraClient = {
    get: withMockJiraUser((url) => {
      if (url.includes('/search')) {
        return Promise.resolve({ data: { issues: [{ key: 'PF-MANUAL' }] } });
      }
      if (url.includes('PF-MANUAL') && url.includes('/worklog')) {
        // 40h of manually-typed worklogs (no managed marker) — nowhere near this tool's business.
        return Promise.resolve({
          data: {
            worklogs: [{ started: '2026-08-01T09:00:00.000+0000', timeSpentSeconds: 144000, comment: 'Attended the scrum call' }],
            total: 1,
            maxResults: 100,
          },
        });
      }
      if (url.includes('PF-1234') && url.includes('/worklog')) {
        return Promise.resolve({ data: { worklogs: [], total: 0, maxResults: 100 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    post: (url, body) => {
      posted.push({ url, body });
      return Promise.resolve({ data: {} });
    },
    put: () => Promise.reject(new Error('should not update — no existing worklog to match')),
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  assert.equal(posted.length, 1);
  assert.equal(results[0].status, 'uploaded');
}));

test('the AM and PM fixed-slot entries update their own separate worklogs, not the same one', async () => {
  // Regression test: findMatchingWorklog used to match fixed-allocation entries on just the
  // generic "Daily fixed allocation slot [" phrase plus duration — which is identical for both
  // the AM and PM slot (both always exactly 30min). Whichever entry got matched first "won" the
  // only worklog that check could ever find, and the other physical worklog was silently never
  // updated again, no matter how many times the generator re-ran.
  const timesheet = [{
    date: '2026-08-01',
    totalHours: 8,
    meetingMinutes: 0,
    entries: [
      {
        date: '2026-08-01',
        ticketId: 'PF-6863',
        hours: 0.5,
        secondsSpent: 1800,
        durationMinutes: 30,
        repos: [],
        commitHashes: [],
        commitMessages: [],
        commitHash: 'FIXED-AM',
        commitMessage: 'Daily first-half fixed allocation',
        matchingKey: 'PF-6863-first-half-fixed',
        isFixedAllocation: true,
      },
      {
        date: '2026-08-01',
        ticketId: 'PF-6863',
        hours: 0.5,
        secondsSpent: 1800,
        durationMinutes: 30,
        repos: [],
        commitHashes: [],
        commitMessages: [],
        commitHash: 'FIXED-PM',
        commitMessage: 'Daily second-half fixed allocation',
        matchingKey: 'PF-6863-second-half-fixed',
        isFixedAllocation: true,
      },
    ],
  }];

  const puts = [];
  const fakeJiraClient = {
    get: withMockJiraUser((url) => {
      if (url.includes('/worklog')) {
        return Promise.resolve({
          data: {
            worklogs: [
              { id: 'am-worklog', started: '2026-08-01T10:00:00.000+0000', timeSpentSeconds: 1800, comment: 'Worked on PF-6863. Daily fixed allocation slot [PF-6863-first-half-fixed].' },
              { id: 'pm-worklog', started: '2026-08-01T16:00:00.000+0000', timeSpentSeconds: 1800, comment: 'Worked on PF-6863. Daily fixed allocation slot [PF-6863-second-half-fixed].' },
            ],
            total: 2,
            maxResults: 100,
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    put: (url, body) => {
      puts.push({ url, body });
      return Promise.resolve({ data: {} });
    },
    post: () => Promise.reject(new Error('should not create — both slots already exist')),
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  assert.equal(puts.length, 2);
  assert.ok(puts.some((p) => p.url.includes('am-worklog')), 'AM entry should update the AM worklog');
  assert.ok(puts.some((p) => p.url.includes('pm-worklog')), 'PM entry should update the PM worklog');
  assert.equal(results.filter((r) => r.status === 'updated').length, 2);
});

test('a comment-matching worklog authored by someone else is never mistaken for ours to update', async () => {
  // Regression test for the actual root cause behind persistently "stuck" fixed-slot worklogs:
  // a shared ticket (PF-6863) can carry worklogs from a colleague running this same generator
  // against their own commits/calendar. The comment format and marker convention are identical,
  // so a comment-only match would try to PUT to a worklog we don't own — which fails (you can't
  // edit someone else's worklog) and, worse, means our own contribution for that day never gets
  // created at all, since the code stops after finding a "match". It must fall through to
  // creating our own worklog instead of touching a colleague's.
  const timesheet = [{
    date: '2026-08-01',
    totalHours: 8,
    meetingMinutes: 0,
    entries: [{
      date: '2026-08-01',
      ticketId: 'PF-6863',
      hours: 0.5,
      secondsSpent: 1800,
      durationMinutes: 30,
      repos: [],
      commitHashes: [],
      commitMessages: [],
      commitHash: 'FIXED-AM',
      commitMessage: 'Daily first-half fixed allocation',
      matchingKey: 'PF-6863-first-half-fixed',
      isFixedAllocation: true,
    }],
  }];

  const puts = [];
  const posted = [];
  const fakeJiraClient = {
    get: withMockJiraUser((url) => {
      if (url.includes('/search')) {
        // No other managed worklogs of ours logged today — plenty of room under the daily cap.
        return Promise.resolve({ data: { issues: [] } });
      }
      if (url.includes('/worklog')) {
        return Promise.resolve({
          data: {
            worklogs: [{
              id: 'colleague-worklog',
              started: '2026-08-01T10:00:00.000+0000',
              timeSpentSeconds: 1800,
              comment: 'Worked on PF-6863. Daily fixed allocation slot [PF-6863-first-half-fixed].',
              author: { name: 'colleague', emailAddress: 'colleague@example.com', key: 'JIRAUSER999' },
            }],
            total: 1,
            maxResults: 100,
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    }),
    put: (url, body) => {
      puts.push({ url, body });
      return Promise.reject(new Error('should not PUT to a worklog owned by someone else'));
    },
    post: (url, body) => {
      posted.push({ url, body });
      return Promise.resolve({ data: {} });
    },
  };

  const results = await uploadToJira(fakeJiraClient, timesheet, { dryRun: false });

  assert.equal(puts.length, 0, 'must never attempt to update a colleague\'s worklog');
  assert.equal(posted.length, 1, 'must create its own worklog instead');
  assert.equal(results[0].status, 'uploaded');
});
