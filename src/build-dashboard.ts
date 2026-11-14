import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { minimatch } from 'minimatch';
import yauzl from 'yauzl';

const API_ROOT = 'https://api.github.com';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;

export interface Repository {
  owner: string;
  repo: string;
  branch: string;
  workflow: string;
  artifact: string;
  cucumberPatterns: string[];
}

interface WorkflowRun {
  id: number;
  html_url: string;
  conclusion: string | null;
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string | null;
}

export interface ReportFile {
  filename: string;
  data: Buffer;
}

type JsonRecord = Record<string, unknown>;
type AllureLabel = { name: string; value: string };

export interface AllureResult {
  uuid: string;
  historyId: string;
  testCaseId: string;
  name: string;
  fullName: string;
  status: string;
  stage: 'finished';
  start: number;
  stop: number;
  labels: AllureLabel[];
  links: { name: string; url: string; type: string }[];
  steps?: AllureStep[];
  statusDetails?: {
    known: boolean;
    muted: boolean;
    flaky: boolean;
    message: string;
    trace: string;
  };
}

interface AllureStep {
  name: string;
  status: string;
  stage: 'finished';
  start: number;
  stop: number;
  statusDetails?: NonNullable<AllureResult['statusDetails']>;
}

export class DashboardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DashboardError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function recordArray(value: unknown): JsonRecord[] {
  return arrayValue(value).filter(isRecord);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function durationMilliseconds(value: unknown, scale = 1000): number {
  const duration = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration * scale)) : 0;
}

function timestampMilliseconds(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function requiredProperty(properties: Map<string, string>, key: string): string {
  const value = properties.get(key)?.trim();
  if (!value) {
    throw new DashboardError(`Missing required config.properties value: ${key}`);
  }
  return value;
}

function parsePatterns(value: string | undefined, key: string): string[] {
  const patterns = (value ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern.startsWith('/') || pattern.replaceAll('\\', '/').split('/').includes('..')) {
      throw new DashboardError(`Invalid artifact file pattern in ${key}: ${pattern}`);
    }
  }
  return patterns;
}

function validateRepository(properties: Map<string, string>, id: string): Repository {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new DashboardError(`Invalid repository identifier: ${JSON.stringify(id)}`);
  }
  const prefix = `${id}.`;
  const repository: Repository = {
    owner: requiredProperty(properties, `${prefix}owner`),
    repo: requiredProperty(properties, `${prefix}repo`),
    branch: requiredProperty(properties, `${prefix}branch`),
    workflow: requiredProperty(properties, `${prefix}workflow`),
    artifact: requiredProperty(properties, `${prefix}artifact`),
    cucumberPatterns: parsePatterns(properties.get(`${prefix}cucumber`), `${prefix}cucumber`)
  };
  if (repository.cucumberPatterns.length === 0) {
    throw new DashboardError(`${prefix}cucumber must configure at least one artifact file pattern`);
  }
  for (const field of ['owner', 'repo', 'workflow'] as const) {
    if (!/^[A-Za-z0-9_.-]+$/.test(repository[field])) {
      throw new DashboardError(`Repository configuration has an invalid ${field}: ${JSON.stringify(repository[field])}`);
    }
  }
  return repository;
}

export function parseProperties(configText: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [index, rawLine] of configText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new DashboardError(`Invalid config.properties line ${index + 1}: expected key=value`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (properties.has(key)) {
      throw new DashboardError(`Duplicate config.properties key on line ${index + 1}: ${key}`);
    }
    properties.set(key, value);
  }

  return properties;
}

export function loadRepositories(configText: string): Repository[] {
  const properties = parseProperties(configText);
  const ids = requiredProperty(properties, 'repositories')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new DashboardError('config.properties must list at least one repository');
  }

  const repositories = ids.map((id) => validateRepository(properties, id));
  const repoIds = repositories.map(({ owner, repo }) => `${owner.toLowerCase()}/${repo.toLowerCase()}`);
  if (new Set(repoIds).size !== repoIds.length) {
    throw new DashboardError('Repository config contains duplicate repositories');
  }
  return repositories;
}

function matchesArtifactPattern(filename: string, patterns: string[]): boolean {
  const normalized = filename.replaceAll('\\', '/');
  return patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }));
}

