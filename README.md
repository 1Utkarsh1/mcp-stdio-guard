<p align="center">
  <img src="assets/logo.svg" alt="mcp-stdio-guard logo" width="120" />
</p>

<h1 align="center">mcp-stdio-guard</h1>

<p align="center">
  Catch stdout pollution and handshake failures in MCP stdio servers before clients do.
</p>

<p align="center">
  <a href="https://github.com/1Utkarsh1/mcp-stdio-guard/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/1Utkarsh1/mcp-stdio-guard/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/mcp-stdio-guard"><img alt="npm" src="https://img.shields.io/npm/v/mcp-stdio-guard?color=0b6bcb" /></a>
  <a href="https://badge.socket.dev/npm/package/mcp-stdio-guard/0.2.0"><img alt="Socket" src="https://badge.socket.dev/npm/package/mcp-stdio-guard/0.2.0" /></a>
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-1f8f4c" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-2f855a" />
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-111827" /></a>
</p>

<p align="center">
  <img src="assets/hero.svg" alt="mcp-stdio-guard hero showing a clean MCP stdio pipeline" width="100%" />
</p>

MCP stdio servers use stdout as their protocol channel. Debug text, banners, progress logs, `console.log`, Python `print`, or any other stray stdout output can corrupt the stream and make clients fail in confusing ways.

`mcp-stdio-guard` starts your server, performs a real MCP initialize handshake, optionally sends a real post-initialize MCP request such as `tools/list`, validates every stdout frame, and scans source for risky stdout calls.

## Why This Exists

The latest MCP docs say [stdio servers must send JSON-RPC messages on stdout](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), may log to stderr, and must complete the [`initialize` then `notifications/initialized` lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) before normal operation.

That is easy to get wrong in real servers. This guard turns that fragile process boundary into a fast local check and a CI gate.

<p align="center">
  <img src="assets/protocol-flow.svg" alt="Protocol flow tested by mcp-stdio-guard" width="100%" />
</p>

## Install

From npm:

```bash
npx mcp-stdio-guard -- node ./server.js
```

From this repo:

```bash
git clone https://github.com/1Utkarsh1/mcp-stdio-guard.git
cd mcp-stdio-guard
npm ci
npm test
```

## Quickstart

Run your MCP server behind the guard:

```bash
mcp-stdio-guard -- node ./server.js
```

Exercise a real MCP operation after initialization:

```bash
mcp-stdio-guard --request tools/list -- node ./server.js
```

Scan source for obvious stdout writes too:

```bash
mcp-stdio-guard --scan src --fail-on-static --request tools/list -- node ./server.js
```

JSON output for CI:

```bash
mcp-stdio-guard --json --request tools/list -- node ./server.js
```

Repeat the same guard to catch cold/warm startup behavior:

```bash
mcp-stdio-guard --repeat 2 --request tools/list -- node ./server.js
```

## What It Catches

<p align="center">
  <img src="assets/terminal-demo.svg" alt="Passing and failing terminal output examples" width="100%" />
</p>

| Problem | Runtime check | Static scan |
| --- | --- | --- |
| `console.log("starting")` before server startup | Yes | Yes |
| Dependency/import-time stdout pollution | Yes with `--repeat` | No |
| Python `print("debug")` in a stdio server | Yes | Yes |
| Late stdout logs after `initialize` | Yes | Partial |
| Invalid JSON-RPC frames | Yes | No |
| Server crash after `notifications/initialized` | Yes | No |
| Missing `initialize` or operation response | Yes | No |
| stderr diagnostics | Allowed | Allowed |

## Live MCP Coverage

The test suite creates real servers with `@modelcontextprotocol/sdk@1.29.0` and verifies:

| Scenario | Expected result |
| --- | --- |
| clean SDK stdio server through `initialize` and `tools/list` | Pass |
| SDK server with startup stdout pollution | Fail |
| SDK server with stderr diagnostics | Pass |
| SDK server with late stdout pollution after connection | Fail |
| hand-rolled server that ignores post-initialize requests | Fail |
| server that crashes after initialized notification | Fail |

## Commands

```bash
mcp-stdio-guard [options] -- <command> [args...]
```

