import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_PROTOCOL = '2025-11-25';
const DEFAULT_TIMEOUT = 5000;
const VERSION = '0.1.0';
const JSON_SCHEMA_VERSION = 1;

const STDOUT_ISSUE_CODES = new Set([
  'stdout-empty-line',
  'stdout-content-length-framing',
  'stdout-invalid-json-rpc',
  'stdout-non-json',
  'stdout-unexpected-request-id',
  'stdout-without-newline'
]);
const JSON_RPC_ISSUE_CODES = new Set([
  'response-id-type-mismatch',
  'stdout-invalid-json-rpc',
  'stdout-unexpected-request-id'
]);
const INITIALIZE_ISSUE_CODES = new Set([
  'initialize-error',
  'initialize-timeout',
  'server-exited',
  'spawn-failed'
]);
const OPERATION_ISSUE_CODES = new Set([
  'operation-error',
  'operation-missing-response',
  'operation-timeout'
]);
const PROCESS_ISSUE_CODES = new Set([
  'server-crashed',
  'server-exited',
  'spawn-failed'
]);

export async function runCli(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(helpText());
    return;
  }

  if (options.version) {
    console.log(VERSION);
    return;
  }

  if (!options.command.length) {
    throw new Error('Missing command. Use: mcp-stdio-guard -- <command> [args...]');
  }

  const guardOptions = {
    protocol: options.protocol,
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    operation: options.requestMethod
      ? {
          method: options.requestMethod,
          params: options.requestParams
        }
      : null
  };

  const result = options.repeat > 1
    ? await guardRepeatedStdioServer(options.command, { ...guardOptions, repeat: options.repeat })
    : await guardStdioServer(options.command, guardOptions);

  if (options.scanPath) {
    result.staticScan = {
      enabled: true,
      path: options.scanPath,
      failOnFindings: options.failOnStatic
    };
    result.staticFindings = scanSource(options.scanPath);
    if (options.failOnStatic) {
      for (const finding of result.staticFindings) {
        result.issues.push({
          severity: 'error',
          code: 'static-stdout-write',
          message: `${finding.file}:${finding.line} ${finding.message}`
        });
      }
    }
  }

  finalizeResult(result);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextResult(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export function parseArgs(argv) {
  const options = {
    command: [],
    protocol: DEFAULT_PROTOCOL,
    timeoutMs: DEFAULT_TIMEOUT,
    scanPath: '',
    failOnStatic: false,
    requestMethod: '',
    requestParams: undefined,
    repeat: 1,
    json: false,
    help: false,
    version: false,
    cwd: process.cwd()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      options.command = argv.slice(index + 1);
      break;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fail-on-static') {
      options.failOnStatic = true;
    } else if (arg === '--request') {
      options.requestMethod = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === '--params') {
      options.requestParams = parseJsonOption(readOptionValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--protocol') {
      options.protocol = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === '--repeat') {
      options.repeat = Number(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === '--scan') {
      options.scanPath = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === '--cwd') {
      options.cwd = path.resolve(readOptionValue(argv, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown option before --: ${arg}`);
    }
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
    throw new Error('--timeout must be an integer >= 100');
  }

  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error('--repeat must be an integer >= 1');
  }

  if (options.requestParams !== undefined && !options.requestMethod) {
    throw new Error('--params can only be used with --request');
  }

  return options;
}

export async function guardRepeatedStdioServer(commandWithArgs, options = {}) {
  const startedAt = Date.now();
  const repeat = options.repeat ?? 1;
  const runs = [];
  const issues = [];

  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error('repeat must be an integer >= 1');
  }

  for (let index = 1; index <= repeat; index += 1) {
    const run = await guardStdioServer(commandWithArgs, options);
    run.run = index;
    runs.push(run);
    for (const issue of run.issues) {
      issues.push({ run: index, ...issue });
    }
  }

  return finalizeResult({
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: !issues.some((issue) => issue.severity === 'error'),
    command: commandWithArgs,
    protocol: options.protocol ?? DEFAULT_PROTOCOL,
    repeat,
    runs,
    issues,
    checks: {},
    staticScan: defaultStaticScan(),
    staticFindings: [],
    durationMs: Date.now() - startedAt
  });
}

export async function guardStdioServer(commandWithArgs, options = {}) {
  const startedAt = Date.now();
  const command = commandWithArgs[0];
  const args = commandWithArgs.slice(1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const protocol = options.protocol ?? DEFAULT_PROTOCOL;
  const operation = options.operation || null;
  const env = { ...process.env, ...(options.env ?? {}) };
  const issues = [];
  const frames = [];
  const stderrChunks = [];
  let stdoutBuffer = '';
  let initialized = false;
  let endedByGuard = false;
  let timer;
  let child;

  const result = {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: false,
    command: commandWithArgs,
    protocol,
    negotiatedProtocol: '',
    initialized: false,
    operation: operation
      ? {
          method: operation.method,
          responded: false,
          error: null
        }
      : null,
    frames,
    issues,
    checks: {},
    stderr: '',
    staticScan: defaultStaticScan(),
    staticFindings: [],
    durationMs: 0
  };

  return new Promise((resolve) => {
    function addIssue(severity, code, message) {
      issues.push({ severity, code, message });
    }

    function armTimeout(code, message) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        addIssue('error', code, message);
        finish();
      }, timeoutMs);
    }

    function finishSoon() {
      clearTimeout(timer);
      setTimeout(finish, 50);
    }

    function finish() {
      if (result.durationMs) return;
      clearTimeout(timer);
      result.durationMs = Date.now() - startedAt;
      result.stderr = Buffer.concat(stderrChunks).toString('utf8');
      result.initialized = initialized;
      finalizeResult(result);
      if (child && !child.killed && child.exitCode === null) {
        endedByGuard = true;
        child.kill('SIGTERM');
      }
      resolve(result);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    const pythonBufferingIssue = detectPythonBufferingIssue(commandWithArgs, env);
    if (pythonBufferingIssue) {
      addIssue('warning', 'python-buffered-stdio', pythonBufferingIssue);
    }

    child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    armTimeout('initialize-timeout', `no initialize response within ${timeoutMs}ms`);

    child.on('error', (error) => {
      clearTimeout(timer);
      addIssue('error', 'spawn-failed', error.message);
      finish();
    });

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (result.durationMs) break;
        handleStdoutLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on('exit', (code, signal) => {
      if (result.durationMs) return;
      clearTimeout(timer);
      if (stdoutBuffer.trim()) {
        addIssue('error', 'stdout-without-newline', `stdout ended with an incomplete JSON-RPC frame: ${quote(stdoutBuffer)}`);
      }
      if (!endedByGuard && initialized && result.operation && !result.operation.responded) {
        addIssue('error', 'operation-missing-response', `${result.operation.method} did not receive a response before server exit`);
      }
      if (!endedByGuard && initialized && code && code !== 0) {
        addIssue('error', 'server-crashed', `server exited after initialize (code ${code}, signal ${signal ?? 'null'})`);
      }
      if (!initialized && !endedByGuard && !issues.some((issue) => issue.code === 'spawn-failed')) {
        addIssue('error', 'server-exited', `server exited before initialize completed (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
      }
      finish();
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: {
          name: 'mcp-stdio-guard',
          version: VERSION
        }
      }
    });

    function handleStdoutLine(line) {
      if (!line.trim()) {
        addIssue('warning', 'stdout-empty-line', 'stdout contained an empty line');
        return;
      }

      if (/^Content-Length\s*:/i.test(line)) {
        addIssue('error', 'stdout-content-length-framing', 'stdout looks like LSP-style Content-Length framing; MCP stdio expects newline-delimited JSON-RPC frames');
        finish();
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        addIssue('error', 'stdout-non-json', `stdout line ${frames.length + 1} is not JSON-RPC: ${quote(line)}`);
        return;
      }

      const validation = validateJsonRpc(message);
      if (validation) {
        addIssue('error', 'stdout-invalid-json-rpc', validation);
        return;
      }

      frames.push(message);

      if (isResponseIdTypeMismatch(message, 1)) {
        clearTimeout(timer);
        addIssue('error', 'response-id-type-mismatch', `initialize response id ${JSON.stringify(message.id)} does not exactly match request id 1`);
        finish();
        return;
      }

      if (message.id === 1) {
        clearTimeout(timer);
        if (!isJsonRpcResponse(message)) {
          addIssue('error', 'stdout-unexpected-request-id', 'stdout frame with id 1 is not an initialize response');
          finish();
          return;
        }

        if (message.error) {
          addIssue('error', 'initialize-error', `initialize returned error: ${message.error.message || JSON.stringify(message.error)}`);
          finish();
          return;
        }

        initialized = true;
        result.negotiatedProtocol = message.result?.protocolVersion || '';
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        if (operation) {
          const request = {
            jsonrpc: '2.0',
            id: 2,
            method: operation.method
          };
          if (operation.params !== undefined) {
            request.params = operation.params;
          }
          send(request);
          armTimeout('operation-timeout', `no ${operation.method} response within ${timeoutMs}ms`);
        } else {
          finishSoon();
        }
      } else if (operation && isResponseIdTypeMismatch(message, 2)) {
        clearTimeout(timer);
        addIssue('error', 'response-id-type-mismatch', `${operation.method} response id ${JSON.stringify(message.id)} does not exactly match request id 2`);
        finish();
      } else if (operation && message.id === 2) {
        clearTimeout(timer);
        if (!isJsonRpcResponse(message)) {
          addIssue('error', 'stdout-unexpected-request-id', `stdout frame with id 2 is not a ${operation.method} response`);
          finish();
          return;
        }

        result.operation.responded = true;
        if (message.error) {
          result.operation.error = message.error;
          addIssue('warning', 'operation-error', `${operation.method} returned error: ${message.error.message || JSON.stringify(message.error)}`);
        }
        finishSoon();
      }
    }
  });
}

export function detectPythonBufferingIssue(commandWithArgs, env = process.env) {
  const command = commandWithArgs[0] || '';
  const args = commandWithArgs.slice(1);
  const basename = path.basename(command).toLowerCase();

  if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(basename)) {
    return '';
  }

  if (Object.hasOwn(env, 'PYTHONUNBUFFERED') && String(env.PYTHONUNBUFFERED) !== '') {
    return '';
  }

  if (args.some((arg) => arg === '-u' || /^-[^-]*u/.test(arg))) {
    return '';
  }

  return 'Python stdout is buffered when piped; use python -u or PYTHONUNBUFFERED=1 for MCP stdio servers';
}

