import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ISSUE_CLASSES,
  classifyIssueCode,
  detectPythonBufferingIssue,
  guardRepeatedStdioServer,
  guardStdioServer,
  parseArgs,
  scanSource,
  validateJsonRpc
} from '../src/index.js';

test('accepts a clean MCP initialize response', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'clean-server', version: '1.0.0' }
          }
        }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, true);
  assert.equal(result.initialized, true);
  assert.equal(result.frames.length, 1);
});

test('adds a reproducibility fingerprint without env or arg secret values', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-fingerprint-'));
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: { name: 'fingerprint-server', version: '1.0.0' }
          }
        }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([
    process.execPath,
    server,
    '--api-token',
    'do-not-leak'
  ], {
    timeoutMs: 1000,
    cwd,
    env: {
      API_TOKEN: 'super-secret-token',
      MCP_STDIO_GUARD_MODE: 'registry'
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.fingerprint.guard.name, 'mcp-stdio-guard');
  assert.equal(result.fingerprint.cwd.resolved, cwd);
  assert.equal(result.fingerprint.timeoutMs, 1000);
  assert.equal(result.fingerprint.runtimes.node.role, 'guard-and-target');
  assert.deepEqual(result.fingerprint.env.names, ['API_TOKEN', 'MCP_STDIO_GUARD_MODE']);
  assert.equal(result.fingerprint.env.values.API_TOKEN, '<redacted>');
  assert.equal(result.fingerprint.env.values.MCP_STDIO_GUARD_MODE, '<redacted>');
  assert.deepEqual(result.fingerprint.command.args.slice(-2), ['--api-token', '<redacted>']);
  assert.equal(typeof result.fingerprint.timings.startupMs, 'number');
  assert.equal(typeof result.fingerprint.timings.totalMs, 'number');
  assert.ok(!JSON.stringify(result.fingerprint).includes('super-secret-token'));
  assert.ok(!JSON.stringify(result.fingerprint).includes('do-not-leak'));
  assert.ok(!JSON.stringify(result.fingerprint).includes('registry'));
});

test('fails when stdout contains non-json diagnostics', async () => {
  const server = makeServer(`
    console.log('server starting...');
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-non-json'));
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-non-json' && issue.class === ISSUE_CLASSES.STDIO_TRANSPORT));
  assert.equal(result.issueClasses.stdioTransport.status, 'fail');
  assert.deepEqual(result.issueClasses.stdioTransport.issueCodes, ['stdout-non-json']);
  assert.equal(result.issueClasses.installRuntime.status, 'pass');
  assert.equal(result.issueClasses.mcpProtocol.status, 'pass');
});

test('reports content-length framing clearly', async () => {
  const server = makeServer(`
    process.stdout.write('Content-Length: 80\\r\\n\\r\\n');
    process.stdin.resume();
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 150 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-content-length-framing'));
  assert.equal(result.checks.initialize.status, 'fail');
  assert.deepEqual(result.checks.initialize.issueCodes, ['stdout-content-length-framing']);
  assert.ok(!result.issues.some((issue) => issue.code === 'initialize-timeout'));
  assert.ok(!result.issues.some((issue) => issue.code === 'stdout-empty-line'));
});

test('allows stderr diagnostics', async () => {
  const server = makeServer(`
    console.error('server starting...');
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, true);
  assert.match(result.stderr, /server starting/);
});

test('warns when Python commands may use buffered stdio', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-python-'));
  const pythonBin = path.join(root, 'python');
  fs.symlinkSync(process.execPath, pythonBin);

  const result = await guardStdioServer([pythonBin, server], {
    timeoutMs: 1000,
    env: { ...process.env, PYTHONUNBUFFERED: '' }
  });

  assert.equal(result.ok, true);
  assert.ok(result.issues.some((issue) => issue.code === 'python-buffered-stdio'));
});

test('merges env overrides with the parent environment', async () => {
  const server = makeServer(`
    if (!process.env.PATH || process.env.MCP_STDIO_GUARD_ENV_TEST !== 'present') {
      process.exit(13);
    }

    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 1000,
    env: { MCP_STDIO_GUARD_ENV_TEST: 'present' }
  });

  assert.equal(result.ok, true);
});