| Option | Description |
| --- | --- |
| `--protocol <version>` | MCP protocol version to send, default `2025-11-25` |
| `--timeout <ms>` | initialize and request timeout, default `5000` |
| `--repeat <count>` | run the same guard multiple times to catch cold/warm startup behavior |
| `--request <method>` | send one MCP request after initialization, for example `tools/list` |
| `--params <json>` | JSON params for `--request` |
| `--scan <path>` | scan source for risky stdout writes |
| `--fail-on-static` | make static scan findings fail the command |
| `--json` | print machine-readable output |
| `--cwd <path>` | run the server command from a specific directory |
| `--help` | show help |

## JSON Contract

`--json` is intended for CI, registries, and badge ingestion. The current contract is `schemaVersion: 1`; new fields may be added, but these fields are stable for consumers:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | JSON contract version, currently `1` |
| `ok` | `true` when no error-severity issue was found |
| `command` | command and arguments that were validated |
| `protocol` | MCP protocol version sent by the guard |
| `negotiatedProtocol` | protocol version returned by the server, when available |
| `initialized` | whether the server completed the initialize handshake |
| `operation` | post-initialize request result, or `null` when `--request` was not used |
| `process` | startup, timeout, exit code, signal, and guard-termination metadata for a single run; repeat mode exposes this inside each `runs` entry |
| `checks` | badge-friendly per-class statuses |
| `issueClasses` | registry-friendly summary grouped by `installRuntime`, `stdioTransport`, and `mcpProtocol` |
| `fingerprint` | redacted reproducibility metadata for debugging registry and CI runs |
| `issues` | machine-readable diagnostics with `class`, `severity`, `code`, and `message`; repeat mode also adds `run` |
| `staticScan` | whether source scanning was enabled and whether findings fail the command |
| `staticFindings` | source scan findings with file, line, and message |
| `runs` | per-run results when `--repeat` is used |

Check statuses are `pass`, `fail`, `warning`, or `skipped`. The `checks` object separates the signal into `initialize`, `stdout`, `jsonRpc`, `operation`, `process`, `pythonBuffering`, `staticScan`, and `repeat`, each with stable `status` and `issueCodes` fields. When `--repeat` is used, `checks.repeat` also includes `runs`, `passedRuns`, and `failedRuns`; each entry in `runs` is a normal schema-versioned result for that individual guard run.

`issueClasses` is additive to `checks`. It groups issue codes by the kind of problem a registry or client should display:

| Issue class | Meaning | Display guidance |
| --- | --- | --- |
| `installRuntime` | the command could not start, timed out, exited, crashed, or hit a runtime advisory | show as "needs inspection" or "runtime/install issue"; do not present it as an MCP protocol violation |
| `stdioTransport` | stdout was not a clean newline-delimited JSON-RPC channel, or source scan found risky stdout writes | show as stdio hygiene failure; ask maintainers to keep diagnostics on stderr |
| `mcpProtocol` | the server emitted invalid JSON-RPC/MCP responses, mismatched request ids, or returned initialize/operation errors | show as MCP/JSON-RPC conformance issue |

Current issue-code mapping:

| Issue class | Issue codes |
| --- | --- |
| `installRuntime` | `initialize-timeout`, `operation-missing-response`, `operation-timeout`, `python-buffered-stdio`, `server-crashed`, `server-exited`, `spawn-failed` |
| `stdioTransport` | `static-stdout-write`, `stdout-content-length-framing`, `stdout-empty-line`, `stdout-non-json`, `stdout-without-newline` |
| `mcpProtocol` | `initialize-error`, `operation-error`, `response-id-type-mismatch`, `stdout-invalid-json-rpc`, `stdout-unexpected-request-id` |

Runtime issue codes remain backward-compatible. For finer registry display, runtime issues may also include a stable `detailCode`:

| Existing issue code | Detail codes |
| --- | --- |
| `spawn-failed` | `spawn-failed-before-startup` |
| `server-exited` | `clean-exit-before-initialize`, `nonzero-exit-before-initialize`, `signal-exit-before-initialize` |
| `initialize-timeout` | `startup-timeout` |
| `operation-timeout` | `request-timeout` |
| `operation-missing-response` | `clean-exit-during-operation`, `nonzero-exit-during-operation`, `signal-exit-during-operation` |
| `server-crashed` | `nonzero-exit-after-initialize`, `signal-exit-after-initialize` |

`process` records the observed lifecycle even when the run passes. `outcome` is one of `starting`, `running`, `exited`, `timeout`, `spawn-failed`, or `guard-terminated`; `starting` is the transient initial value while the child is being created, not an expected terminal outcome. `phase` is `startup`, `initialize`, `operation`, or `post-initialize`. `exitCode` and `signal` are included when the process exits before the guard finishes; timeout runs include `timedOut`, `timeoutCode`, `timeoutMs`, and guard kill metadata. `spawnError` is either `null` or an object with `code` and `message`; the matching `spawn-failed` issue also exposes `spawnErrorCode`.