function isResponseIdTypeMismatch(message, expectedId) {
  return hasResponsePayload(message) && Object.hasOwn(message, 'id') && message.id !== expectedId && String(message.id) === String(expectedId);
}

function isJsonRpcResponse(message) {
  return hasResponsePayload(message) && !Object.hasOwn(message, 'method');
}

function hasResponsePayload(message) {
  return Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error');
}

export function validateJsonRpc(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return 'JSON-RPC frame must be an object';
  }

  if (message.jsonrpc !== '2.0') {
    return 'JSON-RPC frame must include jsonrpc: "2.0"';
  }

  const hasId = Object.hasOwn(message, 'id');
  const hasMethod = typeof message.method === 'string';
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');

  if (hasMethod && (hasResult || hasError)) {
    return 'request/notification frame must not include result or error';
  }

  if (hasId && !hasMethod && !hasResult && !hasError) {
    return 'response frame must include result or error';
  }

  if (!hasId && !hasMethod) {
    return 'notification/request frame must include method';
  }

  return '';
}

function finalizeResult(result) {
  result.schemaVersion = JSON_SCHEMA_VERSION;
  result.staticScan ??= defaultStaticScan();
  result.staticFindings ??= [];
  result.ok = !result.issues.some((issue) => issue.severity === 'error');
  result.checks = buildChecks(result);
  return result;
}

