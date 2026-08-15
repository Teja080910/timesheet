'use strict';

/**
 * Shared helpers for identifying Jira worklogs created by this generator.
 * Used by both cleanup-jira-duplicates.js and delete-worklogs-by-date.js so the
 * "what counts as managed" definition can't drift between the two scripts.
 */

function isManagedWorklog(commentText) {
  return commentText.includes('Daily fixed allocation slot [')
    || commentText.includes('Entry [')
    || Boolean(commentText.match(/\[calendar-/));
}

module.exports = { isManagedWorklog };
