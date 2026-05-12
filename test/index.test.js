import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guardStdioServer, parseArgs, scanSource, validateJsonRpc } from '../src/index.js';

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
  assert.match(validateJsonRpc({ id: 1, result: {} }), /jsonrpc/);
  assert.match(validateJsonRpc({ jsonrpc: '2.0' }), /method/);
});

function makeServer(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-server-'));
  const file = path.join(root, 'server.mjs');
  fs.writeFileSync(file, source);
  return file;
}