function buildChecks(result) {
  const issues = result.issues ?? [];
  const repeated = Array.isArray(result.runs);

  return {
    initialize: repeated
      ? aggregateRunCheck(result, 'initialize')
      : buildInitializeCheck(result, issues),
    stdout: buildIssueCheck(issues, (issue) => STDOUT_ISSUE_CODES.has(issue.code)),
    jsonRpc: buildIssueCheck(issues, (issue) => JSON_RPC_ISSUE_CODES.has(issue.code)),
    operation: repeated
      ? aggregateRunCheck(result, 'operation')
      : buildOperationCheck(result, issues),
    process: buildIssueCheck(issues, (issue) => PROCESS_ISSUE_CODES.has(issue.code)),
    pythonBuffering: buildIssueCheck(issues, (issue) => issue.code === 'python-buffered-stdio'),
    staticScan: buildStaticScanCheck(result, issues),
    repeat: buildRepeatCheck(result)
  };
}

function buildInitializeCheck(result, issues) {
  const matched = issues.filter((issue) => (
    INITIALIZE_ISSUE_CODES.has(issue.code)
    || (!result.initialized && STDOUT_ISSUE_CODES.has(issue.code))
    || (!result.initialized && JSON_RPC_ISSUE_CODES.has(issue.code))
  ));
  if (matched.length) return makeCheck(statusFromIssues(matched), matched);
  return makeCheck(result.initialized ? 'pass' : 'fail', []);
}

