import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { convertArtifact, DashboardError, loadRepositories, type Repository } from './build-dashboard.js';

const repository: Repository = {
  owner: 'DiogoBett',
  repo: 'api-automation-foundation',
  branch: 'main',
  workflow: 'run-automated-tests.yml',
  artifact: 'test_report',
  cucumberPatterns: ['**/*.json']
};
const runUrl = 'https://github.com/DiogoBett/api-automation-foundation/actions/runs/123';

test('loads repositories and report globs from config.properties', async () => {
  const config = await readFile(new URL('../config.properties', import.meta.url), 'utf8');
  const repositories = loadRepositories(config);

  assert.deepEqual(
    repositories.map(({ repo }) => repo),
    ['api-automation-foundation', 'web-automation-foundation']
  );
  assert.equal(repositories[0]?.artifact, 'test_report');
  assert.deepEqual(repositories[0]?.cucumberPatterns, ['**/*.json']);
});

test('converts Cucumber scenarios and step failures', () => {
  const report = Buffer.from(
    JSON.stringify([
      {
        name: 'Account',
        uri: 'features/account.feature',
        elements: [
          {
            name: 'sign in',
            line: 4,
            steps: [
              { result: { status: 'passed', duration: 12_000_000 } },
              {
                result: {
                  status: 'failed',
                  duration: 8_000_000,
                  error_message: 'AssertionError: denied'
                }
              }
            ]
          }
        ]
      }
    ])
  );

  const results = convertArtifact([{ filename: 'cucumber.json', data: report }], repository, runUrl);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'failed');
  assert.equal(results[0]?.stop - results[0]?.start, 20);
  assert.equal(results[0]?.statusDetails?.message, 'AssertionError: denied');
  assert.deepEqual(
    results[0]?.steps?.map(({ status }) => status),
    ['passed', 'failed']
  );
  assert.ok(results[0]?.labels.some(({ name, value }) => name === 'parentSuite' && value === 'api-automation-foundation'));
});

test('includes failed Cucumber hooks and ignores background entries', () => {
  const report = Buffer.from(
    JSON.stringify([
      {
        name: 'Account',
        elements: [
          {
            type: 'background',
            name: 'shared setup',
            steps: [{ result: { status: 'passed' } }]
          },
          {
            type: 'scenario',
            name: 'opens account',
            before: [
              {
                result: {
                  status: 'failed',
                  duration: 3_000_000,
                  error_message: 'setup failed'
                }
              }
            ],
            steps: [{ result: { status: 'skipped' } }],
            after: []
          }
        ]
      }
    ])
  );

  const results = convertArtifact([{ filename: 'cucumber.json', data: report }], repository, runUrl);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.status, 'failed');
  assert.equal(results[0]?.stop - results[0]?.start, 3);
  assert.equal(results[0]?.statusDetails?.message, 'setup failed');
  assert.equal(results[0]?.steps?.[0]?.name, 'Before hook');
});

test('rejects artifacts that contain only rendered HTML', () => {
  assert.throws(
    () => convertArtifact([{ filename: 'cucumber-report.html', data: Buffer.from('<html>report</html>') }], repository, runUrl),
    (error: unknown) => error instanceof DashboardError && error.message.includes('rendered HTML reports')
  );
});

test('rejects duplicate repositories in configuration', () => {
  const config = `repositories=api,api
api.owner=${repository.owner}
api.repo=${repository.repo}
api.branch=${repository.branch}
api.workflow=${repository.workflow}
api.artifact=${repository.artifact}
api.cucumber=**/*.json`;
  assert.throws(
    () => loadRepositories(config),
    (error: unknown) => error instanceof DashboardError && error.message.includes('duplicate repositories')
  );
});

test('uses configured file patterns to select artifact reports', () => {
  const constrainedRepository = {
    ...repository,
    cucumberPatterns: ['reports/cucumber.json']
  };
  const report = Buffer.from(JSON.stringify([{ name: 'Account', elements: [{ name: 'sign in', steps: [] }] }]));

  assert.throws(
    () => convertArtifact([{ filename: 'other/cucumber.json', data: report }], constrainedRepository, runUrl),
    (error: unknown) => error instanceof DashboardError && error.message.includes('no usable Cucumber scenarios')
  );
});
