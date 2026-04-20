#!/usr/bin/env node

'use strict';

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const TICKET_REGEX = /PF-\d+/i;
const DEFAULT_LOOKBACK_DAYS = 7;
const MIN_WORKDAY_MINUTES = 8 * 60;
const MAX_WORKDAY_MINUTES = 10 * 60;
const DAILY_RANDOM_STEP_MINUTES = 5;
const FIXED_DAILY_TICKET = 'PF-6863';
const FIXED_SLOT_MINUTES = 30;
const FIRST_HALF_MINUTES = 3 * 60;
const SECOND_HALF_MINUTES = 5 * 60;
const FIRST_HALF_WORK_MINUTES = FIRST_HALF_MINUTES - FIXED_SLOT_MINUTES;
const SECOND_HALF_WORK_MINUTES = SECOND_HALF_MINUTES - FIXED_SLOT_MINUTES;
const FIRST_HALF_START_MINUTES = 9 * 60 + 30;
const SECOND_HALF_START_MINUTES = 14 * 60 + 30;
const SLOT_MINUTES = 5;
const OUTPUT_FILE = path.join(process.cwd(), 'timesheet.json');
const COMMITS_OUTPUT_FILE = path.join(process.cwd(), 'commits-today.json');

function parseArgs(argv) {
  const args = {
    dryRun: false,
    startDate: null,
    endDate: null,
    days: DEFAULT_LOOKBACK_DAYS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (arg === '--startDate' && argv[index + 1]) {
      args.startDate = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--startDate=')) {
      args.startDate = arg.split('=')[1];
      continue;
    }

    if (arg === '--endDate' && argv[index + 1]) {
      args.endDate = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--endDate=')) {
      args.endDate = arg.split('=')[1];
      continue;
    }

    if (arg === '--days' && argv[index + 1]) {
      args.days = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--days=')) {
      args.days = Number(arg.split('=')[1]);
      continue;
    }

    if (!args.startDate && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      args.startDate = arg;
      continue;
    }

    if (!args.endDate && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      args.endDate = arg;
    }
  }

  return args;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateInput(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format.`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} is not a valid date.`);
  }

  return parsed;
}

function resolveDateRange(cliArgs) {
  if (!Number.isFinite(cliArgs.days) || cliArgs.days <= 0) {
    throw new Error('days must be a positive number.');
  }

  const today = new Date();
  const endDate = cliArgs.endDate
    ? parseDateInput(cliArgs.endDate, 'endDate')
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const startDate = cliArgs.startDate
    ? parseDateInput(cliArgs.startDate, 'startDate')
    : new Date(endDate.getTime() - Math.max(cliArgs.days - 1, 0) * 24 * 60 * 60 * 1000);

  if (startDate > endDate) {
    throw new Error('startDate cannot be after endDate.');
  }

  return {
    startDate,
    endDate,
    startDateStr: formatDate(startDate),
    endDateStr: formatDate(endDate),
  };
}

