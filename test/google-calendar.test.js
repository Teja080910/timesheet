'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectPaginatedEvents } = require('../google-calendar');

function page(items, nextPageToken) {
  return Promise.resolve({ data: { items, nextPageToken } });
}

test('collectPaginatedEvents follows nextPageToken across multiple pages', async () => {
  // Regression test: a real 30-day run silently dropped every event after the first page
  // (~84 of what should have been 150+) because the original code never looked at
  // nextPageToken at all — it just took whatever the first response happened to contain.
  const pages = [
    () => page([{ id: 'a' }, { id: 'b' }], 'token-1'),
    () => page([{ id: 'c' }], 'token-2'),
    () => page([{ id: 'd' }], undefined),
  ];
  let call = 0;
  const fetchPage = () => pages[call++]();

  const result = await collectPaginatedEvents(fetchPage, 100);

  assert.equal(call, 3);
  assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.equal(result.truncated, false);
});

test('collectPaginatedEvents stops at maxEvents and reports truncation', async () => {
  // A real API honors maxResults, so page 2 only returns as many items as were requested.
  const pages = [
    () => page([{ id: 'a' }, { id: 'b' }], 'token-1'),
    (opts) => page([{ id: 'c' }, { id: 'd' }].slice(0, opts.maxResults), 'token-2'),
  ];
  let call = 0;
  const fetchPage = (opts) => pages[call++](opts);

  const result = await collectPaginatedEvents(fetchPage, 3);

  assert.equal(call, 2);
  assert.equal(result.items.length, 3);
  assert.equal(result.truncated, true);
});

test('collectPaginatedEvents handles a single page with no token cleanly', async () => {
  const fetchPage = () => page([{ id: 'only' }], undefined);

  const result = await collectPaginatedEvents(fetchPage, 100);

  assert.deepEqual(result.items.map((i) => i.id), ['only']);
  assert.equal(result.truncated, false);
});