async function requestBytes(url: string, token?: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'foundation-repo-dashboard',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  } catch (error) {
    throw new DashboardError(`GitHub request failed for ${url}: ${String(error)}`, {
      cause: error
    });
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2048).trim();
    if (response.status === 401) {
      throw new DashboardError(
        `GitHub rejected the request for ${url}. Add or verify the REPORTS_READ_TOKEN repository secret. It must be a fine-grained token with Actions: read access to every configured source repository. ${detail}`
      );
    }
    throw new DashboardError(`GitHub request failed (${response.status}) for ${url}: ${detail || response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new DashboardError(`Response from ${url} exceeds the 100 MiB download limit`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new DashboardError(`GitHub returned an empty response for ${url}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new DashboardError(`Response from ${url} exceeds the 100 MiB download limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function requestJson(url: string, token?: string): Promise<JsonRecord> {
  let response: unknown;
  try {
    response = JSON.parse((await requestBytes(url, token)).toString('utf8'));
  } catch (error) {
    if (error instanceof DashboardError) {
      throw error;
    }
    throw new DashboardError(`GitHub returned invalid JSON for ${url}`, { cause: error });
  }
  if (!isRecord(response)) {
    throw new DashboardError(`GitHub returned an unexpected response for ${url}`);
  }
  return response;
}

async function getLatestRun(repository: Repository, token?: string): Promise<WorkflowRun> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const workflow = encodeURIComponent(repository.workflow);
  const query = new URLSearchParams({
    branch: repository.branch,
    status: 'completed',
    per_page: '1'
  });
  const url = `${API_ROOT}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${query}`;
  const response = await requestJson(url, token);
  const runs = response.workflow_runs;
  if (!Array.isArray(runs) || !isRecord(runs[0])) {
    throw new DashboardError(`No completed run found for ${owner}/${repo} workflow ${repository.workflow} on branch ${repository.branch}`);
  }
  const run = runs[0];
  if (typeof run.id !== 'number' || typeof run.html_url !== 'string') {
    throw new DashboardError(`GitHub returned an invalid latest run for ${owner}/${repo}`);
  }
  return {
    id: run.id,
    html_url: run.html_url,
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null
  };
}

async function getArtifact(repository: Repository, run: WorkflowRun, token?: string): Promise<Artifact> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const query = new URLSearchParams({ name: repository.artifact, per_page: '100' });
  const url = `${API_ROOT}/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?${query}`;
  const response = await requestJson(url, token);
  const artifacts = response.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new DashboardError(`GitHub returned an invalid artifact list for ${owner}/${repo}`);
  }
  const usable = artifacts.filter(
    (artifact): artifact is JsonRecord =>
      isRecord(artifact) && artifact.name === repository.artifact && artifact.expired === false && typeof artifact.id === 'number'
  );
  usable.sort((left, right) => stringValue(right.created_at).localeCompare(stringValue(left.created_at)));
  const artifact = usable[0];
  if (!artifact) {
    throw new DashboardError(
      `Run ${run.html_url} has no unexpired artifact named ${JSON.stringify(repository.artifact)}; make sure report artifacts are uploaded even when tests fail`
    );
  }
  return {
    id: artifact.id as number,
    name: repository.artifact,
    expired: false,
    created_at: typeof artifact.created_at === 'string' ? artifact.created_at : null
  };
}

function validZipPath(filename: string): boolean {
  const normalized = filename.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

async function readArchive(archive: Buffer, repository: Repository): Promise<ReportFile[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(archive, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true
    });
  } catch (error) {
    throw new DashboardError(`Artifact ${repository.owner}/${repository.repo} is not a valid ZIP archive`, { cause: error });
  }

  const files: ReportFile[] = [];
  let totalUncompressed = 0;
  let entryCount = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_FILES) {
        throw new DashboardError(`Artifact ${repository.owner}/${repository.repo} contains too many files`);
      }
      if (entry.fileName.endsWith('/') || !validZipPath(entry.fileName)) {
        continue;
      }

      if (path.posix.extname(entry.fileName).toLowerCase() !== '.json' || !matchesArtifactPattern(entry.fileName, repository.cucumberPatterns)) {
        continue;
      }

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new DashboardError(`Artifact ${repository.owner}/${repository.repo} exceeds the 250 MiB uncompressed limit`);
      }

      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let fileSize = 0;
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileSize += data.length;
        if (fileSize > MAX_UNCOMPRESSED_BYTES) {
          throw new DashboardError(`File ${entry.fileName} exceeds the uncompressed size limit`);
        }
        chunks.push(data);
      }
      files.push({ filename: entry.fileName, data: Buffer.concat(chunks, fileSize) });
    }
  } catch (error) {
    zip.close();
    if (error instanceof DashboardError) {
      throw error;
    }
    throw new DashboardError(`Could not read artifact ZIP for ${repository.owner}/${repository.repo}: ${String(error)}`, { cause: error });
  }
  return files;
}

async function downloadArtifact(repository: Repository, artifact: Artifact, token?: string): Promise<ReportFile[]> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const url = `${API_ROOT}/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`;
  return readArchive(await requestBytes(url, token), repository);
}

function labels(repository: Repository, suite: string, format: string, extra: AllureLabel[] = []): AllureLabel[] {
  return [
    { name: 'parentSuite', value: repository.repo },
    { name: 'suite', value: suite },
    { name: 'package', value: `${repository.owner}/${repository.repo}` },
    { name: 'tag', value: `source:${repository.owner}/${repository.repo}` },
    { name: 'tag', value: `format:${format}` },
    ...extra.filter(({ value }) => value !== '')
  ];
}

function makeResult(options: {
  name: string;
  fullName: string;
  status: string;
  start: number;
  duration: number;
  labels: AllureLabel[];
  runUrl: string;
  steps?: AllureStep[];
  message?: string;
  trace?: string;
}): AllureResult {
  const result: AllureResult = {
    uuid: randomUUID(),
    historyId: hash(options.fullName),
    testCaseId: hash(`${options.fullName}#${options.name}`),
    name: options.name,
    fullName: options.fullName,
    status: options.status,
    stage: 'finished',
    start: options.start,
    stop: options.start + options.duration,
    labels: options.labels,
    links: [{ name: 'GitHub Actions run', url: options.runUrl, type: 'link' }]
  };
  if (options.steps) {
    result.steps = options.steps;
  }
  if (options.message || options.trace) {
    result.statusDetails = {
      known: false,
      muted: false,
      flaky: false,
      message: options.message ?? '',
      trace: options.trace ?? ''
    };
  }
  return result;
}

