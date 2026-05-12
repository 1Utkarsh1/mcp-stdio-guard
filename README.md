# mcp-stdio-guard

`mcp-stdio-guard` catches the easiest way to break a Model Context Protocol server: writing anything except JSON-RPC messages to stdout.

MCP stdio servers use stdout as their protocol channel. Debug text, banners, progress logs, `console.log`, Python `print`, or any other stray stdout output can corrupt the stream and make clients fail in confusing ways. This CLI starts your server, performs a real MCP initialize handshake, validates every stdout frame, and optionally scans source for risky stdout calls.

## Why this exists

MCP is becoming normal developer infrastructure, but the local stdio path is fragile: logs must go to stderr, and stdout must stay machine-readable. The latest MCP docs say [stdio servers must send JSON-RPC messages on stdout](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), may log to stderr, and must complete the [`initialize` then `notifications/initialized` lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) before normal operation.

This tiny guard is meant for MCP server authors who want a fast local check and a CI gate before publishing.

## Install

From this repo:

```bash
git clone https://github.com/1Utkarsh1/mcp-stdio-guard.git
cd mcp-stdio-guard
npm test
```

After npm publish:

```bash
npx mcp-stdio-guard -- node ./server.js
```

## Quickstart

Run your MCP server behind the guard:

```bash
node ./bin/mcp-stdio-guard.js -- node ./server.js
```

Use a custom timeout and protocol version:

```bash
node ./bin/mcp-stdio-guard.js --timeout 8000 --protocol 2025-11-25 -- node ./server.js
```

Scan source for obvious stdout writes too:

```bash
node ./bin/mcp-stdio-guard.js --scan src -- node ./server.js
```

JSON output for CI:

```bash
node ./bin/mcp-stdio-guard.js --json -- node ./server.js
```

## What it checks

- starts the command you provide after `--`
- sends an MCP `initialize` request
- validates stdout as newline-delimited JSON-RPC
- fails on non-JSON stdout pollution
- detects crashes and initialize timeouts
- keeps stderr as allowed diagnostic output
- optionally scans source for `console.log`, `print`, `fmt.Println`, `println!`, and `System.out`

## Output

Passing server:

```text
PASS MCP stdio guard
initialize: ok
frames: 1 stdout / 0 invalid
stderr: 0 lines
```

Polluted stdout:

```text
FAIL MCP stdio guard
[error] stdout-non-json: stdout line 1 is not JSON-RPC: "server starting..."
```

## Commands

```bash
mcp-stdio-guard [options] -- <command> [args...]
```

| Option | Description |
| --- | --- |
| `--protocol <version>` | MCP protocol version to send, default `2025-11-25` |
| `--timeout <ms>` | initialize timeout, default `5000` |
| `--scan <path>` | statically scan a source directory for risky stdout writes |
| `--fail-on-static` | make static scan findings fail the command |
| `--json` | print machine-readable output |
| `--help` | Show help |

## CI example

```yaml
- run: npx mcp-stdio-guard --scan src --fail-on-static -- node ./server.js
```

## Notes

Static scanning is intentionally simple and conservative. The runtime guard is the source of truth because it tests the real process boundary your MCP client will use.

## License

MIT
