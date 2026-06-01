import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface NpmPackOutputItem {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly filename: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const PACKAGE_NAME = 'openrouter-rate-limiter';

async function main(): Promise<void> {
  const packageRoot = process.cwd();
  const consumerRoot = await mkdtemp(
    path.join(os.tmpdir(), 'openrouter-rate-limiter-consumer-'),
  );

  let tarballPath: string | null = null;

  try {
    logTitle('Verifying package as an external consumer');
    logInfo('Package root: ' + packageRoot);
    logInfo('Consumer temp project: ' + consumerRoot);

    await runStep('Cleaning package dist', async () => {
      await runNpm({
        cwd: packageRoot,
        args: ['run', 'clean'],
      });
    });

    await runStep('Type-checking package', async () => {
      await runNpm({
        cwd: packageRoot,
        args: ['run', 'check'],
      });
    });

    await runStep('Running package tests', async () => {
      await runNpm({
        cwd: packageRoot,
        args: ['run', 'test'],
      });
    });

    await runStep('Building package', async () => {
      await runNpm({
        cwd: packageRoot,
        args: ['run', 'build'],
      });
    });

await runStep('Creating temp consumer project', async () => {
  await createConsumerProject(consumerRoot);
});

tarballPath = await runStep('Packing package', async () => {
  const result = await runNpm({
    cwd: packageRoot,
    args: ['pack', '--json', '--pack-destination', consumerRoot],
  });

  const packed = parseNpmPackOutput(result.stdout);
  const first = packed[0];

  if (!first) {
    throw new Error('npm pack did not return any package output item.');
  }

  const resolvedTarballPath = resolvePackedTarballPath({
    packageRoot,
    packDestination: consumerRoot,
    filename: first.filename,
  });

  logInfo('Package tarball: ' + resolvedTarballPath);

  return resolvedTarballPath;
});

    await runStep('Installing tarball in temp consumer project', async () => {
      if (tarballPath === null) {
        throw new Error('Cannot install package because tarballPath is null.');
      }

      await runNpm({
        cwd: consumerRoot,
        args: ['install', tarballPath, '--no-audit', '--ignore-scripts'],
      });
    });

    await runStep('Type-checking external consumer', async () => {
      await runTypeScriptConsumerTypecheck({
        packageRoot,
        consumerRoot,
      });
    });

    await runStep('Running external consumer ESM smoke test', async () => {
      await runNode({
        cwd: consumerRoot,
        args: [path.join(consumerRoot, 'runtime.mjs')],
      });
    });

    await runStep('Running external consumer CommonJS smoke test', async () => {
      await runNode({
        cwd: consumerRoot,
        args: [path.join(consumerRoot, 'runtime.cjs')],
      });
    });

    logSuccess('External consumer verification passed.');
  } finally {
    await rm(consumerRoot, {
      recursive: true,
      force: true,
    });

    if (tarballPath !== null) {
      await rm(tarballPath, {
        force: true,
      });
    }
  }
}

async function createConsumerProject(consumerRoot: string): Promise<void> {
  await mkdir(path.join(consumerRoot, 'src'), {
    recursive: true,
  });

  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'openrouter-rate-limiter-consumer-test',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          check: 'tsc -p tsconfig.json --noEmit',
          start: 'node runtime.mjs',
          'start:cjs': 'node runtime.cjs',
        },
        dependencies: {},
        devDependencies: {},
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    path.join(consumerRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    path.join(consumerRoot, 'src', 'index.ts'),
    buildConsumerTypeScriptFixture(),
    'utf8',
  );

  await writeFile(
    path.join(consumerRoot, 'runtime.mjs'),
    buildConsumerRuntimeFixture(),
    'utf8',
  );

  await writeFile(
    path.join(consumerRoot, 'runtime.cjs'),
    buildConsumerCommonJsRuntimeFixture(),
    'utf8',
  );
}

