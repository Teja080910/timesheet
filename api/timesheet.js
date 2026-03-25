'use strict';

const { getErrorMessage, runGenerator } = require('../generate-timesheet');

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }

  return defaultValue;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getBearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthorized(request, requestBody) {
  const configuredToken = (process.env.TIMESHEET_API_TOKEN || '').trim();
  if (!configuredToken) {
    return { ok: false, reason: 'TIMESHEET_API_TOKEN is not configured.' };
  }

  const candidateTokens = [
    getBearerToken(request),
    request.headers['x-api-token'],
    requestBody.token,
  ].filter((value) => typeof value === 'string' && value.trim());

  const matched = candidateTokens.some((value) => value.trim() === configuredToken);
  return matched
    ? { ok: true }
    : { ok: false, reason: 'Missing or invalid API token.' };
}

module.exports = async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Allow', 'GET, POST, OPTIONS');
    response.end();
    return;
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, POST, OPTIONS');
    response.end('Method Not Allowed');
    return;
  }

  try {
    const requestBody = request.method === 'POST' ? await readJsonBody(request) : {};
    const auth = isAuthorized(request, requestBody);
    if (!auth.ok) {
      sendJson(response, 401, { error: auth.reason });
      return;
    }

    const source = request.method === 'POST'
      ? { ...request.query, ...requestBody }
      : request.query;

    const result = await runGenerator({
      dryRun: parseBoolean(source.dryRun, true),
      startDate: source.startDate || null,
      endDate: source.endDate || null,
      days: parseNumber(source.days),
    });

    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: getErrorMessage(error),
    });
  }
};
