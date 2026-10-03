import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkPullRequest(pr) {
  const errors = [];
  if (!pr) return errors;
  const base = pr.base?.ref ?? '', head = pr.head?.ref ?? '';
  const sameRepo = pr.base?.repo?.full_name === pr.head?.repo?.full_name;
  const mainSync = base === 'develop' && head === 'main' && sameRepo;
  const allowed = base === 'develop'
    ? /^(feature|fix|docs|refactor|test|chore|release|hotfix)\/.+/.test(head) || mainSync
    : base === 'main' && /^(release|hotfix|docs)\/.+/.test(head);
  if (!allowed) errors.push(`Invalid PR route: ${head} -> ${base}. Features/fixes target develop; release/hotfix/docs may target main.`);
  if (!/^(feat|fix|docs|refactor|test|chore|build|ci|perf|revert)(\([^\r\n)]+\))?!?: .+/.test(pr.title ?? '')) errors.push('Use a Conventional Commit-style PR title, e.g. feat: add quota forecasting');
  if (!/(?:Refs|Fixes|Closes|Resolves)\s+(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*/i.test(pr.body ?? '')) errors.push('Reference the tracking issue: Refs #N (develop), or Fixes #N (main).');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const errors = checkPullRequest(event.pull_request);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('PR routing and issue reference: PASS');
}
