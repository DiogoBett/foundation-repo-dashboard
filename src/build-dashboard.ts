import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { minimatch } from 'minimatch';
import yauzl from 'yauzl';
import { CONSTANTS, ERROR_MESSAGES, LOG_MESSAGES } from './constants.js';

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
  stage: typeof CONSTANTS.allure.finishedStage;
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
  stage: typeof CONSTANTS.allure.finishedStage;
  start: number;
  stop: number;
  statusDetails?: NonNullable<AllureResult['statusDetails']>;
}

export class DashboardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = CONSTANTS.runtime.dashboardErrorName;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string = CONSTANTS.strings.empty): string {
  return typeof value === 'string' ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function recordArray(value: unknown): JsonRecord[] {
  return arrayValue(value).filter(isRecord);
}

function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value[key];
  return isRecord(record) ? record : undefined;
}

function hash(value: string): string {
  return createHash(CONSTANTS.files.hashAlgorithm).update(value).digest(CONSTANTS.files.hashEncoding);
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
    throw new DashboardError(ERROR_MESSAGES.missingConfigValue(key));
  }
  return value;
}

function parsePatterns(value: string | undefined, key: string): string[] {
  const patterns = (value ?? CONSTANTS.strings.empty)
    .split(CONSTANTS.config.listSeparator)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (
      pattern.startsWith(CONSTANTS.config.pathSeparator) ||
      pattern
        .replaceAll(CONSTANTS.config.windowsPathSeparator, CONSTANTS.config.pathSeparator)
        .split(CONSTANTS.config.pathSeparator)
        .includes(CONSTANTS.config.traversalSegment)
    ) {
      throw new DashboardError(ERROR_MESSAGES.invalidGlob(key, pattern));
    }
  }
  return patterns;
}

function validateRepository(properties: Map<string, string>, id: string): Repository {
  if (!new RegExp(CONSTANTS.config.repositoryIdPattern).test(id)) {
    throw new DashboardError(ERROR_MESSAGES.invalidRepositoryId(JSON.stringify(id)));
  }
  const prefix = `${id}${CONSTANTS.config.repoKeySeparator}`;
  const repository: Repository = {
    owner: requiredProperty(properties, `${prefix}${CONSTANTS.config.ownerKey}`),
    repo: requiredProperty(properties, `${prefix}${CONSTANTS.config.repoKey}`),
    branch: requiredProperty(properties, `${prefix}${CONSTANTS.config.branchKey}`),
    workflow: requiredProperty(properties, `${prefix}${CONSTANTS.config.workflowKey}`),
    artifact: requiredProperty(properties, `${prefix}${CONSTANTS.config.artifactKey}`),
    cucumberPatterns: parsePatterns(properties.get(`${prefix}${CONSTANTS.config.cucumberKey}`), `${prefix}${CONSTANTS.config.cucumberKey}`)
  };
  if (repository.cucumberPatterns.length === 0) {
    throw new DashboardError(ERROR_MESSAGES.missingCucumberGlob(`${prefix}${CONSTANTS.config.cucumberKey}`));
  }
  for (const field of [CONSTANTS.config.ownerKey, CONSTANTS.config.repoKey, CONSTANTS.config.workflowKey] as const) {
    if (!new RegExp(CONSTANTS.config.repositoryValuePattern).test(repository[field])) {
      throw new DashboardError(ERROR_MESSAGES.invalidRepositoryField(field, JSON.stringify(repository[field])));
    }
  }
  return repository;
}

export function parseProperties(configText: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [index, rawLine] of configText.split(CONSTANTS.regex.lineBreak).entries()) {
    const line = rawLine.trim();
    if (!line || CONSTANTS.config.commentPrefixes.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    const separator = line.indexOf(CONSTANTS.config.propertySeparator);
    if (separator <= 0) {
      throw new DashboardError(ERROR_MESSAGES.invalidPropertiesLine(index + 1));
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (properties.has(key)) {
      throw new DashboardError(ERROR_MESSAGES.duplicatePropertiesKey(index + 1, key));
    }
    properties.set(key, value);
  }

  return properties;
}

export function loadRepositories(configText: string): Repository[] {
  const properties = parseProperties(configText);
  const ids = requiredProperty(properties, CONSTANTS.config.repositoryListKey)
    .split(CONSTANTS.config.listSeparator)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new DashboardError(ERROR_MESSAGES.emptyRepositoryList);
  }

  const repositories = ids.map((id) => validateRepository(properties, id));
  const repoIds = repositories.map(({ owner, repo }) => repositoryIdentity(owner.toLowerCase(), repo.toLowerCase()));
  if (new Set(repoIds).size !== repoIds.length) {
    throw new DashboardError(ERROR_MESSAGES.duplicateRepositories);
  }
  return repositories;
}