function validateEnv(options = {}) {
  const required = [
    'BITBUCKET_BASE_URL',
    'BITBUCKET_TOKEN',
    'BITBUCKET_REPOS',
  ];

  if (!options.dryRun) {
    required.push('JIRA_BASE_URL');

    const jiraAuthType = getJiraAuthType();
    if (jiraAuthType === 'bearer') {
      required.push('JIRA_TOKEN');
    } else {
      const hasBasicUser = Boolean(process.env.JIRA_USERNAME || process.env.JIRA_EMAIL);
      const hasBasicSecret = Boolean(process.env.JIRA_PASSWORD || process.env.JIRA_API_TOKEN);
      if (!hasBasicUser) {
        required.push('JIRA_USERNAME');
      }
      if (!hasBasicSecret) {
        required.push('JIRA_PASSWORD');
      }
    }
  }

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function createBitbucketClient() {
  return axios.create({
    baseURL: process.env.BITBUCKET_BASE_URL.replace(/\/+$/, ''),
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${process.env.BITBUCKET_TOKEN}`,
      Accept: 'application/json',
    },
  });
}

function getConfiguredRepos() {
  const repos = (process.env.BITBUCKET_REPOS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    throw new Error('BITBUCKET_REPOS must contain at least one PROJECT_KEY/repository-slug entry.');
  }

  return repos.map((value) => {
    const [projectKey, repoSlug, ...rest] = value.split('/').map((part) => part.trim()).filter(Boolean);
    if (!projectKey || !repoSlug || rest.length > 0) {
      throw new Error(`Invalid BITBUCKET_REPOS entry "${value}". Use PROJECT_KEY/repository-slug.`);
    }

    return {
      key: `${projectKey}/${repoSlug}`,
      projectKey,
      repoSlug,
    };
  });
}

function getConfiguredBranches() {
  return (process.env.BITBUCKET_BRANCHES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getConfiguredBranchPatterns() {
  return (process.env.BITBUCKET_BRANCH_PATTERNS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getConfiguredMaxBranches() {
  const rawValue = (process.env.BITBUCKET_MAX_BRANCHES || '').trim();
  if (!rawValue) {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('BITBUCKET_MAX_BRANCHES must be a positive number.');
  }

  return Math.floor(parsed);
}

function getConfiguredAuthorEmails() {
  return (process.env.BITBUCKET_AUTHOR_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getJiraAuthType() {
  const configured = (process.env.JIRA_AUTH_TYPE || '').trim().toLowerCase();
  if (configured === 'basic' || configured === 'bearer') {
    return configured;
  }

  if (process.env.JIRA_TOKEN) {
    return 'bearer';
  }

  return 'basic';
}

function getJiraApiVersion() {
  const configured = (process.env.JIRA_API_VERSION || '').trim();
  if (configured) {
    return configured;
  }

  return process.env.JIRA_BASE_URL.includes('atlassian.net') ? '3' : '2';
}

function getJiraApiBasePath() {
  return `/rest/api/${getJiraApiVersion()}`;
}

function getWorklogTimezoneOffset() {
  const configured = (process.env.JIRA_WORKLOG_TIMEZONE_OFFSET || '').trim();
  if (!configured) {
    return '+0000';
  }

  if (!/^[+-]\d{4}$/.test(configured)) {
    throw new Error('JIRA_WORKLOG_TIMEZONE_OFFSET must use the format +0000 or +0530.');
  }

  return configured;
}

function createJiraClient() {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (getJiraAuthType() === 'bearer') {
    headers.Authorization = `Bearer ${process.env.JIRA_TOKEN}`;
  } else {
    const username = process.env.JIRA_USERNAME || process.env.JIRA_EMAIL;
    const password = process.env.JIRA_PASSWORD || process.env.JIRA_API_TOKEN;
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');
    headers.Authorization = `Basic ${basicAuth}`;
  }

  return axios.create({
    baseURL: process.env.JIRA_BASE_URL.replace(/\/+$/, ''),
    timeout: 30000,
    headers,
  });
}

function extractTicket(commitMessage, branchNames = []) {
  const messageMatch = commitMessage?.match(TICKET_REGEX);
  if (messageMatch) {
    return messageMatch[0].toUpperCase();
  }

  for (const branchName of branchNames) {
    const branchMatch = branchName?.match(TICKET_REGEX);
    if (branchMatch) {
      return branchMatch[0].toUpperCase();
    }
  }

  return 'PF-16716';
}

function extractCommitAuthorEmails(commit) {
  const values = [
    commit.author?.emailAddress,
    commit.author?.name,
    commit.author?.displayName,
  ];

  const detected = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
    for (const match of matches) {
      detected.push(match.toLowerCase());
    }
  }

  return Array.from(new Set(detected));
}

function commitMatchesAuthorFilter(commit) {
  const allowedEmails = getConfiguredAuthorEmails();
  if (allowedEmails.length === 0) {
    return true;
  }

  const commitEmails = extractCommitAuthorEmails(commit);
  return allowedEmails.some((email) => commitEmails.includes(email));
}

function parseBitbucketTimestamp(commit) {
  const rawValue = commit.authorTimestamp ?? commit.committerTimestamp ?? commit.authorTimestampMillis;
  if (typeof rawValue === 'number') {
    const milliseconds = rawValue > 1e12 ? rawValue : rawValue * 1000;
    return new Date(milliseconds);
  }

  if (typeof commit.authorTimestamp === 'string') {
    return new Date(commit.authorTimestamp);
  }

  throw new Error(`Commit ${commit.id || 'unknown'} does not contain a supported timestamp.`);
}

function isWeekend(dateString) {
  const dayOfWeek = new Date(`${dateString}T00:00:00.000Z`).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

async function fetchPaginatedValues(requestPage) {
  const values = [];
  let start = 0;
  let pageNumber = 0;
  let isLastPage = false;

  while (!isLastPage) {
    pageNumber += 1;
    const response = await retry(
      () => requestPage(start, pageNumber),
      3,
      `Bitbucket page fetch ${pageNumber}`,
    );

    const pageValues = response.data.values || [];
    values.push(...pageValues);
    isLastPage = Boolean(response.data.isLastPage);
    start = Number(response.data.nextPageStart ?? start + pageValues.length);

    if (pageValues.length === 0 && !isLastPage) {
      break;
    }
  }

  return values;
}

async function fetchBranches(bitbucketClient, repoConfig) {
  const configuredBranches = getConfiguredBranches();
  if (configuredBranches.length > 0) {
    return configuredBranches.map((branchName) => ({
      id: branchName,
      name: branchName,
    }));
  }

  const basePath = `/rest/api/latest/projects/${encodeURIComponent(repoConfig.projectKey)}/repos/${encodeURIComponent(repoConfig.repoSlug)}`;
  const branches = await fetchPaginatedValues((start) => bitbucketClient.get(`${basePath}/branches`, {
    params: {
      start,
      limit: 100,
    },
  }));

  let normalizedBranches = branches.map((branch) => ({
    id: branch.id,
    name: branch.displayId || branch.id,
  }));

  const branchPatterns = getConfiguredBranchPatterns();
  if (branchPatterns.length > 0) {
    normalizedBranches = normalizedBranches.filter((branch) => {
      const branchName = branch.name.toLowerCase();
      return branchPatterns.some((pattern) => branchName.includes(pattern));
    });
  }

  const maxBranches = getConfiguredMaxBranches();
  if (maxBranches) {
    normalizedBranches = normalizedBranches.slice(0, maxBranches);
  }

  return normalizedBranches;
}

async function fetchCommitsForBranch(bitbucketClient, repoConfig, branch, range) {
  const basePath = `/rest/api/latest/projects/${encodeURIComponent(repoConfig.projectKey)}/repos/${encodeURIComponent(repoConfig.repoSlug)}`;
  const commits = [];
  let start = 0;
  let pageNumber = 0;
  let isLastPage = false;
  let stopBranchScan = false;

  while (!isLastPage && !stopBranchScan) {
    pageNumber += 1;
    const response = await retry(
      () => bitbucketClient.get(`${basePath}/commits`, {
        params: {
          until: branch.id,
          start,
          limit: 100,
        },
      }),
      3,
      `Bitbucket commits fetch ${repoConfig.key} ${branch.name} page ${pageNumber}`,
    );

    const pageValues = response.data.values || [];

    for (const commit of pageValues) {
      const commitDate = formatDate(parseBitbucketTimestamp(commit));
      if (commitDate < range.startDateStr) {
        stopBranchScan = true;
        break;
      }

      if (commitDate > range.endDateStr || isWeekend(commitDate)) {
        continue;
      }

      if (!commitMatchesAuthorFilter(commit)) {
        continue;
      }

      const authorEmails = extractCommitAuthorEmails(commit);

      commits.push({
        hash: commit.id,
        date: commitDate,
        message: (commit.message || '').trim(),
        branchNames: [branch.name],
        repo: repoConfig.key,
        ticketId: extractTicket(commit.message, [branch.name]),
        author: commit.author?.displayName || commit.author?.name || authorEmails[0] || '',
        authorEmails,
      });
    }

    isLastPage = Boolean(response.data.isLastPage);
    start = Number(response.data.nextPageStart ?? start + pageValues.length);
  }

  return commits;
}

async function fetchCommits(bitbucketClient, range, repoConfig) {
  const branches = await fetchBranches(bitbucketClient, repoConfig);
  const dedupedCommits = new Map();

  const authorFilter = getConfiguredAuthorEmails();
  const branchPatterns = getConfiguredBranchPatterns();
  const maxBranches = getConfiguredMaxBranches();
  console.log(
    `Scanning ${repoConfig.key} across ${branches.length} branch(es)`
    + `${authorFilter.length > 0 ? ` for authors: ${authorFilter.join(', ')}` : ''}`
    + `${branchPatterns.length > 0 ? ` using branch patterns: ${branchPatterns.join(', ')}` : ''}`
    + `${maxBranches ? ` with max branches: ${maxBranches}` : ''}`,
  );

  for (const branch of branches) {
    try {
      const branchCommits = await fetchCommitsForBranch(bitbucketClient, repoConfig, branch, range);
      for (const commit of branchCommits) {
        const existing = dedupedCommits.get(commit.hash);
        if (existing) {
          existing.branchNames = Array.from(new Set([...existing.branchNames, ...commit.branchNames])).sort();
          existing.ticketId = extractTicket(existing.message, existing.branchNames);
          continue;
        }

        dedupedCommits.set(commit.hash, commit);
      }
    } catch (error) {
      console.error(`[FAILED] Fetching branch ${branch.name} from ${repoConfig.key}: ${getErrorMessage(error)}`);
    }
  }

  const commits = Array.from(dedupedCommits.values());
  console.log(`Fetched ${commits.length} unique weekday commits from ${repoConfig.key} across ${branches.length} branch(es).`);
  return commits;
}

function summarizeCommitMessage(message) {
  const normalized = (message || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 100) {
    return normalized;
  }

  return `${normalized.slice(0, 97)}...`;
}

function printCommitSummary(commits) {
  console.log('\nCommit summary:\n');

  if (commits.length === 0) {
    console.log('Total matched commits: 0');
    return;
  }

  const byRepo = new Map();
  const byDate = new Map();

  for (const commit of commits) {
    byRepo.set(commit.repo, (byRepo.get(commit.repo) || 0) + 1);
    byDate.set(commit.date, (byDate.get(commit.date) || 0) + 1);
  }

  console.log(`Total matched commits: ${commits.length}`);

  for (const [date, count] of [...byDate.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`${date}: ${count} commit(s)`);
  }

  for (const [repo, count] of [...byRepo.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`${repo}: ${count} commit(s)`);
  }
}

function buildCommitSummary(commits) {
  const byRepo = {};
  const byDate = {};

  for (const commit of commits) {
    byRepo[commit.repo] = (byRepo[commit.repo] || 0) + 1;
    byDate[commit.date] = (byDate[commit.date] || 0) + 1;
  }

  return {
    totalMatchedCommits: commits.length,
    byDate,
    byRepo,
  };
}

function buildMatchedCommitsPayload(commits) {
  return commits
    .map((commit) => ({
      date: commit.date,
      repo: commit.repo,
      ticketId: commit.ticketId,
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 8),
      branchNames: commit.branchNames,
      author: commit.author,
      authorEmails: commit.authorEmails,
      message: commit.message,
    }))
    .sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }

      if (left.repo !== right.repo) {
        return left.repo.localeCompare(right.repo);
      }

      return left.hash.localeCompare(right.hash);
    });
}

function printMatchedCommits(commits) {
  console.log('\nMatched commits:\n');

  if (commits.length === 0) {
    console.log('No commits matched the current date/author filters.');
    return;
  }

  const sortedCommits = [...commits].sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }

    if (left.repo !== right.repo) {
      return left.repo.localeCompare(right.repo);
    }

    return left.hash.localeCompare(right.hash);
  });

  for (const commit of sortedCommits) {
    console.log(
      `${commit.date} ${commit.repo} ${commit.ticketId} ${commit.hash.slice(0, 8)} ${summarizeCommitMessage(commit.message)}`,
    );
  }
}

function groupCommits(commits) {
  const grouped = new Map();

  for (const commit of commits) {
    if (!grouped.has(commit.date)) {
      grouped.set(commit.date, new Map());
    }

    const tickets = grouped.get(commit.date);
    if (!tickets.has(commit.ticketId)) {
      tickets.set(commit.ticketId, []);
    }

    tickets.get(commit.ticketId).push(commit);
  }

  return grouped;
}

function distributeUnits(totalUnits, weights) {
  const exactAllocations = weights.map((weight) => weight * totalUnits);
  const floorAllocations = exactAllocations.map((value) => Math.floor(value));
  let remaining = totalUnits - floorAllocations.reduce((sum, value) => sum + value, 0);

  const byRemainder = exactAllocations
    .map((value, index) => ({ index, remainder: value - floorAllocations[index] }))
    .sort((left, right) => {
      if (right.remainder !== left.remainder) {
        return right.remainder - left.remainder;
      }
      return left.index - right.index;
    });

  while (remaining > 0) {
    for (const item of byRemainder) {
      if (remaining === 0) {
        break;
      }
      floorAllocations[item.index] += 1;
      remaining -= 1;
    }
  }

  return floorAllocations;
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function getDeterministicInt(seed, maxExclusive) {
  if (maxExclusive <= 0) {
    return 0;
  }

  return hashString(seed) % maxExclusive;
}

function minutesToHours(minutes) {
  return Number((minutes / 60).toFixed(2));
}

function buildDailyTargetMinutes(dates) {
  if (dates.length === 0) {
    return new Map();
  }

  const targets = new Map();
  const guaranteedEightHourIndex = getDeterministicInt(dates.join('|'), dates.length);

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    if (index === guaranteedEightHourIndex) {
      targets.set(date, MIN_WORKDAY_MINUTES);
      continue;
    }

    targets.set(
      date,
      (MIN_WORKDAY_MINUTES + DAILY_RANDOM_STEP_MINUTES)
        + (getDeterministicInt(
          `${date}:daily-total`,
          Math.floor((MAX_WORKDAY_MINUTES - (MIN_WORKDAY_MINUTES + DAILY_RANDOM_STEP_MINUTES)) / DAILY_RANDOM_STEP_MINUTES) + 1,
        ) * DAILY_RANDOM_STEP_MINUTES),
    );
  }

  return targets;
}

function getDeterministicFixedSlotStart(seed, halfStartMinutes, halfDurationMinutes) {
  const availableOffsets = ((halfDurationMinutes - FIXED_SLOT_MINUTES) / SLOT_MINUTES) + 1;
  return halfStartMinutes + (getDeterministicInt(seed, availableOffsets) * SLOT_MINUTES);
}

function generateHours(groupedCommits) {
  const dates = Array.from(groupedCommits.keys()).sort();
  const dailyTargetMinutes = buildDailyTargetMinutes(dates);
  const timesheet = [];

  for (const date of dates) {
    const tickets = groupedCommits.get(date);
    const entries = Array.from(tickets.entries()).map(([ticketId, commits]) => ({
      ticketId,
      commits,
      commitCount: commits.length,
    }));

    const totalCommits = entries.reduce((sum, entry) => sum + entry.commitCount, 0);
    const dailyMinutes = dailyTargetMinutes.get(date) || MIN_WORKDAY_MINUTES;
    const commitMinutesAvailable = dailyMinutes - (FIXED_SLOT_MINUTES * 2);
    const commitUnitsAvailable = commitMinutesAvailable / SLOT_MINUTES;
    const weights = entries.map((entry) => entry.commitCount / totalCommits);
    const allocations = distributeUnits(commitUnitsAvailable, weights);

    const dayEntries = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const ticketUnits = allocations[index];
      const commitWeights = entry.commits.map(() => 1 / entry.commits.length);
      const commitAllocations = distributeUnits(ticketUnits, commitWeights);

      for (let commitIndex = 0; commitIndex < entry.commits.length; commitIndex += 1) {
        const commit = entry.commits[commitIndex];
        const commitUnits = commitAllocations[commitIndex];
        if (commitUnits <= 0) {
          continue;
        }

        const durationMinutes = commitUnits * SLOT_MINUTES;

        dayEntries.push({
          date,
          ticketId: entry.ticketId,
          hours: minutesToHours(durationMinutes),
          secondsSpent: durationMinutes * 60,
          durationMinutes,
          commitCount: 1,
          repos: [commit.repo],
          commitHashes: [commit.hash],
          commitMessages: commit.message ? [commit.message] : [],
          commitHash: commit.hash,
          commitMessage: commit.message || '',
          matchingKey: commit.hash.slice(0, 8),
        });
      }
    }

    const dailySchedule = buildDailySchedule(date, dayEntries, dailyMinutes);
    const scheduledCommitEntries = dailySchedule.commitEntries;
    const fixedEntries = dailySchedule.fixedEntries;
    const allEntries = [...fixedEntries, ...scheduledCommitEntries].sort((left, right) => {
      if (left.startMinutes !== right.startMinutes) {
        return left.startMinutes - right.startMinutes;
      }

      return left.ticketId.localeCompare(right.ticketId);
    });

    const actualDailySeconds = allEntries.reduce((sum, entry) => sum + entry.secondsSpent, 0);
    const expectedDailySeconds = dailyMinutes * 60;
    if (actualDailySeconds !== expectedDailySeconds) {
      const actualDailyTotal = Number((actualDailySeconds / 3600).toFixed(4));
      throw new Error(`Generated daily total must equal ${minutesToHours(dailyMinutes)} hours for ${date}, received ${actualDailyTotal} hours.`);
    }

    timesheet.push({
      date,
      totalHours: minutesToHours(dailyMinutes),
      entries: allEntries,
    });
  }

  return timesheet;
}

function buildDailySchedule(date, entries, dailyMinutes) {
  const totalCommitMinutes = entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
  const expectedCommitMinutes = dailyMinutes - (FIXED_SLOT_MINUTES * 2);
  if (totalCommitMinutes !== expectedCommitMinutes) {
    throw new Error(`Commit allocations must equal ${minutesToHours(expectedCommitMinutes)} hours per day.`);
  }

  const overtimeMinutes = Math.max(dailyMinutes - MIN_WORKDAY_MINUTES, 0);
  const segmentDurations = [
    FIRST_HALF_WORK_MINUTES,
    SECOND_HALF_WORK_MINUTES,
    overtimeMinutes,
  ];
  const commitUnits = entries.map((entry) => entry.durationMinutes / SLOT_MINUTES);
  const totalCommitUnits = commitUnits.reduce((sum, value) => sum + value, 0);
  const segmentUnitCaps = segmentDurations.map((minutes) => minutes / SLOT_MINUTES);
  const firstHalfAllocations = distributeUnits(
    segmentUnitCaps[0],
    commitUnits.map((value) => value / totalCommitUnits),
  );
  const remainingAfterFirst = commitUnits.map((value, index) => value - firstHalfAllocations[index]);
  const secondHalfAllocations = distributeUnits(
    segmentUnitCaps[1],
    remainingAfterFirst.map((value) => value / remainingAfterFirst.reduce((sum, item) => sum + item, 0)),
  );
  const overtimeAllocations = remainingAfterFirst.map((value, index) => value - secondHalfAllocations[index]);

  const firstHalfFixedStart = getDeterministicFixedSlotStart(`${date}:first-half-fixed`, FIRST_HALF_START_MINUTES, FIRST_HALF_MINUTES);
  const secondHalfFixedStart = getDeterministicFixedSlotStart(`${date}:second-half-fixed`, SECOND_HALF_START_MINUTES, SECOND_HALF_MINUTES);
  const fixedEntries = [
    {
      date,
      ticketId: FIXED_DAILY_TICKET,
      hours: minutesToHours(FIXED_SLOT_MINUTES),
      secondsSpent: FIXED_SLOT_MINUTES * 60,
      durationMinutes: FIXED_SLOT_MINUTES,
      repos: [],
      commitHashes: [],
      commitMessages: [],
      commitHash: 'FIXED-AM',
      commitMessage: 'Daily first-half fixed allocation',
      segment: 'first-half-fixed',
      startMinutes: firstHalfFixedStart,
      matchingKey: `${FIXED_DAILY_TICKET}-first-half-fixed`,
      isFixedAllocation: true,
    },
    {
      date,
      ticketId: FIXED_DAILY_TICKET,
      hours: minutesToHours(FIXED_SLOT_MINUTES),
      secondsSpent: FIXED_SLOT_MINUTES * 60,
      durationMinutes: FIXED_SLOT_MINUTES,
      repos: [],
      commitHashes: [],
      commitMessages: [],
      commitHash: 'FIXED-PM',
      commitMessage: 'Daily second-half fixed allocation',
      segment: 'second-half-fixed',
      startMinutes: secondHalfFixedStart,
      matchingKey: `${FIXED_DAILY_TICKET}-second-half-fixed`,
      isFixedAllocation: true,
    },
  ];

  const commitEntries = [
    ...scheduleHalfEntries(entries, firstHalfAllocations, FIRST_HALF_START_MINUTES, FIRST_HALF_MINUTES, firstHalfFixedStart, 'first-half'),
    ...scheduleHalfEntries(entries, secondHalfAllocations, SECOND_HALF_START_MINUTES, SECOND_HALF_MINUTES, secondHalfFixedStart, 'second-half'),
    ...schedulePlainSegmentEntries(entries, overtimeAllocations, SECOND_HALF_START_MINUTES + SECOND_HALF_MINUTES, 'night'),
  ];

  return {
    fixedEntries,
    commitEntries,
  };
}

function scheduleHalfEntries(entries, allocations, segmentStartMinutes, segmentDurationMinutes, fixedSlotStartMinutes, segmentName) {
  const totalUnits = allocations.reduce((sum, value) => sum + value, 0);
  if (totalUnits === 0) {
    return [];
  }

  const beforeFixedUnits = (fixedSlotStartMinutes - segmentStartMinutes) / SLOT_MINUTES;
  const afterFixedUnits = ((segmentStartMinutes + segmentDurationMinutes) - (fixedSlotStartMinutes + FIXED_SLOT_MINUTES)) / SLOT_MINUTES;
  let remainingBeforeUnits = beforeFixedUnits;
  const beforeAllocations = allocations.map((value) => {
    const assigned = Math.min(value, remainingBeforeUnits);
    remainingBeforeUnits -= assigned;
    return assigned;
  });
  const afterAllocations = allocations.map((value, index) => value - beforeAllocations[index]);

  if (afterAllocations.reduce((sum, value) => sum + value, 0) !== afterFixedUnits) {
    throw new Error(`Generated ${segmentName} schedule does not fit around fixed ticket placement.`);
  }

  return [
    ...schedulePlainSegmentEntries(entries, beforeAllocations, segmentStartMinutes, `${segmentName}-before`),
    ...schedulePlainSegmentEntries(entries, afterAllocations, fixedSlotStartMinutes + FIXED_SLOT_MINUTES, `${segmentName}-after`),
  ];
}

function schedulePlainSegmentEntries(entries, allocations, segmentStartMinutes, segmentName) {
  const scheduled = [];
  let cursor = segmentStartMinutes;

  for (let index = 0; index < entries.length; index += 1) {
    const allocatedUnits = allocations[index];
    if (allocatedUnits <= 0) {
      continue;
    }

    const durationMinutes = allocatedUnits * SLOT_MINUTES;
    scheduled.push({
      ...entries[index],
      hours: minutesToHours(durationMinutes),
      secondsSpent: durationMinutes * 60,
      durationMinutes,
      segment: segmentName,
      startMinutes: cursor,
      matchingKey: `${entries[index].matchingKey}-${segmentName}`,
    });
    cursor += durationMinutes;
  }

  return scheduled;
}

function buildWorklogComment(ticketId, entry) {
  if (entry.isFixedAllocation) {
    return `Worked on ${ticketId}. Daily fixed allocation slot [${entry.matchingKey}].`;
  }

  const normalizedMessage = (entry.commitMessage || '').replace(/\s+/g, ' ').trim();
  const summary = normalizedMessage ? ` Commit: ${normalizedMessage}` : '';
  return `Worked on ${ticketId} (development, fixes, improvements). Entry [${entry.matchingKey}]. Commit ${entry.commitHash.slice(0, 8)}.${summary}`;
}

function getStartedTimestamp(date, startMinutes = FIRST_HALF_START_MINUTES) {
  const hours = String(Math.floor(startMinutes / 60)).padStart(2, '0');
  const minutes = String(startMinutes % 60).padStart(2, '0');
  return `${date}T${hours}:${minutes}:00.000${getWorklogTimezoneOffset()}`;
}

function extractJiraCommentText(comment) {
  if (typeof comment === 'string') {
    return comment.trim();
  }

  if (!comment || typeof comment !== 'object') {
    return '';
  }

  const parts = [];
  for (const block of comment.content || []) {
    for (const item of block.content || []) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }

  return parts.join(' ').trim();
}

function findMatchingWorklog(worklogs, entry) {
  return (worklogs || []).find((worklog) => {
    if (typeof worklog.started !== 'string' || !worklog.started.startsWith(entry.date)) {
      return null;
    }

    const commentText = extractJiraCommentText(worklog.comment);
    return commentText.includes(`[${entry.matchingKey}]`);
  });
}

async function retry(fn, attempts, label) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }

      const delayMs = attempt * 1000;
      console.warn(`${label} failed on attempt ${attempt}/${attempts}: ${getErrorMessage(error)}. Retrying in ${delayMs}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function normalizeJiraComment(text) {
  if (getJiraApiVersion() !== '3') {
    return text;
  }

  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    ],
  };
}

async function uploadToJira(jiraClient, timesheet, options = {}) {
  const results = [];

  for (const day of timesheet) {
    for (const entry of day.entries) {
      const issueKey = entry.ticketId;
      const comment = buildWorklogComment(issueKey, entry);

      if (options.dryRun) {
        console.log(`[DRY RUN] ${day.date} ${issueKey} ${entry.hours}h ${entry.commitHash.slice(0, 8)} @ ${getStartedTimestamp(day.date, entry.startMinutes)}`);
        results.push({
          date: day.date,
          ticketId: issueKey,
          status: 'dry-run',
          hours: entry.hours,
          commitHash: entry.commitHash,
        });
        continue;
      }

      try {
        const existingWorklogs = await fetchExistingWorklogs(jiraClient, issueKey);
        const matchingWorklog = findMatchingWorklog(existingWorklogs, entry);
        if (matchingWorklog) {
          await retry(
            () => jiraClient.put(
              `${getJiraApiBasePath()}/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(matchingWorklog.id)}`,
              {
                started: getStartedTimestamp(day.date, entry.startMinutes),
                timeSpentSeconds: entry.secondsSpent,
                comment: normalizeJiraComment(comment),
              },
            ),
            3,
            `Worklog update for ${issueKey} on ${day.date}`,
          );

          console.log(`[UPDATED] ${day.date} ${issueKey} ${entry.commitHash.slice(0, 8)} (${entry.hours}h).`);
          results.push({
            date: day.date,
            ticketId: issueKey,
            status: 'updated',
            hours: entry.hours,
            commitHash: entry.commitHash,
            worklogId: matchingWorklog.id,
          });
          continue;
        }

        await retry(
          () => jiraClient.post(`${getJiraApiBasePath()}/issue/${encodeURIComponent(issueKey)}/worklog`, {
            started: getStartedTimestamp(day.date, entry.startMinutes),
            timeSpentSeconds: entry.secondsSpent,
            comment: normalizeJiraComment(comment),
          }),
          3,
          `Worklog upload for ${issueKey} on ${day.date}`,
        );

        console.log(`[SUCCESS] ${day.date} ${issueKey} uploaded (${entry.hours}h, ${entry.commitHash.slice(0, 8)}).`);
        results.push({
          date: day.date,
          ticketId: issueKey,
          status: 'uploaded',
          hours: entry.hours,
          commitHash: entry.commitHash,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        console.error(`[FAILED] ${day.date} ${issueKey} ${entry.commitHash.slice(0, 8)}: ${message}`);
        results.push({
          date: day.date,
          ticketId: issueKey,
          status: 'failed',
          hours: entry.hours,
          commitHash: entry.commitHash,
          error: message,
        });
      }
    }
  }

  return results;
}

async function fetchExistingWorklogs(jiraClient, issueKey) {
  const worklogs = [];
  let startAt = 0;
  let total = Infinity;

  while (startAt < total) {
    const response = await retry(
      () => jiraClient.get(`${getJiraApiBasePath()}/issue/${encodeURIComponent(issueKey)}/worklog`, {
        params: {
          startAt,
          maxResults: 100,
        },
      }),
      3,
      `Jira worklog fetch for ${issueKey}`,
    );

    const page = response.data.worklogs || [];
    worklogs.push(...page);
    total = Number(response.data.total || page.length);
    startAt += Number(response.data.maxResults || page.length || 100);

    if (page.length === 0) {
      break;
    }
  }

  return worklogs;
}

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

async function writeOutput(payload) {
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Saved output to ${OUTPUT_FILE}`);
}

async function writeCommitsOutput(payload) {
  await fs.writeFile(COMMITS_OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Saved output to ${COMMITS_OUTPUT_FILE}`);
}

function buildFilters(range, cliArgs, repoSlugs) {
  return {
    startDate: range.startDateStr,
    endDate: range.endDateStr,
    dryRun: cliArgs.dryRun,
    repos: repoSlugs.map((repo) => repo.key),
    branches: getConfiguredBranches(),
    branchPatterns: getConfiguredBranchPatterns(),
    maxBranches: getConfiguredMaxBranches(),
    authorEmails: getConfiguredAuthorEmails(),
  };
}

function printTimesheet(timesheet) {
  console.log('\nGenerated timesheet:\n');

  if (timesheet.length === 0) {
    console.log('No weekday commits found in the requested date range.');
    return;
  }

  for (const day of timesheet) {
    console.log(`${day.date} - ${day.totalHours.toFixed(2)}h`);
    for (const entry of day.entries) {
      console.log(
        `  ${entry.ticketId}: ${entry.hours.toFixed(2)}h (${entry.commitHash.slice(0, 8)}, repos: ${entry.repos.join(', ')})`,
      );
    }
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  await runGenerator(cliArgs, { persistOutput: true });
}

async function runGenerator(cliArgs = {}, options = {}) {
  const normalizedArgs = {
    dryRun: Boolean(cliArgs.dryRun),
    startDate: cliArgs.startDate || null,
    endDate: cliArgs.endDate || null,
    days: cliArgs.days ?? DEFAULT_LOOKBACK_DAYS,
  };

  validateEnv({ dryRun: normalizedArgs.dryRun });
  const range = resolveDateRange(normalizedArgs);
  const repoSlugs = getConfiguredRepos();

  console.log(
    `Using date range ${range.startDateStr} to ${range.endDateStr}${normalizedArgs.dryRun ? ' [dry-run]' : ''} for repos: ${repoSlugs.map((repo) => repo.key).join(', ')}`,
  );

  const bitbucketClient = createBitbucketClient();
  const jiraClient = normalizedArgs.dryRun ? null : createJiraClient();

  const commitSets = [];
  for (const repoConfig of repoSlugs) {
    try {
      const repoCommits = await fetchCommits(bitbucketClient, range, repoConfig);
      commitSets.push(repoCommits);
    } catch (error) {
      console.error(`[FAILED] Fetching commits from ${repoConfig.key}: ${getErrorMessage(error)}`);
    }
  }

  const commits = commitSets.flat();
  const groupedCommits = groupCommits(commits);
  const timesheet = generateHours(groupedCommits);
  const commitSummary = buildCommitSummary(commits);
  const matchedCommits = buildMatchedCommitsPayload(commits);

  printCommitSummary(commits);
  printMatchedCommits(commits);
  printTimesheet(timesheet);

  const uploads = await uploadToJira(jiraClient, timesheet, { dryRun: normalizedArgs.dryRun });
  const generatedAt = new Date().toISOString();
  const result = {
    generatedAt,
    filters: buildFilters(range, normalizedArgs, repoSlugs),
    commitSummary,
    matchedCommits,
    timesheet,
    uploads,
  };

  if (options.persistOutput) {
    await writeCommitsOutput({
      generatedAt,
      filters: result.filters,
      commitSummary,
      matchedCommits,
    });

    await writeOutput(result);
  }

  return result;
}

module.exports = {
  buildWorklogComment,
  createJiraClient,
  extractJiraCommentText,
  fetchExistingWorklogs,
  getErrorMessage,
  getJiraApiBasePath,
  parseArgs,
  retry,
  resolveDateRange,
  runGenerator,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