test('detects Python unbuffered settings', () => {
  assert.match(detectPythonBufferingIssue(['python', 'server.py'], {}), /buffered/);
  assert.equal(detectPythonBufferingIssue(['python', '-u', 'server.py'], {}), '');
  assert.equal(detectPythonBufferingIssue(['python', 'server.py'], { PYTHONUNBUFFERED: '1' }), '');
  assert.equal(detectPythonBufferingIssue(['python', 'server.py'], { PYTHONUNBUFFERED: '0' }), '');
  assert.equal(detectPythonBufferingIssue(['node', 'server.js'], {}), '');
});

test('can repeat runs and identify the failing run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-repeat-'));
  const marker = path.join(root, 'warm-cache');
  const server = makeServer(`
    import fs from 'node:fs';
    const marker = process.argv[2];
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'warm');
      console.log('building cache on first run');
    }

    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);

  const result = await guardRepeatedStdioServer([process.execPath, server, marker], {
    repeat: 2,
    timeoutMs: 1000
  });

  assert.equal(result.ok, false);
  assert.equal(result.repeat, 2);
  assert.equal(result.runs.length, 2);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.fingerprint.repeat, 2);
  assert.equal(result.fingerprint.runs.length, 2);
  assert.equal(result.checks.repeat.status, 'fail');
  assert.deepEqual(result.checks.repeat.failedRuns, [1]);
  assert.equal(result.runs[0].schemaVersion, 1);
  assert.equal(result.runs[0].ok, false);
  assert.equal(result.runs[1].ok, true);
  assert.ok(result.issues.some((issue) => issue.run === 1 && issue.code === 'stdout-non-json'));
  assert.ok(result.issues.some((issue) => issue.run === 1 && issue.code === 'stdout-non-json' && issue.class === ISSUE_CLASSES.STDIO_TRANSPORT));
  assert.equal(result.issueClasses.stdioTransport.status, 'fail');
  assert.deepEqual(result.issueClasses.stdioTransport.issueCodes, ['stdout-non-json']);
});

test('reports initialize timeout', async () => {
  const server = makeServer('setInterval(() => {}, 1000);');

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 150 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'initialize-timeout'));
});

test('can send a post-initialize MCP request', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } }) + '\\n');
        }
        if (message.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\\n');
        }
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 1000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation.responded, true);
  assert.equal(result.frames.length, 2);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.checks.initialize.status, 'pass');
  assert.equal(result.checks.stdout.status, 'pass');
  assert.equal(result.checks.jsonRpc.status, 'pass');
  assert.equal(result.checks.operation.status, 'pass');
  assert.equal(result.checks.staticScan.status, 'skipped');
});

test('prints the package version from the cli', async () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const { output, exitCode } = await captureCliOutput(['--version']);

  assert.equal(exitCode, 0);
  assert.equal(output, packageJson.version);
});

test('operation check reports stdout framing errors after initialize', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } }) + '\\n');
        }
        if (message.method === 'tools/list') {
          process.stdout.write('Content-Length: 80\\r\\n\\r\\n');
        }
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 1000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.initialized, true);
  assert.equal(result.operation.responded, false);
  assert.equal(result.checks.operation.status, 'fail');
  assert.deepEqual(result.checks.operation.issueCodes, ['stdout-content-length-framing']);
});

test('json cli output exposes stable schema and static scan metadata', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);
  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-json-contract-'));
  fs.writeFileSync(path.join(scanRoot, 'server.js'), 'console.log("debug");\n');

  const { output, exitCode } = await captureCliOutput([
    '--json',
    '--scan',
    scanRoot,
    '--fail-on-static',
    '--',
    process.execPath,
    server
  ]);
  const result = JSON.parse(output);

  assert.equal(exitCode, 1);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].class, ISSUE_CLASSES.STDIO_TRANSPORT);
  assert.equal(result.staticScan.enabled, true);
  assert.equal(result.staticScan.path, scanRoot);
  assert.equal(result.staticScan.failOnFindings, true);
  assert.equal(result.fingerprint.staticScan.enabled, true);
  assert.equal(result.fingerprint.staticScan.path, scanRoot);
  assert.equal(result.fingerprint.guard.name, 'mcp-stdio-guard');
  assert.equal(result.fingerprint.command.argv[0], process.execPath);
  assert.equal(result.fingerprint.system.platform, process.platform);
  assert.equal(result.checks.staticScan.status, 'fail');
  assert.deepEqual(result.checks.staticScan.issueCodes, ['static-stdout-write']);
  assert.equal(result.issueClasses.stdioTransport.status, 'fail');
  assert.deepEqual(result.issueClasses.stdioTransport.issueCodes, ['static-stdout-write']);
  assert.equal(result.checks.initialize.status, 'pass');
});

test('reports initialize response id type mismatch', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: String(request.id), result: { protocolVersion: request.params.protocolVersion, capabilities: {} } }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'response-id-type-mismatch'));
  assert.ok(result.issues.some((issue) => issue.code === 'response-id-type-mismatch' && issue.class === ISSUE_CLASSES.MCP_PROTOCOL));
  assert.equal(result.checks.initialize.status, 'fail');
  assert.deepEqual(result.checks.initialize.issueCodes, ['response-id-type-mismatch']);
  assert.equal(result.issueClasses.mcpProtocol.status, 'fail');
  assert.deepEqual(result.issueClasses.mcpProtocol.issueCodes, ['response-id-type-mismatch']);
});

test('classifies install/runtime exits separately from protocol failures', async () => {
  const server = makeServer('process.exit(2);');
  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 150 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'server-exited' && issue.class === ISSUE_CLASSES.INSTALL_RUNTIME));
  assert.equal(result.issueClasses.installRuntime.status, 'fail');
  assert.deepEqual(result.issueClasses.installRuntime.issueCodes, ['server-exited']);
  assert.equal(result.issueClasses.stdioTransport.status, 'pass');
  assert.equal(result.issueClasses.mcpProtocol.status, 'pass');
});

test('keeps a stable issue-code to issue-class mapping', () => {
  assert.equal(classifyIssueCode('spawn-failed'), ISSUE_CLASSES.INSTALL_RUNTIME);
  assert.equal(classifyIssueCode('server-exited'), ISSUE_CLASSES.INSTALL_RUNTIME);
  assert.equal(classifyIssueCode('initialize-timeout'), ISSUE_CLASSES.INSTALL_RUNTIME);
  assert.equal(classifyIssueCode('operation-timeout'), ISSUE_CLASSES.INSTALL_RUNTIME);
  assert.equal(classifyIssueCode('python-buffered-stdio'), ISSUE_CLASSES.INSTALL_RUNTIME);

  assert.equal(classifyIssueCode('stdout-non-json'), ISSUE_CLASSES.STDIO_TRANSPORT);
  assert.equal(classifyIssueCode('stdout-content-length-framing'), ISSUE_CLASSES.STDIO_TRANSPORT);
  assert.equal(classifyIssueCode('stdout-without-newline'), ISSUE_CLASSES.STDIO_TRANSPORT);
  assert.equal(classifyIssueCode('static-stdout-write'), ISSUE_CLASSES.STDIO_TRANSPORT);

  assert.equal(classifyIssueCode('stdout-invalid-json-rpc'), ISSUE_CLASSES.MCP_PROTOCOL);
  assert.equal(classifyIssueCode('stdout-unexpected-request-id'), ISSUE_CLASSES.MCP_PROTOCOL);
  assert.equal(classifyIssueCode('response-id-type-mismatch'), ISSUE_CLASSES.MCP_PROTOCOL);
  assert.equal(classifyIssueCode('initialize-error'), ISSUE_CLASSES.MCP_PROTOCOL);
  assert.equal(classifyIssueCode('operation-error'), ISSUE_CLASSES.MCP_PROTOCOL);
});

test('rejects request frames that reuse the initialize response id', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const request of messages) {
        if (request.method !== 'initialize') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, method: 'server/ping', params: {} }) + '\\n');
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, false);
  assert.equal(result.initialized, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-unexpected-request-id'));
});

test('reports operation response id type mismatch', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } }) + '\\n');
        }
        if (message.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: String(message.id), result: { tools: [] } }) + '\\n');
        }
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 1000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'response-id-type-mismatch'));
  assert.equal(result.checks.operation.status, 'fail');
  assert.deepEqual(result.checks.operation.issueCodes, ['response-id-type-mismatch']);
});

test('rejects request frames that reuse the operation response id', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } }) + '\\n');
        }
        if (message.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'server/ping', params: {} }) + '\\n');
        }
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 1000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.operation.responded, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-unexpected-request-id'));
});

test('reports operation timeout after initialize', async () => {
  const server = makeServer(`
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {} } }) + '\\n');
        }
      }
    });
    setInterval(() => {}, 1000);
  `);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 150,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'operation-timeout'));
});

test('fails when server crashes after initialized notification', async () => {
  const server = makeServer(`
    let seenInitialize = false;
    process.stdin.on('data', (chunk) => {
      const messages = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
      for (const message of messages) {
        if (message.method === 'initialize') {
          seenInitialize = true;
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {} } }) + '\\n');
        } else if (seenInitialize && message.method === 'notifications/initialized') {
          throw new Error('boom after initialized');
        }
      }
    });
  `);

  const result = await guardStdioServer([process.execPath, server], { timeoutMs: 1000 });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'server-crashed'));
});

test('static scan catches risky stdout calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-guard-'));
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log("debug");\nconsole.error("ok");\n');
  fs.writeFileSync(path.join(root, 'server.py'), 'print("debug")\nprint("ok", file=sys.stderr)\n');

  const findings = scanSource(root);

  assert.equal(findings.length, 2);
  assert.ok(findings.some((finding) => finding.file.endsWith('server.js')));
  assert.ok(findings.some((finding) => finding.file.endsWith('server.py')));
});

test('parses command after separator', () => {
  const options = parseArgs([
    '--timeout',
    '9000',
    '--repeat',
    '2',
    '--scan',
    'src',
    '--fail-on-static',
    '--request',
    'tools/call',
    '--params',
    '{"name":"echo","arguments":{}}',
    '--',
    'node',
    'server.js'
  ]);

  assert.equal(options.timeoutMs, 9000);
  assert.equal(options.repeat, 2);
  assert.equal(options.failOnStatic, true);
  assert.equal(options.requestMethod, 'tools/call');
  assert.deepEqual(options.requestParams, { name: 'echo', arguments: {} });
  assert.deepEqual(options.command, ['node', 'server.js']);
});

test('rejects params without request', () => {
  assert.throws(() => parseArgs(['--params', '{}', '--', 'node', 'server.js']), /--params/);
});

test('validates json-rpc frames', () => {
  assert.equal(validateJsonRpc({ jsonrpc: '2.0', id: 1, result: {} }), '');
  assert.equal(validateJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), '');
  assert.equal(validateJsonRpc({ jsonrpc: '2.0', id: 1, method: 'server/ping' }), '');
  assert.match(validateJsonRpc({ id: 1, result: {} }), /jsonrpc/);
  assert.match(validateJsonRpc({ jsonrpc: '2.0', id: 1, method: 'server/ping', result: {} }), /must not include/);
  assert.match(validateJsonRpc({ jsonrpc: '2.0' }), /method/);
});

function makeServer(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-server-'));
  const file = path.join(root, 'server.mjs');
  fs.writeFileSync(file, source);
  return file;
}

async function captureCliOutput(argv) {
  const cliPath = path.resolve('bin/mcp-stdio-guard.js');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        output: output.trim(),
        stderr: stderr.trim(),
        exitCode: code
      });
    });
  });
}
