#!/usr/bin/env node

'use strict';

require('dotenv').config();

const { createJiraClient, extractJiraCommentText, fetchExistingWorklogs, getErrorMessage, getJiraApiBasePath, retry } = require('./generate-timesheet');
const { isManagedWorklog } = require('./worklog-utils');

function parseArgs(argv) {
  let startDate = null;
  let endDate = null;
  let execute = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--startDate' && i + 1 < argv.length) {
      startDate = argv[++i];
    } else if (arg.startsWith('--startDate=')) {
      startDate = arg.split('=')[1];
    } else if (arg === '--endDate' && i + 1 < argv.length) {
      endDate = argv[++i];
    } else if (arg.startsWith('--endDate=')) {
      endDate = arg.split('=')[1];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      if (!startDate) {
        startDate = arg;
      } else if (!endDate) {
        endDate = arg;
      }
    }
  }

  if (!startDate) {
    console.error('Usage: node delete-worklogs-by-date.js YYYY-MM-DD [YYYY-MM-DD] [--execute]');
    console.error('Provide a start date (and optional end date) to delete managed worklogs in that range.');
    process.exit(1);
  }

  if (!endDate) {
    endDate = startDate;
  }

  if (startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { dates, execute };
}

async function main() {
  const { dates, execute } = parseArgs(process.argv.slice(2));
  const jiraClient = createJiraClient();

  console.log(`Target dates: ${dates.join(', ')}${execute ? '' : ' [dry-run]'}`);

  const jiraApiBasePath = getJiraApiBasePath();
  let allWorklogsDeleted = [];

  for (const date of dates) {
    let startAt = 0;
    const dateWorklogs = [];

    while (true) {
      const response = await retry(
        () => jiraClient.get(`${jiraApiBasePath}/search`, {
          params: {
            jql: `worklogDate = "${date}" AND worklogAuthor = currentUser()`,
            fields: 'summary',
            maxResults: 100,
            startAt,
          },
        }),
        3,
        `Jira search for ${date}`,
      );

      const issues = response.data.issues || [];
      for (const issue of issues) {
        const issueKey = issue.key;
        const worklogs = await fetchExistingWorklogs(jiraClient, issueKey);

        for (const wl of worklogs) {
          const startedDate = typeof wl.started === 'string' ? wl.started.slice(0, 10) : '';
          if (startedDate !== date) continue;

          const commentText = extractJiraCommentText(wl.comment);
          if (!isManagedWorklog(commentText)) continue;

          dateWorklogs.push({ issueKey, worklog: wl, commentText });
        }
      }

      startAt += issues.length;
      if (issues.length < 100) break;
    }

    if (dateWorklogs.length === 0) {
      console.log(`  ${date}: No managed worklogs found.`);
      continue;
    }

    console.log(`  ${date}: ${dateWorklogs.length} worklog(s) found`);

    for (const { issueKey, worklog, commentText } of dateWorklogs) {
      const time = typeof worklog.started === 'string' ? worklog.started.slice(11, 16) : '';
      const hours = (worklog.timeSpentSeconds / 3600).toFixed(2);
      console.log(`    ${issueKey} worklog ${worklog.id} ${time} ${hours}h ${commentText.slice(0, 80)}`);

      if (execute) {
        await retry(
          () => jiraClient.delete(`${jiraApiBasePath}/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklog.id)}`),
          3,
          `Worklog delete ${worklog.id}`,
        );
        allWorklogsDeleted.push(worklog.id);
      }
    }
  }

  if (execute) {
    console.log(`\nDeleted ${allWorklogsDeleted.length} worklog(s) across ${dates.join(', ')}.`);
  } else {
    console.log('\nDry run. Re-run with --execute to delete the worklogs listed above.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