function buildOperationCheck(result, issues) {
  if (!result.operation) {
    return makeCheck('skipped', []);
  }

  if (!result.initialized) {
    return makeCheck('skipped', []);
  }

  const matched = issues.filter((issue) => (
    OPERATION_ISSUE_CODES.has(issue.code)
    || (!result.operation.responded && STDOUT_ISSUE_CODES.has(issue.code))
    || (!result.operation.responded && JSON_RPC_ISSUE_CODES.has(issue.code))
  ));
  if (matched.length) {
    return makeCheck(statusFromIssues(matched), matched);
  }

  return makeCheck(result.operation.responded ? 'pass' : 'fail', []);
}

function buildStaticScanCheck(result, issues) {
  if (!result.staticScan?.enabled) {
    return makeCheck('skipped', []);
  }

  const matched = issues.filter((issue) => issue.code === 'static-stdout-write');
  if (matched.length) {
    return makeCheck(statusFromIssues(matched), matched);
  }

  if (result.staticFindings?.length) {
    return makeCheck('warning', [{ code: 'static-stdout-write' }]);
  }

  return makeCheck('pass', []);
}

function buildRepeatCheck(result) {
  if (!Array.isArray(result.runs)) {
    return makeCheck('skipped', []);
  }

  const failedRuns = result.runs.filter((run) => !run.ok).map((run) => run.run);
  return {
    ...makeCheck(failedRuns.length ? 'fail' : 'pass', result.issues ?? []),
    runs: result.runs.length,
    passedRuns: result.runs.length - failedRuns.length,
    failedRuns
  };
}

function aggregateRunCheck(result, checkName) {
  const checks = result.runs
    .map((run) => run.checks?.[checkName])
    .filter(Boolean)
    .filter((check) => check.status !== 'skipped');

  if (!checks.length) {
    return makeCheck('skipped', []);
  }

  const status = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'warning')
      ? 'warning'
      : 'pass';
  const issueCodes = [...new Set(checks.flatMap((check) => check.issueCodes))].sort();
  return { status, issueCodes };
}

function buildIssueCheck(issues, predicate) {
  const matched = issues.filter(predicate);
  return makeCheck(matched.length ? statusFromIssues(matched) : 'pass', matched);
}

function statusFromIssues(issues) {
  return issues.some((issue) => issue.severity === 'error') ? 'fail' : 'warning';
}

function makeCheck(status, issues) {
  return {
    status,
    issueCodes: [...new Set(issues.map((issue) => issue.code))].sort()
  };
}

function defaultStaticScan() {
  return {
    enabled: false,
    path: '',
    failOnFindings: false
  };
}

export function scanSource(root) {
  const findings = [];
  const absoluteRoot = path.resolve(root);
  const files = listSourceFiles(absoluteRoot);

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const message = detectStdoutWrite(file, lines[index]);
      if (message) {
        findings.push({
          file: path.relative(process.cwd(), file).split(path.sep).join('/'),
          line: index + 1,
          message
        });
      }
    }
  }

  return findings;
}

function detectStdoutWrite(file, line) {
  const ext = path.extname(file);
  const stripped = line.trim();
  if (!stripped || stripped.startsWith('//') || stripped.startsWith('#')) return '';

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext) && /\bconsole\.(log|info)\s*\(/.test(line)) {
    return 'console.log/info writes to stdout; use console.error for MCP stdio diagnostics';
  }

  if (ext === '.py' && /(^|[^\w])print\s*\(/.test(line) && !/file\s*=\s*sys\.stderr/.test(line)) {
    return 'print() writes to stdout; pass file=sys.stderr for MCP stdio diagnostics';
  }

  if (ext === '.go' && /\bfmt\.(Print|Printf|Println)\s*\(/.test(line)) {
    return 'fmt.Print* writes to stdout; use stderr for MCP stdio diagnostics';
  }

  if (ext === '.rs' && /\bprintln!\s*\(/.test(line)) {
    return 'println! writes to stdout; use eprintln! for MCP stdio diagnostics';
  }

  if (['.java', '.kt'].includes(ext) && /System\.out\.print/.test(line)) {
    return 'System.out writes to stdout; use stderr for MCP stdio diagnostics';
  }

  return '';
}

function listSourceFiles(root) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache']);
  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|kt)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  return files.sort();
}