function buildConsumerTypeScriptFixture(): string {
  return [
    'import {',
    '  OpenRouterRateLimiter,',
    '  OpenRouterRateLimitError,',
    '  createMemoryRateLimitStateStore,',
    '  createOpenRouterRateLimitedClient,',
    '  createOpenRouterRateLimitedFetch,',
    '  withOpenRouterMetadata,',
    '  type OpenRouterAvailabilityInspection,',
    '  type OpenRouterLimitDecision,',
    '  type OpenRouterRateLimitEvent,',
    '  type OpenRouterRateLimitedClient,',
    '  type OpenRouterRateLimiterConfig,',
    '} from "' + PACKAGE_NAME + '";',
    '',
    'const events: OpenRouterRateLimitEvent[] = [];',
    '',
    'const config: OpenRouterRateLimiterConfig = {',
    '  apiKey: "sk-or-test",',
    '  defaultModel: "openai/gpt-4o-mini",',
    '  appName: "Consumer Test",',
    '  global: {',
    '    maxConcurrentRequests: 1,',
    '    minIntervalMs: 1,',
    '    requestsPerWindow: 20,',
    '    windowMs: 60_000,',
    '  },',
    '  defaultPolicy: {',
    '    mode: "wait",',
    '    maxRetries: 2,',
    '    baseDelayMs: 1,',
    '    maxDelayMs: 5,',
    '    jitterRatio: 0,',
    '    respectRetryAfter: true,',
    '    cooldownNotificationIntervalMs: 1,',
    '  },',
    '  models: {',
    '    "openai/gpt-4o-mini": {',
    '      maxConcurrentRequests: 1,',
    '      minIntervalMs: 1,',
    '      requestsPerWindow: 10,',
    '      windowMs: 60_000,',
    '      inputCharactersPerWindow: 100_000,',
    '    },',
    '  },',
    '  store: createMemoryRateLimitStateStore(),',
    '  hooks: {',
    '    onEvent: async (event) => {',
    '      events.push(event);',
    '    },',
    '    onLimitReached: async (): Promise<OpenRouterLimitDecision> => {',
    '      return "wait";',
    '    },',
    '  },',
    '};',
    '',
    'const limiter = new OpenRouterRateLimiter(config);',
    '',
    'const availability: OpenRouterAvailabilityInspection = await limiter.inspectAvailability({',
    '  model: "openai/gpt-4o-mini",',
    '  estimatedInputCharacters: 10,',
    '});',
    '',
    'if (!availability.model) {',
    '  throw new Error("Availability inspection did not resolve a model.");',
    '}',
    '',
    'const openRouterFetch = createOpenRouterRateLimitedFetch({',
    '  limiter,',
    '  requestTimeoutMs: 5_000,',
    '  fetch: async () => {',
    '    return new Response(JSON.stringify({ ok: true }), {',
    '      status: 200,',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '      },',
    '    });',
    '  },',
    '});',
    '',
    'const response = await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", {',
    '  method: "POST",',
    '  body: JSON.stringify({',
    '    model: "openai/gpt-4o-mini",',
    '    messages: [],',
    '  }),',
    '});',
    '',
    'const client: OpenRouterRateLimitedClient = createOpenRouterRateLimitedClient({',
    '  apiKey: "sk-or-test",',
    '  defaultModel: "openai/gpt-4o-mini",',
    '  requestTimeoutMs: 5_000,',
    '  fetch: async () => {',
    '    return new Response(JSON.stringify({ id: "chatcmpl-test", choices: [] }), {',
    '      status: 200,',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '      },',
    '    });',
    '  },',
    '});',
    '',
    'const completion = await client.chatCompletions<{',
    '  readonly id: string;',
    '  readonly choices: readonly unknown[];',
    '}>({',
    '  model: "openai/gpt-4o-mini",',
    '  messages: [],',
    '});',
    '',
    'const init = withOpenRouterMetadata(',
    '  {',
    '    method: "POST",',
    '    body: JSON.stringify({',
    '      messages: [],',
    '    }),',
    '  },',
    '  {',
    '    model: "openai/gpt-4o-mini",',
    '    operation: "consumer-test",',
    '  },',
    ');',
    '',
    'await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", init);',
    '',
    'if (!response.ok) {',
    '  throw new OpenRouterRateLimitError({',
    '    message: "Unexpected response",',
    '    model: "openai/gpt-4o-mini",',
    '    reason: "unknown",',
    '    retryAfterMs: 0,',
    '    retryAt: new Date(),',
    '    attempt: 1,',
    '    maxRetries: 1,',
    '    metadata: {',
    '      model: "openai/gpt-4o-mini",',
    '    },',
    '  });',
    '}',
    '',
    'console.log(completion.id, events.length);',
    '',
  ].join('\n');
}