function matchesArtifactPattern(filename: string, patterns: string[]): boolean {
  const normalized = filename.replaceAll(CONSTANTS.config.windowsPathSeparator, CONSTANTS.config.pathSeparator);
  return patterns.some((pattern) => minimatch(normalized, pattern, { dot: true }));
}

function repositoryIdentity(owner: string, repo: string): string {
  return `${owner}${CONSTANTS.config.pathSeparator}${repo}`;
}

function apiUrl(...segments: string[]): string {
  return `${CONSTANTS.api.baseUrl}${CONSTANTS.config.pathSeparator}${segments.join(CONSTANTS.config.pathSeparator)}`;
}

async function requestBytes(url: string, token?: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    [CONSTANTS.api.acceptHeader]: CONSTANTS.api.acceptValue,
    [CONSTANTS.api.userAgentHeader]: CONSTANTS.api.userAgentValue,
    [CONSTANTS.api.versionHeader]: CONSTANTS.api.versionValue
  };
  if (token) {
    headers[CONSTANTS.api.authorizationHeader] = `${CONSTANTS.api.bearerPrefix}${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
  } catch (error) {
    throw new DashboardError(ERROR_MESSAGES.requestFailed(url, String(error)), { cause: error });
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2048).trim();
    if (response.status === CONSTANTS.http.unauthorizedStatus) {
      throw new DashboardError(ERROR_MESSAGES.unauthorizedRequest(url, detail));
    }
    throw new DashboardError(ERROR_MESSAGES.httpRequestFailed(response.status, url, detail || response.statusText));
  }

  const contentLength = Number(response.headers.get(CONSTANTS.http.contentLengthHeader));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    throw new DashboardError(ERROR_MESSAGES.responseTooLarge(url));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new DashboardError(ERROR_MESSAGES.unexpectedEmptyResponse(url));
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
        throw new DashboardError(ERROR_MESSAGES.responseTooLarge(url));
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
    response = JSON.parse((await requestBytes(url, token)).toString(CONSTANTS.files.utf8Encoding));
  } catch (error) {
    if (error instanceof DashboardError) {
      throw error;
    }
    throw new DashboardError(ERROR_MESSAGES.invalidJsonResponse(url), { cause: error });
  }
  if (!isRecord(response)) {
    throw new DashboardError(ERROR_MESSAGES.unexpectedResponse(url));
  }
  return response;
}

export async function getLatestRun(repository: Repository, token?: string): Promise<{ run: WorkflowRun; artifact: Artifact }> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const workflow = encodeURIComponent(repository.workflow);
  const endpoint = apiUrl(
    CONSTANTS.api.resourceSegment,
    owner,
    repo,
    CONSTANTS.api.actionsSegment,
    CONSTANTS.api.workflowsSegment,
    workflow,
    CONSTANTS.api.runsSegment
  );
  let page = 1;
  let lastRun: WorkflowRun | undefined;
  while (true) {
    const query = new URLSearchParams({
      [CONSTANTS.api.branchQueryKey]: repository.branch,
      [CONSTANTS.api.statusQueryKey]: CONSTANTS.api.completedStatus,
      [CONSTANTS.api.pageSizeQueryKey]: CONSTANTS.api.runPageSize,
      [CONSTANTS.api.pageQueryKey]: String(page)
    });
    const response = await requestJson(`${endpoint}?${query}`, token);
    const runs = response[CONSTANTS.api.workflowRunsKey];
    if (!Array.isArray(runs)) {
      throw new DashboardError(ERROR_MESSAGES.noCompletedRun(owner, repo, repository.workflow, repository.branch));
    }

    for (const value of runs) {
      if (!isRecord(value)) {
        throw new DashboardError(ERROR_MESSAGES.invalidLatestRun(owner, repo));
      }
      const id = value[CONSTANTS.api.idKey];
      const htmlUrl = value[CONSTANTS.api.htmlUrlKey];
      const conclusion = value[CONSTANTS.api.conclusionKey];
      if (typeof id !== 'number' || typeof htmlUrl !== 'string') {
        throw new DashboardError(ERROR_MESSAGES.invalidLatestRun(owner, repo));
      }
      const run: WorkflowRun = {
        id,
        html_url: htmlUrl,
        conclusion: typeof conclusion === 'string' ? conclusion : null
      };
      lastRun = run;
      const artifact = await getArtifact(repository, run, token);
      if (artifact) {
        return { run, artifact };
      }
    }

    if (runs.length === 0 && !lastRun) {
      throw new DashboardError(ERROR_MESSAGES.noCompletedRun(owner, repo, repository.workflow, repository.branch));
    }
    if (runs.length < Number(CONSTANTS.api.runPageSize)) {
      break;
    }
    page += 1;
  }
  if (!lastRun) {
    throw new DashboardError(ERROR_MESSAGES.noCompletedRun(owner, repo, repository.workflow, repository.branch));
  }
  throw new DashboardError(ERROR_MESSAGES.noArtifact(lastRun.html_url, JSON.stringify(repository.artifact)));
}

async function getArtifact(repository: Repository, run: WorkflowRun, token?: string): Promise<Artifact | undefined> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const query = new URLSearchParams({
    [CONSTANTS.api.artifactNameQueryKey]: repository.artifact,
    [CONSTANTS.api.pageSizeQueryKey]: CONSTANTS.api.artifactPageSize
  });
  const url = `${apiUrl(
    CONSTANTS.api.resourceSegment,
    owner,
    repo,
    CONSTANTS.api.actionsSegment,
    CONSTANTS.api.runsSegment,
    String(run.id),
    CONSTANTS.api.artifactsSegment
  )}?${query}`;
  const response = await requestJson(url, token);
  const artifacts = response[CONSTANTS.api.artifactsKey];
  if (!Array.isArray(artifacts)) {
    throw new DashboardError(ERROR_MESSAGES.invalidArtifactList(owner, repo));
  }
  const usable = artifacts.filter(
    (artifact): artifact is JsonRecord =>
      isRecord(artifact) &&
      artifact[CONSTANTS.api.nameKey] === repository.artifact &&
      artifact[CONSTANTS.api.expiredKey] === false &&
      typeof artifact[CONSTANTS.api.idKey] === 'number'
  );
  usable.sort((left, right) => stringValue(right[CONSTANTS.api.createdAtKey]).localeCompare(stringValue(left[CONSTANTS.api.createdAtKey])));
  const artifact = usable[0];
  if (!artifact) {
    return undefined;
  }
  const artifactId = artifact[CONSTANTS.api.idKey];
  const createdAt = artifact[CONSTANTS.api.createdAtKey];
  return {
    id: artifactId as number,
    name: repository.artifact,
    expired: false,
    created_at: typeof createdAt === 'string' ? createdAt : null
  };
}

function validZipPath(filename: string): boolean {
  const normalized = filename.replaceAll(CONSTANTS.config.windowsPathSeparator, CONSTANTS.config.pathSeparator);
  return (
    !normalized.startsWith(CONSTANTS.config.pathSeparator) &&
    !normalized.split(CONSTANTS.config.pathSeparator).includes(CONSTANTS.config.traversalSegment)
  );
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
    throw new DashboardError(ERROR_MESSAGES.invalidArchive(repository.owner, repository.repo), { cause: error });
  }

  const files: ReportFile[] = [];
  let totalUncompressed = 0;
  let entryCount = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_FILES) {
        throw new DashboardError(ERROR_MESSAGES.tooManyArchiveFiles(repository.owner, repository.repo));
      }
      if (entry.fileName.endsWith(CONSTANTS.files.zipDirectorySuffix) || !validZipPath(entry.fileName)) {
        continue;
      }

      if (
        path.posix.extname(entry.fileName).toLowerCase() !== CONSTANTS.files.jsonExtension ||
        !matchesArtifactPattern(entry.fileName, repository.cucumberPatterns)
      ) {
        continue;
      }

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new DashboardError(ERROR_MESSAGES.archiveTooLarge(repository.owner, repository.repo));
      }

      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let fileSize = 0;
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileSize += data.length;
        if (fileSize > MAX_UNCOMPRESSED_BYTES) {
          throw new DashboardError(ERROR_MESSAGES.fileTooLarge(entry.fileName));
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
    throw new DashboardError(ERROR_MESSAGES.archiveReadFailed(repository.owner, repository.repo, String(error)), { cause: error });
  }
  return files;
}

async function downloadArtifact(repository: Repository, artifact: Artifact, token?: string): Promise<ReportFile[]> {
  const owner = encodeURIComponent(repository.owner);
  const repo = encodeURIComponent(repository.repo);
  const url = apiUrl(
    CONSTANTS.api.resourceSegment,
    owner,
    repo,
    CONSTANTS.api.actionsSegment,
    CONSTANTS.api.artifactsSegment,
    String(artifact.id),
    CONSTANTS.api.archiveFormat
  );
  return readArchive(await requestBytes(url, token), repository);
}

function labels(repository: Repository, suite: string, format: string, extra: AllureLabel[] = []): AllureLabel[] {
  return [
    { name: CONSTANTS.allure.parentSuiteLabel, value: repository.repo },
    { name: CONSTANTS.allure.suiteLabel, value: suite },
    { name: CONSTANTS.allure.packageLabel, value: repositoryIdentity(repository.owner, repository.repo) },
    { name: CONSTANTS.allure.tagLabel, value: `${CONSTANTS.allure.sourceTagPrefix}${repositoryIdentity(repository.owner, repository.repo)}` },
    { name: CONSTANTS.allure.tagLabel, value: `${CONSTANTS.allure.formatTagPrefix}${format}` },
    ...extra.filter(({ value }) => value !== CONSTANTS.strings.empty)
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
    testCaseId: hash(`${options.fullName}${CONSTANTS.separators.hash}${options.name}`),
    name: options.name,
    fullName: options.fullName,
    status: options.status,
    stage: CONSTANTS.allure.finishedStage,
    start: options.start,
    stop: options.start + options.duration,
    labels: options.labels,
    links: [{ name: CONSTANTS.allure.runLinkName, url: options.runUrl, type: CONSTANTS.allure.linkType }]
  };
  if (options.steps) {
    result.steps = options.steps;
  }
  if (options.message || options.trace) {
    result.statusDetails = {
      known: false,
      muted: false,
      flaky: false,
      message: options.message ?? CONSTANTS.strings.empty,
      trace: options.trace ?? CONSTANTS.strings.empty
    };
  }
  return result;
}

function cucumberStatus(steps: unknown[]): {
  status: string;
  message: string;
  trace: string;
} {
  const { unknown, failed, ambiguous, undefined: undefinedStatus, pending, skipped, passed, broken } = CONSTANTS.cucumber.status;
  if (steps.length === 0) {
    return { status: unknown, message: CONSTANTS.strings.empty, trace: CONSTANTS.strings.empty };
  }

  const statuses: string[] = [];
  const messages: string[] = [];
  const traces: string[] = [];
  for (const step of steps) {
    const result = getRecord(step, CONSTANTS.cucumber.resultKey);
    const status = stringValue(result?.[CONSTANTS.cucumber.statusKey], unknown).toLowerCase();
    statuses.push(status);
    const error = stringValue(result?.[CONSTANTS.cucumber.errorMessageKey]).trim();
    if (error) {
      messages.push(error.split(CONSTANTS.regex.lineBreak, 1)[0] ?? '');
      traces.push(error);
    }
  }

  const mapping: Array<[string, string]> = [
    [failed, failed],
    [ambiguous, failed],
    [undefinedStatus, broken],
    [pending, skipped],
    [skipped, skipped],
    [unknown, unknown]
  ];
  for (const [source, target] of mapping) {
    if (statuses.includes(source)) {
      return { status: target, message: messages.join(CONSTANTS.separators.lineBreak), trace: traces.join(CONSTANTS.separators.trace) };
    }
  }
  return statuses.every((status) => status === passed)
    ? { status: passed, message: CONSTANTS.strings.empty, trace: CONSTANTS.strings.empty }
    : { status: unknown, message: messages.join(CONSTANTS.separators.lineBreak), trace: traces.join(CONSTANTS.separators.trace) };
}

function allureCucumberStatus(status: string): string {
  const { passed, failed, ambiguous, undefined: undefinedStatus, pending, skipped, unknown, broken } = CONSTANTS.cucumber.status;
  switch (status.toLowerCase()) {
    case passed:
      return passed;
    case failed:
    case ambiguous:
      return failed;
    case undefinedStatus:
      return broken;
    case pending:
    case skipped:
      return skipped;
    default:
      return unknown;
  }
}

function cucumberResults(filename: string, data: Buffer, repository: Repository, runUrl: string): AllureResult[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(data.toString(CONSTANTS.files.utf8Encoding));
  } catch (error) {
    if (filename.toLowerCase().includes(CONSTANTS.cucumber.errorNameHint)) {
      throw new DashboardError(ERROR_MESSAGES.invalidCucumberJson(filename, String(error)), { cause: error });
    }
    return undefined;
  }

  const features = isRecord(document) ? document[CONSTANTS.cucumber.featuresKey] : document;
  if (!Array.isArray(features) || !features.some((feature) => isRecord(feature) && CONSTANTS.cucumber.elementsKey in feature)) {
    return undefined;
  }

  const results: AllureResult[] = [];
  for (const feature of features) {
    if (!isRecord(feature)) {
      continue;
    }
    const featureName = stringValue(feature[CONSTANTS.cucumber.nameKey], stringValue(feature[CONSTANTS.cucumber.uriKey], filename));
    for (const element of recordArray(feature[CONSTANTS.cucumber.elementsKey])) {
      if (element[CONSTANTS.cucumber.typeKey] === CONSTANTS.cucumber.backgroundType) {
        continue;
      }

      const name = stringValue(
        element[CONSTANTS.cucumber.nameKey],
        stringValue(element[CONSTANTS.cucumber.idKey], CONSTANTS.cucumber.unnamedScenario)
      );
      const fullName = `${repositoryIdentity(repository.owner, repository.repo)}${CONSTANTS.cucumber.featureSeparator}${featureName}${CONSTANTS.cucumber.featureSeparator}${name}`;
      const steps = [
        ...recordArray(element[CONSTANTS.cucumber.beforeKey]).map((value) => ({
          value,
          phase: CONSTANTS.cucumber.beforeHookName
        })),
        ...recordArray(element[CONSTANTS.cucumber.stepsKey]).map((value) => ({ value, phase: CONSTANTS.strings.empty })),
        ...recordArray(element[CONSTANTS.cucumber.afterKey]).map((value) => ({
          value,
          phase: CONSTANTS.cucumber.afterHookName
        }))
      ];
      const stepValues = steps.map(({ value }) => value);
      const outcome = cucumberStatus(stepValues);
      const scenarioStart = timestampMilliseconds(element[CONSTANTS.cucumber.startTimestampKey]);
      let duration = 0;
      const allureSteps = steps.map(({ value, phase }): AllureStep => {
        const result = getRecord(value, CONSTANTS.cucumber.resultKey);
        const stepDuration = durationMilliseconds(result?.[CONSTANTS.cucumber.durationKey], 1 / 1_000_000);
        const start = scenarioStart + duration;
        duration += stepDuration;

        const match = getRecord(value, CONSTANTS.cucumber.matchKey);
        const location = stringValue(match?.[CONSTANTS.cucumber.locationKey]);
        const name = valueHasName(value)
          ? stringValue(value[CONSTANTS.cucumber.nameKey])
          : `${phase || CONSTANTS.cucumber.unnamedStep}${
              location ? `${CONSTANTS.cucumber.locationPrefix}${location}${CONSTANTS.cucumber.locationSuffix}` : CONSTANTS.strings.empty
            }`;
        const message = stringValue(result?.[CONSTANTS.cucumber.errorMessageKey]);
        const step: AllureStep = {
          name,
          status: allureCucumberStatus(stringValue(result?.[CONSTANTS.cucumber.statusKey], CONSTANTS.cucumber.status.unknown)),
          stage: CONSTANTS.allure.finishedStage,
          start,
          stop: start + stepDuration
        };
        if (message) {
          step.statusDetails = {
            known: false,
            muted: false,
            flaky: false,
            message: message.split(CONSTANTS.regex.lineBreak, 1)[0] ?? '',
            trace: message
          };
        }
        return step;
      });
      const tags = [...recordArray(feature[CONSTANTS.cucumber.tagsKey]), ...recordArray(element[CONSTANTS.cucumber.tagsKey])].map((tag) => {
        const tagName = stringValue(tag[CONSTANTS.cucumber.nameKey]);
        return tagName.startsWith(CONSTANTS.cucumber.tagPrefix) ? tagName.slice(1) : tagName;
      });

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
            CONSTANTS.allure.sourceFormat,
            tags.map((value) => ({ name: CONSTANTS.allure.tagLabel, value }))
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
  const name = isRecord(value) ? value[CONSTANTS.cucumber.nameKey] : undefined;
  return typeof name === 'string' && name.length > 0;
}

export function convertArtifact(files: ReportFile[], repository: Repository, runUrl: string): AllureResult[] {
  const results: AllureResult[] = [];
  for (const file of files) {
    if (
      path.posix.extname(file.filename).toLowerCase() === CONSTANTS.files.jsonExtension &&
      matchesArtifactPattern(file.filename, repository.cucumberPatterns)
    ) {
      results.push(...(cucumberResults(file.filename, file.data, repository, runUrl) ?? []));
    }
  }

  if (results.length === 0) {
    throw new DashboardError(ERROR_MESSAGES.noCucumberScenarios(repository.owner, repository.repo));
  }
  return results;
}

async function writeResults(output: string, results: AllureResult[], repositories: Repository[]): Promise<void> {
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length > 0) {
    throw new DashboardError(ERROR_MESSAGES.outputNotEmpty(output));
  }

  await Promise.all(
    results.map((result) =>
      writeFile(path.join(output, `${result.uuid}${CONSTANTS.files.resultFileSuffix}`), JSON.stringify(result), CONSTANTS.files.utf8Encoding)
    )
  );

  const runNumber = process.env[CONSTANTS.files.runNumberVariable] ?? CONSTANTS.runtime.localBuildName;
  const executor = {
    name: CONSTANTS.allure.executorName,
    type: CONSTANTS.allure.executorType,
    buildName: runNumber,
    buildOrder: Number(runNumber) || 0,
    reportUrl: `${process.env[CONSTANTS.files.serverUrlVariable] ?? CONSTANTS.runtime.githubFallbackUrl}${CONSTANTS.config.pathSeparator}${process.env[CONSTANTS.files.repositoryVariable] ?? CONSTANTS.strings.empty}`
  };
  await writeFile(path.join(output, CONSTANTS.files.executorFile), JSON.stringify(executor), CONSTANTS.files.utf8Encoding);
  await writeFile(
    path.join(output, CONSTANTS.files.environmentFile),
    `${CONSTANTS.files.sourceRepositoriesProperty}=${repositories
      .map(({ owner, repo }) => `${owner}${CONSTANTS.config.pathSeparator}${repo}`)
      .join(CONSTANTS.config.listSeparator)}${CONSTANTS.separators.lineBreak}`,
    CONSTANTS.files.utf8Encoding
  );
}

export async function buildDashboard(configPath: string, output: string): Promise<number> {
  const repositories = loadRepositories(await readFile(configPath, CONSTANTS.files.utf8Encoding));
  const token = process.env[CONSTANTS.files.reportsTokenVariable] || undefined;
  const collected = await collectRepositories(repositories, async (repository) => {
    const { run, artifact } = await getLatestRun(repository, token);
    if (!CONSTANTS.runConclusions.some((conclusion) => conclusion === run.conclusion)) {
      throw new DashboardError(ERROR_MESSAGES.unsupportedRunConclusion(run.html_url, JSON.stringify(run.conclusion)));
    }
    const files = await downloadArtifact(repository, artifact, token);
    return { runUrl: run.html_url, results: convertArtifact(files, repository, run.html_url) };
  });

  await writeResults(output, collected.results, collected.repositories);
  console.log(LOG_MESSAGES.generatedResults(collected.results.length, output));
  return collected.results.length;
}

export async function collectRepositories(
  repositories: Repository[],
  collectRepository: (repository: Repository) => Promise<{ runUrl: string; results: AllureResult[] }>
): Promise<{ results: AllureResult[]; repositories: Repository[] }> {
  const results: AllureResult[] = [];
  const collectedRepositories: Repository[] = [];
  const failures: string[] = [];

  for (const repository of repositories) {
    const identity = repositoryIdentity(repository.owner, repository.repo);
    console.log(LOG_MESSAGES.collectingRepository(identity));
    try {
      const collected = await collectRepository(repository);
      console.log(LOG_MESSAGES.addedResults(collected.results.length, collected.runUrl));
      results.push(...collected.results);
      collectedRepositories.push(repository);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failure = LOG_MESSAGES.repositoryFailed(identity, reason);
      console.error(failure);
      failures.push(failure);
    }
  }

  if (collectedRepositories.length === 0) {
    throw new DashboardError(ERROR_MESSAGES.noRepositoryReports(failures.join(CONSTANTS.separators.lineBreak)));
  }
  return { results, repositories: collectedRepositories };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf(CONSTANTS.files.configOption);
  const outputIndex = args.indexOf(CONSTANTS.files.outputOption);
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!configPath || !output || args.length !== 4) {
    throw new DashboardError(ERROR_MESSAGES.cliUsage);
  }
  await buildDashboard(configPath, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(LOG_MESSAGES.error(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
