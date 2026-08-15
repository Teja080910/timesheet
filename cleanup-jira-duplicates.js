#!/usr/bin/env node

'use strict';

require('dotenv').config();

const {
  buildWorklogComment,
  createJiraClient,
  extractJiraCommentText,
  fetchExistingWorklogs,
  getErrorMessage,
  getJiraApiBasePath,
  parseArgs,
  retry,
  runGenerator,
} = require('./generate-timesheet');
const { isManagedWorklog } = require('./worklog-utils');

const SECOND_HALF_START_MINUTES = 14 * 60 + 30;
const SECOND_HALF_END_MINUTES = 19 * 60 + 30;

function parseCleanupArgs(argv) {
  const baseArgs = parseArgs(argv);
  const execute = argv.includes('--execute');

  return {
    startDate: baseArgs.startDate,
    endDate: baseArgs.endDate,
    days: baseArgs.days,
    dryRun: !execute,
  };
}

function extractMarker(commentText) {
  const match = commentText.match(/(?:Entry|slot) \[([^\]]+)\]/);
  return match ? match[1] : '';
}

function extractCommitHash(commentText) {
  const match = commentText.match(/Commit ([a-f0-9]{8})\./i);
  return match ? match[1].toLowerCase() : '';
}

function getStartedMinutes(started) {
  const match = String(started || '').match(/T(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return (Number(match[1]) * 60) + Number(match[2]);
}

function getBucketFromStarted(started) {
  const minutes = getStartedMinutes(started);
  if (minutes === null) {
    return 'unknown';
  }

  if (minutes < SECOND_HALF_START_MINUTES) {
    return 'first-half';
  }

  if (minutes < SECOND_HALF_END_MINUTES) {
    return 'second-half';
  }

  return 'night';
}

function getBucketFromExpectedEntry(entry) {
  if (!entry.segment) {
    const minutes = entry.startMinutes;
    if (minutes == null) return 'unknown';
    if (minutes < SECOND_HALF_START_MINUTES) return 'first-half';
    if (minutes < SECOND_HALF_END_MINUTES) return 'second-half';
    return 'night';
  }

  if (entry.segment.startsWith('first-half')) {
    return 'first-half';
  }

  if (entry.segment.startsWith('second-half')) {
    return 'second-half';
  }

  return 'night';
}

function describeExpectedEntry(issueKey, entry) {
  const comment = buildWorklogComment(issueKey, entry);

  return {
    issueKey,
    date: entry.date,
    comment,
    marker: extractMarker(comment),
    commitHash: entry.isFixedAllocation ? '' : entry.commitHash.slice(0, 8).toLowerCase(),
    secondsSpent: entry.secondsSpent,
    bucket: getBucketFromExpectedEntry(entry),
    isFixedAllocation: Boolean(entry.isFixedAllocation),
  };
}

function describeExistingWorklog(issueKey, worklog) {
  const commentText = extractJiraCommentText(worklog.comment);

  return {
    issueKey,
    id: worklog.id,
    started: worklog.started,
    date: typeof worklog.started === 'string' ? worklog.started.slice(0, 10) : '',
    commentText,
    marker: extractMarker(commentText),
    commitHash: extractCommitHash(commentText),
    secondsSpent: Number(worklog.timeSpentSeconds || 0),
    bucket: getBucketFromStarted(worklog.started),
    isFixedAllocation: commentText.includes('Daily fixed allocation slot ['),
    created: worklog.created || '',
  };
}

function scoreCandidate(expectedEntry, existingWorklog) {
  let score = 0;

  if (expectedEntry.comment === existingWorklog.commentText) {
    score += 1000;
  }

  if (expectedEntry.marker && expectedEntry.marker === existingWorklog.marker) {
    score += 400;
  }

  if (expectedEntry.isFixedAllocation === existingWorklog.isFixedAllocation) {
    score += 100;
  }

  if (!expectedEntry.isFixedAllocation && expectedEntry.commitHash && expectedEntry.commitHash === existingWorklog.commitHash) {
    score += 250;
  }

  if (expectedEntry.secondsSpent === existingWorklog.secondsSpent) {
    score += 75;
  }

  if (expectedEntry.bucket === existingWorklog.bucket) {
    score += 60;
  }

  return score;
}

function selectWorklogsToKeep(expectedEntries, existingWorklogs) {
  const remaining = [...existingWorklogs];
  const keepIds = new Set();

  for (const expectedEntry of expectedEntries) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const score = scoreCandidate(expectedEntry, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0) {
      keepIds.add(remaining[bestIndex].id);
      remaining.splice(bestIndex, 1);
    }
  }

  return keepIds;
}

function buildExpectedEntries(result) {
  const byGroup = new Map();

  // Calendar/meeting entries are uploaded to Jira just like commit entries (see
  // uploadToJira/buildWorklogComment), so they count as "expected" here too — otherwise a
  // legitimately-uploaded meeting worklog would look unexpected and get deleted as a duplicate.
  for (const day of result.timesheet || []) {
    for (const entry of day.entries || []) {
      const issueKey = entry.ticketId;
      const key = `${issueKey}::${entry.date}`;
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
      }

      byGroup.get(key).push(describeExpectedEntry(issueKey, entry));
    }
  }

  return byGroup;
}

