import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reputationScore, neutralReputation } from '../src/shared/reputation.js';

test('a brand-new worker starts at a neutral score', () => {
  const score = reputationScore({ jobsCompleted: 0, jobsFailed: 0, flaggedReports: 0 });
  assert.equal(score, neutralReputation());
  assert.ok(score > 50 && score < 80, `neutral score ${score} sits in a sensible band`);
});

test('a worker with a long clean record scores near the top', () => {
  const score = reputationScore({ jobsCompleted: 100, jobsFailed: 0, flaggedReports: 0 });
  assert.ok(score >= 95, `clean veteran scored ${score}`);
});

test('failures pull a worker down', () => {
  const good = reputationScore({ jobsCompleted: 20, jobsFailed: 0, flaggedReports: 0 });
  const bad = reputationScore({ jobsCompleted: 20, jobsFailed: 20, flaggedReports: 0 });
  assert.ok(bad < good, 'a failure-heavy worker scores lower');
});

test('a flagged usage report hurts more than an honest failure', () => {
  const withFailures = reputationScore({
    jobsCompleted: 10,
    jobsFailed: 5,
    flaggedReports: 0,
  });
  const withFlags = reputationScore({
    jobsCompleted: 10,
    jobsFailed: 0,
    flaggedReports: 5,
  });
  assert.ok(
    withFlags < withFailures,
    `flagged metering (${withFlags}) is penalised harder than failures (${withFailures})`,
  );
});

test('the score is always within 0-100', () => {
  for (const input of [
    { jobsCompleted: 0, jobsFailed: 1000, flaggedReports: 1000 },
    { jobsCompleted: 100000, jobsFailed: 0, flaggedReports: 0 },
  ]) {
    const score = reputationScore(input);
    assert.ok(score >= 0 && score <= 100, `score ${score} is in range`);
  }
});