function formatTextResult(result) {
  if (Array.isArray(result.runs)) {
    return formatRepeatedTextResult(result);
  }

  const status = result.ok ? 'PASS' : 'FAIL';
  const invalidFrames = result.issues.filter((issue) => issue.code.startsWith('stdout-')).length;
  const stderrLines = result.stderr ? result.stderr.trim().split(/\r?\n/).filter(Boolean).length : 0;
  const lines = [
    `${status} MCP stdio guard`,
    `initialize: ${result.initialized ? 'ok' : 'failed'}`,
    `frames: ${result.frames.length} stdout / ${invalidFrames} invalid`,
    `stderr: ${stderrLines} lines`
  ];

  if (result.negotiatedProtocol) {
    lines.push(`protocol: ${result.negotiatedProtocol}`);
  }

  if (result.operation) {
    const state = result.operation.responded ? 'responded' : 'missing';
    lines.push(`request: ${result.operation.method} ${state}`);
  }

  if (result.staticFindings.length) {
    lines.push(`static findings: ${result.staticFindings.length}`);
    for (const finding of result.staticFindings.slice(0, 10)) {
      lines.push(`[warning] ${finding.file}:${finding.line} ${finding.message}`);
    }
  }

  for (const issue of result.issues) {
    lines.push(`[${issue.severity}] ${issue.code}: ${issue.message}`);
  }

  return lines.join('\n');
}

function formatRepeatedTextResult(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  const passedRuns = result.runs.filter((run) => run.ok).length;
  const lines = [
    `${status} MCP stdio guard`,
    `runs: ${passedRuns}/${result.runs.length} passed`
  ];

  for (const run of result.runs) {
    const runStatus = run.ok ? 'PASS' : 'FAIL';
    const invalidFrames = run.issues.filter((issue) => issue.code.startsWith('stdout-')).length;
    const stderrLines = run.stderr ? run.stderr.trim().split(/\r?\n/).filter(Boolean).length : 0;
    lines.push(`run ${run.run}: ${runStatus}, initialize ${run.initialized ? 'ok' : 'failed'}, frames ${run.frames.length} stdout / ${invalidFrames} invalid, stderr ${stderrLines} lines`);
  }

  if (result.staticFindings.length) {
    lines.push(`static findings: ${result.staticFindings.length}`);
    for (const finding of result.staticFindings.slice(0, 10)) {
      lines.push(`[warning] ${finding.file}:${finding.line} ${finding.message}`);
    }
  }

  for (const issue of result.issues) {
    const prefix = issue.run ? `run ${issue.run} ` : '';
    lines.push(`[${issue.severity}] ${prefix}${issue.code}: ${issue.message}`);
  }

  return lines.join('\n');
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseJsonOption(rawValue, option) {
  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${option} must be valid JSON: ${error.message}`);
  }
}

function quote(value) {
  const singleLine = String(value).replace(/\s+/g, ' ').trim();
  return JSON.stringify(singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine);
}

function helpText() {
  return `mcp-stdio-guard validates MCP stdio servers.

MCP stdio output is expected as newline-delimited JSON-RPC on stdout.

Usage:
  mcp-stdio-guard [options] -- <command> [args...]

Options:
  --protocol <version>   MCP protocol version, default ${DEFAULT_PROTOCOL}
  --timeout <ms>         initialize and request timeout, default ${DEFAULT_TIMEOUT}
  --repeat <count>       run the guard multiple times, default 1
  --scan <path>          scan source for risky stdout writes
  --fail-on-static       fail when --scan finds risky stdout writes
  --request <method>     send one MCP request after initialize, e.g. tools/list
  --params <json>        JSON params for --request
  --json                 print JSON output
  --cwd <path>           run command from this directory
  --version, -v          print version
  --help, -h             show help

Examples:
  mcp-stdio-guard -- node ./server.js
  mcp-stdio-guard --request tools/list -- node ./server.js
  mcp-stdio-guard --scan src --fail-on-static --request tools/list -- node ./server.js
`;
}