`fingerprint` helps explain why a result reproduced in one runner but not another. It includes the guard version, redacted command argv, cwd details, protocol, timeout, repeat count, requested operation, platform/arch, relevant runtime versions, package metadata when detectable, static-scan context, and startup/total duration. Environment variable values are always emitted as `<redacted>` and only explicitly provided env names are listed.

Registry display flow:

| Step | Use |
| --- | --- |
| 1 | Show `issueClasses` first so install/runtime, stdio transport, and MCP protocol failures stay distinct |
| 2 | Use `fingerprint.command`, `fingerprint.cwd`, and `fingerprint.package` to show what was actually run |
| 3 | Compare `fingerprint.system`, `fingerprint.runtimes`, and `fingerprint.timings` before marking a package broken |
| 4 | Show `fingerprint.env.names` only when debugging; never ask users to paste secret values |

Example:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "fingerprint": {
    "guard": { "name": "mcp-stdio-guard", "version": "0.2.0" },
    "command": {
      "executable": "node",
      "args": ["./server.js"],
      "argv": ["node", "./server.js"]
    },
    "cwd": {
      "requested": "/repo/server",
      "resolved": "/repo/server",
      "exists": true
    },
    "protocol": "2025-11-25",
    "timeoutMs": 5000,
    "repeat": 1,
    "operation": { "method": "tools/list", "hasParams": false },
    "system": { "platform": "darwin", "arch": "arm64", "osRelease": "25.0.0" },
    "runtimes": {
      "node": { "version": "v24.0.0", "role": "guard-and-target" }
    },
    "package": null,
    "env": {
      "inherited": true,
      "names": ["API_TOKEN"],
      "values": { "API_TOKEN": "<redacted>" }
    },
    "staticScan": { "enabled": false, "path": "", "failOnFindings": false },
    "timings": { "startupMs": 42, "totalMs": 96 }
  },
  "process": {
    "started": true,
    "pid": 12345,
    "outcome": "guard-terminated",
    "phase": "post-initialize",
    "exitCode": null,
    "signal": null,
    "timedOut": false,
    "timeoutCode": "",
    "timeoutMs": 5000,
    "killedByGuard": true,
    "killSignal": "SIGTERM",
    "killReason": "guard-finished",
    "spawnError": null
  },
  "issueClasses": {
    "installRuntime": { "status": "pass", "issueCodes": [] },
    "stdioTransport": { "status": "pass", "issueCodes": [] },
    "mcpProtocol": { "status": "pass", "issueCodes": [] }
  },
  "checks": {
    "initialize": { "status": "pass", "issueCodes": [] },
    "stdout": { "status": "pass", "issueCodes": [] },
    "jsonRpc": { "status": "pass", "issueCodes": [] },
    "operation": { "status": "pass", "issueCodes": [] },
    "process": { "status": "pass", "issueCodes": [] },
    "pythonBuffering": { "status": "pass", "issueCodes": [] },
    "staticScan": { "status": "skipped", "issueCodes": [] },
    "repeat": { "status": "skipped", "issueCodes": [] }
  }
}
```

The guard is registry-agnostic. It does not care whether an install command came from Smithery, Glama, GitHub, or a private catalog; it validates the command, working directory, optional source path, and observed stdio behavior.

## CI

```yaml
- run: npm ci
- run: npx mcp-stdio-guard --scan src --fail-on-static --request tools/list -- node ./server.js
```

## Output

Passing server:

```text
PASS MCP stdio guard
initialize: ok
frames: 2 stdout / 0 invalid
stderr: 0 lines
protocol: 2025-11-25
request: tools/list responded
```

Polluted stdout:

```text
FAIL MCP stdio guard
initialize: ok
frames: 2 stdout / 1 invalid
stderr: 0 lines
protocol: 2025-11-25
request: tools/list responded
[error] stdout-non-json: stdout line 1 is not JSON-RPC: "server starting..."
```

## Design

- Runtime dependencies: zero.
- Default behavior: validate the real process boundary.
- Optional static scan: intentionally simple and conservative.
- CI posture: fail on protocol corruption, crashes, and missing responses.
- Promotion promise: no fake stars, no spam, just a tool that catches a real MCP failure mode.

## License

MIT
