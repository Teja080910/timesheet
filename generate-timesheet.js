#!/usr/bin/env node

'use strict';

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const TICKET_REGEX = /PF-\d+/i;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_DAILY_HOURS = 10;
const MIN_DAILY_HOURS = 8;
const DEFAULT_START_HOUR = '09:00:00.000+0530';
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

  return 'GENERAL';
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

function getRandomDailyHours() {
  const steps = [];
  for (let value = MIN_DAILY_HOURS; value <= MAX_DAILY_HOURS; value += 0.5) {
    steps.push(Number(value.toFixed(1)));
  }

  const selected = steps[Math.floor(Math.random() * steps.length)];
  return Number(selected.toFixed(1));
}

function distributeTenths(totalTenths, weights) {
  const exactAllocations = weights.map((weight) => weight * totalTenths);
  const floorAllocations = exactAllocations.map((value) => Math.floor(value));
  let remaining = totalTenths - floorAllocations.reduce((sum, value) => sum + value, 0);

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

function generateHours(groupedCommits) {
  const dates = Array.from(groupedCommits.keys()).sort();
  const timesheet = [];

  for (const date of dates) {
    const tickets = groupedCommits.get(date);
    const entries = Array.from(tickets.entries()).map(([ticketId, commits]) => ({
      ticketId,
      commits,
      commitCount: commits.length,
    }));

    const totalCommits = entries.reduce((sum, entry) => sum + entry.commitCount, 0);
    const dailyHours = getRandomDailyHours();
    const dailyTenths = Math.round(dailyHours * 10);
    const weights = entries.map((entry) => entry.commitCount / totalCommits);
    const allocations = distributeTenths(dailyTenths, weights);

    const dayEntries = [];
    let worklogIndex = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const ticketTenths = allocations[index];
      const commitWeights = entry.commits.map(() => 1 / entry.commits.length);
      const commitAllocations = distributeTenths(ticketTenths, commitWeights);

      for (let commitIndex = 0; commitIndex < entry.commits.length; commitIndex += 1) {
        const commit = entry.commits[commitIndex];
        const commitTenths = commitAllocations[commitIndex];
        if (commitTenths <= 0) {
          continue;
        }

        dayEntries.push({
          date,
          ticketId: entry.ticketId,
          hours: Number((commitTenths / 10).toFixed(1)),
          secondsSpent: commitTenths * 360,
          commitCount: 1,
          repos: [commit.repo],
          commitHashes: [commit.hash],
          commitMessages: commit.message ? [commit.message] : [],
          commitHash: commit.hash,
          commitMessage: commit.message || '',
          worklogIndex,
        });

        worklogIndex += 1;
      }
    }

    const actualDailyTotal = dayEntries.reduce((sum, entry) => sum + entry.hours, 0);
    if (actualDailyTotal > MAX_DAILY_HOURS) {
      throw new Error(`Generated daily total exceeded ${MAX_DAILY_HOURS} hours for ${date}.`);
    }

    timesheet.push({
      date,
      totalHours: Number(actualDailyTotal.toFixed(1)),
      entries: dayEntries,
    });
  }

  return timesheet;
}

function buildWorklogComment(ticketId, entry) {
  const normalizedMessage = (entry.commitMessage || '').replace(/\s+/g, ' ').trim();
  const summary = normalizedMessage ? ` Commit: ${normalizedMessage}` : '';
  return `Worked on ${ticketId} (development, fixes, improvements). Commit ${entry.commitHash.slice(0, 8)}.${summary}`;
}

function getStartedTimestamp(date, worklogIndex = 0) {
  const baseDate = new Date(`${date}T09:00:00.000+05:30`);
  baseDate.setMinutes(baseDate.getMinutes() + worklogIndex);

  const year = baseDate.getFullYear();
  const month = String(baseDate.getMonth() + 1).padStart(2, '0');
  const day = String(baseDate.getDate()).padStart(2, '0');
  const hours = String(baseDate.getHours()).padStart(2, '0');
  const minutes = String(baseDate.getMinutes()).padStart(2, '0');
  const seconds = String(baseDate.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.000+0530`;
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

function hasMatchingWorklog(worklogs, entry) {
  return (worklogs || []).some((worklog) => {
    if (typeof worklog.started !== 'string' || !worklog.started.startsWith(entry.date)) {
      return false;
    }

    const commentText = extractJiraCommentText(worklog.comment);
    return commentText.includes(entry.commitHash.slice(0, 8));
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
        console.log(`[DRY RUN] ${day.date} ${issueKey} ${entry.hours}h ${entry.commitHash.slice(0, 8)}`);
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
        if (hasMatchingWorklog(existingWorklogs, entry)) {
          console.log(`[SKIP] ${day.date} ${issueKey} ${entry.commitHash.slice(0, 8)} already has a matching worklog.`);
          results.push({
            date: day.date,
            ticketId: issueKey,
            status: 'skipped-duplicate',
            hours: entry.hours,
            commitHash: entry.commitHash,
          });
          continue;
        }

        await retry(
          () => jiraClient.post(`${getJiraApiBasePath()}/issue/${encodeURIComponent(issueKey)}/worklog`, {
            started: getStartedTimestamp(day.date, entry.worklogIndex),
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

function printTimesheet(timesheet) {
  console.log('\nGenerated timesheet:\n');

  if (timesheet.length === 0) {
    console.log('No weekday commits found in the requested date range.');
    return;
  }

  for (const day of timesheet) {
    console.log(`${day.date} - ${day.totalHours.toFixed(1)}h`);
    for (const entry of day.entries) {
      console.log(
        `  ${entry.ticketId}: ${entry.hours.toFixed(1)}h (${entry.commitHash.slice(0, 8)}, repos: ${entry.repos.join(', ')})`,
      );
    }
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  validateEnv({ dryRun: cliArgs.dryRun });
  const range = resolveDateRange(cliArgs);
  const repoSlugs = getConfiguredRepos();

  console.log(
    `Using date range ${range.startDateStr} to ${range.endDateStr}${cliArgs.dryRun ? ' [dry-run]' : ''} for repos: ${repoSlugs.map((repo) => repo.key).join(', ')}`,
  );

  const bitbucketClient = createBitbucketClient();
  const jiraClient = cliArgs.dryRun ? null : createJiraClient();

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

  const uploads = await uploadToJira(jiraClient, timesheet, { dryRun: cliArgs.dryRun });
  const filters = {
    startDate: range.startDateStr,
    endDate: range.endDateStr,
    dryRun: cliArgs.dryRun,
    repos: repoSlugs.map((repo) => repo.key),
    branches: getConfiguredBranches(),
    branchPatterns: getConfiguredBranchPatterns(),
    maxBranches: getConfiguredMaxBranches(),
    authorEmails: getConfiguredAuthorEmails(),
  };

  await writeCommitsOutput({
    generatedAt: new Date().toISOString(),
    filters,
    commitSummary,
    matchedCommits,
  });

  await writeOutput({
    generatedAt: new Date().toISOString(),
    filters,
    commitSummary,
    matchedCommits,
    timesheet,
    uploads,
  });
}

main().catch((error) => {
  console.error(`Fatal error: ${getErrorMessage(error)}`);
  process.exitCode = 1;
});