function cucumberStatus(steps: unknown[]): {
  status: string;
  message: string;
  trace: string;
} {
  if (steps.length === 0) {
    return { status: 'unknown', message: '', trace: '' };
  }

  const statuses: string[] = [];
  const messages: string[] = [];
  const traces: string[] = [];
  for (const step of steps) {
    const result = isRecord(step) && isRecord(step.result) ? step.result : undefined;
    const status = stringValue(result?.status, 'unknown').toLowerCase();
    statuses.push(status);
    const error = stringValue(result?.error_message).trim();
    if (error) {
      messages.push(error.split(/\r?\n/, 1)[0] ?? '');
      traces.push(error);
    }
  }

  const mapping: Array<[string, string]> = [
    ['failed', 'failed'],
    ['ambiguous', 'failed'],
    ['undefined', 'broken'],
    ['pending', 'skipped'],
    ['skipped', 'skipped'],
    ['unknown', 'unknown']
  ];
  for (const [source, target] of mapping) {
    if (statuses.includes(source)) {
      return { status: target, message: messages.join('\n'), trace: traces.join('\n\n') };
    }
  }
  return statuses.every((status) => status === 'passed')
    ? { status: 'passed', message: '', trace: '' }
    : { status: 'unknown', message: messages.join('\n'), trace: traces.join('\n\n') };
}

function allureCucumberStatus(status: string): string {
  switch (status.toLowerCase()) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'ambiguous':
      return 'failed';
    case 'undefined':
      return 'broken';
    case 'pending':
    case 'skipped':
      return 'skipped';
    default:
      return 'unknown';
  }
}