function buildConsumerRuntimeFixture(): string {
  return [
    'import {',
    '  OpenRouterRateLimiter,',
    '  createMemoryRateLimitStateStore,',
    '  createOpenRouterRateLimitedClient,',
    '  createOpenRouterRateLimitedFetch,',
    '} from "' + PACKAGE_NAME + '";',
    '',
    'const limiter = new OpenRouterRateLimiter({',
    '  apiKey: "sk-or-test",',
    '  defaultModel: "openai/gpt-4o-mini",',
    '  store: createMemoryRateLimitStateStore(),',
    '  defaultPolicy: {',
    '    mode: "wait",',
    '    maxRetries: 1,',
    '    baseDelayMs: 1,',
    '    maxDelayMs: 5,',
    '    jitterRatio: 0,',
    '    cooldownNotificationIntervalMs: 1,',
    '  },',
    '});',
    '',
    'const availability = await limiter.inspectAvailability({',
    '  model: "openai/gpt-4o-mini",',
    '});',
    '',
    'if (!availability.model) {',
    '  throw new Error("Expected availability inspection to resolve a model.");',
    '}',
    '',
    'const openRouterFetch = createOpenRouterRateLimitedFetch({',
    '  limiter,',
    '  requestTimeoutMs: 5_000,',
    '  fetch: async () => {',
    '    return new Response(JSON.stringify({ ok: true }), {',
    '      status: 200,',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '      },',
    '    });',
    '  },',
    '});',
    '',
    'const response = await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", {',
    '  method: "POST",',
    '  body: JSON.stringify({',
    '    model: "openai/gpt-4o-mini",',
    '    messages: [],',
    '  }),',
    '});',
    '',
    'if (!response.ok) {',
    '  throw new Error("Expected successful response from rate-limited fetch.");',
    '}',
    '',
    'const client = createOpenRouterRateLimitedClient({',
    '  apiKey: "sk-or-test",',
    '  defaultModel: "openai/gpt-4o-mini",',
    '  requestTimeoutMs: 5_000,',
    '  fetch: async () => {',
    '    return new Response(JSON.stringify({ id: "chatcmpl-runtime", choices: [] }), {',
    '      status: 200,',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '      },',
    '    });',
    '  },',
    '});',
    '',
    'const completion = await client.chatCompletions({',
    '  model: "openai/gpt-4o-mini",',
    '  messages: [],',
    '});',
    '',
    'if (completion.id !== "chatcmpl-runtime") {',
    '  throw new Error("Expected runtime chat completion fixture to work.");',
    '}',
    '',
    'console.log("runtime-esm-ok");',
    '',
  ].join('\n');
}

