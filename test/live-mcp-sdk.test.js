import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { guardStdioServer } from '../src/index.js';

test('passes a real MCP SDK stdio server through initialize and tools/list', async (t) => {
  const server = makeSdkServer(t);

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 2000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.initialized, true);
  assert.equal(result.operation.responded, true);
  assert.ok(result.frames.some((frame) => frame.id === 2 && Array.isArray(frame.result?.tools)));
});

test('fails a real MCP SDK server with startup stdout pollution', async (t) => {
  const server = makeSdkServer(t, { beforeConnect: 'console.log("debug banner before connect");' });

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 2000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-non-json'));
});

test('allows real MCP SDK server diagnostics on stderr', async (t) => {
  const server = makeSdkServer(t, { beforeConnect: 'console.error("debug banner before connect");' });

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 2000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, true);
  assert.match(result.stderr, /debug banner before connect/);
});

test('catches real MCP SDK late stdout pollution during operation window', async (t) => {
  const server = makeSdkServer(t, {
    afterConnect: 'setTimeout(() => console.log("late stdout pollution"), 10);'
  });

  const result = await guardStdioServer([process.execPath, server], {
    timeoutMs: 2000,
    operation: { method: 'tools/list' }
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'stdout-non-json'));
});

function makeSdkServer(t, options = {}) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-mcp-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'server.mjs');
  const source = `
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

    const server = new McpServer({ name: 'live-sdk-server', version: '1.0.0' });
    server.registerTool('echo', {
      title: 'Echo',
      description: 'Return a fixed response'
    }, async () => ({
      content: [{ type: 'text', text: 'ok' }]
    }));

    ${options.beforeConnect || ''}
    await server.connect(new StdioServerTransport());
    ${options.afterConnect || ''}
  `;

  fs.writeFileSync(file, source);
  return file;
}