function cucumberResults(filename: string, data: Buffer, repository: Repository, runUrl: string): AllureResult[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(data.toString('utf8'));
  } catch (error) {
    if (filename.toLowerCase().includes('cucumber')) {
      throw new DashboardError(`Invalid Cucumber JSON in ${filename}: ${String(error)}`, {
        cause: error
      });
    }
    return undefined;
  }

  const features = isRecord(document) ? document.features : document;
  if (!Array.isArray(features) || !features.some((feature) => isRecord(feature) && 'elements' in feature)) {
    return undefined;
  }

  const results: AllureResult[] = [];
  for (const feature of features) {
    if (!isRecord(feature)) {
      continue;
    }
    const featureName = stringValue(feature.name, stringValue(feature.uri, filename));
    for (const element of recordArray(feature.elements)) {
      if (element.type === 'background') {
        continue;
      }

      const name = stringValue(element.name, stringValue(element.id, 'Unnamed scenario'));
      const fullName = `${repository.owner}/${repository.repo} / ${featureName} / ${name}`;
      const steps = [
        ...recordArray(element.before).map((value) => ({ value, phase: 'Before hook' })),
        ...recordArray(element.steps).map((value) => ({ value, phase: '' })),
        ...recordArray(element.after).map((value) => ({ value, phase: 'After hook' }))
      ];
      const stepValues = steps.map(({ value }) => value);
      const outcome = cucumberStatus(stepValues);
      const scenarioStart = timestampMilliseconds(element.start_timestamp);
      let duration = 0;
      const allureSteps = steps.map(({ value, phase }): AllureStep => {
        const result = isRecord(value) && isRecord(value.result) ? value.result : undefined;
        const stepDuration = durationMilliseconds(result?.duration, 1 / 1_000_000);
        const start = scenarioStart + duration;
        duration += stepDuration;

        const match = isRecord(value) && isRecord(value.match) ? value.match : undefined;
        const location = stringValue(match?.location);
        const name = valueHasName(value) ? stringValue(value.name) : `${phase || 'Unnamed step'}${location ? ` (${location})` : ''}`;
        const message = stringValue(result?.error_message);
        const step: AllureStep = {
          name,
          status: allureCucumberStatus(stringValue(result?.status, 'unknown')),
          stage: 'finished',
          start,
          stop: start + stepDuration
        };
        if (message) {
          step.statusDetails = {
            known: false,
            muted: false,
            flaky: false,
            message: message.split(/\r?\n/, 1)[0] ?? '',
            trace: message
          };
        }
        return step;
      });
      const tags = [...recordArray(feature.tags), ...recordArray(element.tags)].map((tag) => stringValue(tag.name).replace(/^@/, ''));

      results.push(
        makeResult({
          name,
          fullName,
          status: outcome.status,
          start: scenarioStart,
          duration,
          labels: labels(
            repository,
            featureName,
            'cucumber',
            tags.map((value) => ({ name: 'tag', value }))
          ),
          runUrl,
          steps: allureSteps,
          message: outcome.message,
          trace: outcome.trace
        })
      );
    }
  }
  return results;
}

function valueHasName(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0;
}

export function convertArtifact(files: ReportFile[], repository: Repository, runUrl: string): AllureResult[] {
  const results: AllureResult[] = [];
  for (const file of files) {
    if (path.posix.extname(file.filename).toLowerCase() === '.json' && matchesArtifactPattern(file.filename, repository.cucumberPatterns)) {
      results.push(...(cucumberResults(file.filename, file.data, repository, runUrl) ?? []));
    }
  }

  if (results.length === 0) {
    throw new DashboardError(
      `Artifact ${repository.owner}/${repository.repo} contains no usable Cucumber scenarios. Include Cucumber JSON matching the configured file pattern; rendered HTML reports cannot be converted into reliable Allure test results.`
    );
  }
  return results;
}

async function writeResults(output: string, results: AllureResult[], repositories: Repository[]): Promise<void> {
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length > 0) {
    throw new DashboardError(`Output directory ${output} must be empty`);
  }

  await Promise.all(results.map((result) => writeFile(path.join(output, `${result.uuid}-result.json`), JSON.stringify(result), 'utf8')));

  const runNumber = process.env.GITHUB_RUN_NUMBER ?? 'local';
  const executor = {
    name: 'GitHub Actions',
    type: 'github',
    buildName: runNumber,
    buildOrder: Number(runNumber) || 0,
    reportUrl: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? ''}`
  };
  await writeFile(path.join(output, 'executor.json'), JSON.stringify(executor), 'utf8');
  await writeFile(
    path.join(output, 'environment.properties'),
    `source.repositories=${repositories.map(({ owner, repo }) => `${owner}/${repo}`).join(',')}\n`,
    'utf8'
  );
}

export async function buildDashboard(configPath: string, output: string): Promise<number> {
  const repositories = loadRepositories(await readFile(configPath, 'utf8'));
  const token = process.env.REPORTS_READ_TOKEN || undefined;
  const results: AllureResult[] = [];

  for (const repository of repositories) {
    const identity = `${repository.owner}/${repository.repo}`;
    console.log(`Collecting latest completed report from ${identity}...`);
    const run = await getLatestRun(repository, token);
    if (!['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion ?? '')) {
      throw new DashboardError(`Latest run ${run.html_url} has unsupported conclusion ${JSON.stringify(run.conclusion)}`);
    }
    const artifact = await getArtifact(repository, run, token);
    const files = await downloadArtifact(repository, artifact, token);
    const converted = convertArtifact(files, repository, run.html_url);
    console.log(`  Added ${converted.length} test results from run ${run.html_url}`);
    results.push(...converted);
  }

  await writeResults(output, results, repositories);
  console.log(`Generated ${results.length} Allure test results in ${output}`);
  return results.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  const outputIndex = args.indexOf('--output');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!configPath || !output || args.length !== 4) {
    throw new DashboardError('Usage: node dist/build-dashboard.js --config <config.properties> --output <allure-results>');
  }
  await buildDashboard(configPath, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