function buildConsumerCommonJsRuntimeFixture(): string {
  return [
    'const {',
    '  OpenRouterRateLimiter,',
    '  createMemoryRateLimitStateStore,',
    '  createOpenRouterRateLimitedFetch,',
    '} = require("' + PACKAGE_NAME + '");',
    '',
    'async function main() {',
    '  const limiter = new OpenRouterRateLimiter({',
    '    apiKey: "sk-or-test",',
    '    defaultModel: "openai/gpt-4o-mini",',
    '    store: createMemoryRateLimitStateStore(),',
    '    defaultPolicy: {',
    '      mode: "wait",',
    '      maxRetries: 1,',
    '      baseDelayMs: 1,',
    '      maxDelayMs: 5,',
    '      jitterRatio: 0,',
    '      cooldownNotificationIntervalMs: 1,',
    '    },',
    '  });',
    '',
    '  const openRouterFetch = createOpenRouterRateLimitedFetch({',
    '    limiter,',
    '    fetch: async () => {',
    '      return new Response(JSON.stringify({ ok: true }), {',
    '        status: 200,',
    '        headers: {',
    '          "Content-Type": "application/json",',
    '        },',
    '      });',
    '    },',
    '  });',
    '',
    '  const response = await openRouterFetch("https://openrouter.ai/api/v1/chat/completions", {',
    '    method: "POST",',
    '    body: JSON.stringify({',
    '      model: "openai/gpt-4o-mini",',
    '      messages: [],',
    '    }),',
    '  });',
    '',
    '  if (!response.ok) {',
    '    throw new Error("Expected successful CommonJS response.");',
    '  }',
    '',
    '  console.log("runtime-cjs-ok");',
    '}',
    '',
    'main().catch((error) => {',
    '  console.error(error);',
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}

async function runTypeScriptConsumerTypecheck(params: {
  readonly packageRoot: string;
  readonly consumerRoot: string;
}): Promise<void> {
  const tscPath = await findTypeScriptCompiler(params.packageRoot);

  await runNode({
    cwd: params.consumerRoot,
    args: [
      tscPath,
      '-p',
      path.join(params.consumerRoot, 'tsconfig.json'),
      '--noEmit',
    ],
  });
}

async function findTypeScriptCompiler(startDirectory: string): Promise<string> {
  const candidates = [
    path.join(startDirectory, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(startDirectory, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(process.cwd(), '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  throw new Error(
    [
      'Cannot find TypeScript compiler.',
      'Install typescript in the workspace or package before running verify:consumer.',
    ].join(' '),
  );
}

function resolvePackedTarballPath(params: {
  readonly packageRoot: string;
  readonly packDestination: string;
  readonly filename: string;
}): string {
  if (path.isAbsolute(params.filename)) {
    return params.filename;
  }

  const fromPackDestination = path.resolve(
    params.packDestination,
    params.filename,
  );

  const fromPackageRoot = path.resolve(
    params.packageRoot,
    params.filename,
  );

  /*
   * npm normally writes the tarball inside --pack-destination, but older npm
   * versions may report only a relative filename. Prefer the explicit temp
   * destination because that is the path we install from.
   */
  return fromPackDestination.includes(path.resolve(params.packDestination))
    ? fromPackDestination
    : fromPackageRoot;
}

function parseNpmPackOutput(stdout: string): readonly NpmPackOutputItem[] {
  const trimmed = stdout.trim();
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');

  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error('npm pack --json did not return a JSON array.');
  }

  const jsonText = trimmed.slice(firstBracket, lastBracket + 1);
  const parsed = JSON.parse(jsonText) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('npm pack --json did not return an array.');
  }

  return parsed.map(parseNpmPackOutputItem);
}

function parseNpmPackOutputItem(value: unknown): NpmPackOutputItem {
  if (!isRecord(value)) {
    throw new Error('Invalid npm pack output item.');
  }

  const filename = readString(value, 'filename');

  if (!filename) {
    throw new Error('Invalid npm pack output item: missing filename.');
  }

  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const version = readString(value, 'version');

  return {
    filename,
    ...(id !== null ? { id } : {}),
    ...(name !== null ? { name } : {}),
    ...(version !== null ? { version } : {}),
  };
}

async function runStep<T>(
  label: string,
  callback: () => Promise<T>,
): Promise<T> {
  process.stdout.write('> ' + label + '\n');

  try {
    const result = await callback();

    process.stdout.write('OK ' + label + '\n');

    return result;
  } catch (error) {
    process.stderr.write('FAILED ' + label + '\n');
    throw error;
  }
}

async function runNpm(params: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<CommandResult> {
  const npmCliPath = await findNpmCliPath(params.cwd);

  return runNode({
    cwd: params.cwd,
    args: [
      npmCliPath,
      ...params.args,
    ],
  });
}

async function findNpmCliPath(startDirectory: string): Promise<string> {
  const candidates = buildNpmCliPathCandidates(startDirectory);

  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  throw new Error(
    [
      'Cannot find npm CLI script.',
      'Expected npm-cli.js from the current npm installation.',
      'Try running this script through npm, or make sure npm is installed correctly.',
    ].join(' '),
  );
}

function buildNpmCliPathCandidates(startDirectory: string): readonly string[] {
  const candidates: string[] = [];

  const npmExecPath = process.env.npm_execpath;

  if (
    npmExecPath &&
    npmExecPath.trim().length > 0 &&
    !npmExecPath.toLowerCase().endsWith('.cmd') &&
    !npmExecPath.toLowerCase().endsWith('.ps1')
  ) {
    candidates.push(npmExecPath);
  }

  candidates.push(
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.join(
      startDirectory,
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.join(
      startDirectory,
      '..',
      '..',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.join(
      process.cwd(),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.join(
      process.cwd(),
      '..',
      '..',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  );

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function runNode(params: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<CommandResult> {
  return runCommand({
    cwd: params.cwd,
    command: process.execPath,
    args: params.args,
  });
}

async function runCommand(params: {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(params.command, [...params.args], {
      cwd: params.cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
      encoding: 'utf8',
    });

    const stdout = result.stdout;
    const stderr = result.stderr;

    if (stdout.trim().length > 0) {
      process.stdout.write(stdout);
    }

    if (stderr.trim().length > 0) {
      process.stderr.write(stderr);
    }

    return {
      stdout,
      stderr,
    };
  } catch (error) {
    if (isExecError(error)) {
      if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
        process.stdout.write(error.stdout);
      }

      if (typeof error.stderr === 'string' && error.stderr.trim().length > 0) {
        process.stderr.write(error.stderr);
      }
    }

    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];

  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isExecError(value: unknown): value is {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
} {
  return typeof value === 'object' && value !== null;
}

function logTitle(message: string): void {
  process.stdout.write('\n' + message + '\n');
}

function logInfo(message: string): void {
  process.stdout.write(message + '\n');
}

function logSuccess(message: string): void {
  process.stdout.write('\nSUCCESS ' + message + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write('\nExternal consumer verification failed.\n');

  if (error instanceof Error) {
    process.stderr.write((error.stack ?? error.message) + '\n');
  } else {
    process.stderr.write(String(error) + '\n');
  }

  process.exitCode = 1;
});