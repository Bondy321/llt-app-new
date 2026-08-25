#!/usr/bin/env node
'use strict';

const WORKFLOW_FILE = 'ci.yml';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;

const readArgument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const sha = readArgument('sha') || process.env.GITHUB_SHA;
const timeoutMs = Number(readArgument('timeout-ms')) || DEFAULT_TIMEOUT_MS;

if (!repository || !token || !/^[a-f0-9]{40}$/iu.test(sha || '')) {
  throw new Error('GITHUB_REPOSITORY, GITHUB_TOKEN, and an exact 40-character release SHA are required.');
}

const apiUrl = `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${sha}&per_page=20`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'llt-ci-release-gate',
  'X-GitHub-Api-Version': '2022-11-28',
};

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const verify = async () => {
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) throw new Error(`GitHub Actions API returned HTTP ${response.status}.`);
    const payload = await response.json();
    const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    const successfulRun = runs.find((run) => run.head_sha === sha && run.conclusion === 'success');
    if (successfulRun) {
      process.stdout.write(`Exact-SHA CI gate passed: ${successfulRun.html_url}\n`);
      return;
    }

    const failedRun = runs.find((run) => run.head_sha === sha && run.status === 'completed');
    if (failedRun) {
      throw new Error(`CI completed with conclusion ${failedRun.conclusion} for ${sha}: ${failedRun.html_url}`);
    }

    if (Date.now() >= deadline) break;
    process.stdout.write(`Waiting for CI success for exact SHA ${sha}...\n`);
    await wait(POLL_INTERVAL_MS);
  } while (true);

  throw new Error(`No successful ${WORKFLOW_FILE} run was found for exact SHA ${sha} before timeout.`);
};

verify().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