function collectIssueKeys(result) {
  const issueKeys = new Set();

  for (const day of result.timesheet || []) {
    for (const entry of day.entries || []) {
      issueKeys.add(entry.ticketId);
    }
  }

  return [...issueKeys].sort();
}

function isDateInRange(date, startDate, endDate) {
  return date >= startDate && date <= endDate;
}

async function findDuplicateCleanupPlan(jiraClient, generatedResult) {
  const expectedEntriesByGroup = buildExpectedEntries(generatedResult);
  const issueKeys = collectIssueKeys(generatedResult);
  const deletions = [];
  const kept = [];

  for (const issueKey of issueKeys) {
    const existingWorklogs = await fetchExistingWorklogs(jiraClient, issueKey);
    const existingByGroup = new Map();

    for (const worklog of existingWorklogs) {
      const described = describeExistingWorklog(issueKey, worklog);
      if (!isDateInRange(described.date, generatedResult.filters.startDate, generatedResult.filters.endDate)) {
        continue;
      }

      if (!isManagedWorklog(described.commentText)) {
        continue;
      }

      const key = `${issueKey}::${described.date}`;
      if (!existingByGroup.has(key)) {
        existingByGroup.set(key, []);
      }

      existingByGroup.get(key).push(described);
    }

    for (const [groupKey, groupWorklogs] of existingByGroup.entries()) {
      const expectedEntries = expectedEntriesByGroup.get(groupKey) || [];
      const keepIds = selectWorklogsToKeep(expectedEntries, groupWorklogs);

      for (const worklog of groupWorklogs) {
        if (keepIds.has(worklog.id)) {
          kept.push(worklog);
        } else {
          deletions.push(worklog);
        }
      }
    }
  }

  return {
    issueKeys,
    kept,
    deletions,
  };
}

async function deleteWorklogs(jiraClient, deletions) {
  const deleted = [];
  const failed = [];

  for (const worklog of deletions) {
    try {
      await retry(
        () => jiraClient.delete(
          `${getJiraApiBasePath()}/issue/${encodeURIComponent(worklog.issueKey)}/worklog/${encodeURIComponent(worklog.id)}`,
        ),
        3,
        `Worklog delete for ${worklog.issueKey} on ${worklog.date}`,
      );

      deleted.push(worklog);
      console.log(`[DELETED] ${worklog.date} ${worklog.issueKey} worklog ${worklog.id} ${worklog.secondsSpent}s ${worklog.commentText}`);
    } catch (error) {
      // Don't let one un-deletable worklog (e.g. permission errors on worklogs owned by someone
      // else) abort the whole run and leave every remaining duplicate undeleted — skip it and
      // keep going, same as uploadToJira does for individual upload failures.
      failed.push({ ...worklog, error: getErrorMessage(error) });
      console.error(`[FAILED] ${worklog.date} ${worklog.issueKey} worklog ${worklog.id}: ${getErrorMessage(error)}`);
    }
  }

  return { deleted, failed };
}

async function main() {
  const cliArgs = parseCleanupArgs(process.argv.slice(2));
  const generatedResult = await runGenerator({
    dryRun: true,
    startDate: cliArgs.startDate,
    endDate: cliArgs.endDate,
    days: cliArgs.days,
  }, { persistOutput: false });

  const jiraClient = createJiraClient();
  const plan = await findDuplicateCleanupPlan(jiraClient, generatedResult);

  console.log(
    `Cleanup scan for ${generatedResult.filters.startDate} to ${generatedResult.filters.endDate}`
    + `${cliArgs.dryRun ? ' [dry-run]' : ''}. Issues: ${plan.issueKeys.join(', ')}`,
  );
  console.log(`Managed worklogs kept: ${plan.kept.length}`);
  console.log(`Managed worklogs marked for deletion: ${plan.deletions.length}`);

  if (plan.deletions.length === 0) {
    console.log('No duplicate Jira worklogs found for the selected date range.');
    return;
  }

  for (const worklog of plan.deletions) {
    console.log(`[DELETE] ${worklog.date} ${worklog.issueKey} worklog ${worklog.id} ${worklog.secondsSpent}s ${worklog.commentText}`);
  }

  if (cliArgs.dryRun) {
    console.log('\nDry run only. Re-run with --execute to delete the worklogs listed above.');
    return;
  }

  const { deleted, failed } = await deleteWorklogs(jiraClient, plan.deletions);
  console.log(`\nDeleted ${deleted.length} of ${plan.deletions.length} duplicate Jira worklog(s).`);
  if (failed.length > 0) {
    console.log(`${failed.length} worklog(s) could not be deleted (see [FAILED] lines above) — usually because they belong to someone else and this token lacks permission to remove them.`);
  }
  console.log('Run the generator again for the same date range if you want Jira to reflect the current deterministic schedule exactly.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
