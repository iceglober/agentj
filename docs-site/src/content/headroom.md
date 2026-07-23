# Headroom

Context compression for LLM sessions. Compresses tool outputs — bash results, file reads, grep matches — before they enter the context window. 60-95% fewer tokens, same answers.

Powered by [headroom-ai](https://github.com/chopratejas/headroom). Runs entirely local — no data leaves your machine. Works with any provider (Bedrock, Anthropic, OpenAI).

## Install

```bash
glrs headroom init
```

Installs headroom-ai, starts the compression service, persists across reboots.

## How it works

```
Tool produces output (10,000 tokens)
    ↓
Harness tool-hooks sub-plugin
    ↓ POST localhost:8787/v1/compress
Headroom compresses (SmartCrusher / CodeCompressor / Kompress)
    ↓
Compressed output (2,000 tokens) enters conversation
    ↓
OpenCode sends to your provider normally
```

The harness automatically compresses large tool outputs through headroom's local compression service. LLM traffic never touches headroom — only tool outputs do. If headroom isn't running, the harness falls back to its built-in truncation.

## What gets compressed

- Bash output above the backpressure threshold
- Large file reads
- Grep/glob results
- Any tool output the harness would normally truncate

## What doesn't change

- Your provider, API keys, and model selection are untouched
- Small outputs pass through uncompressed
- Error outputs are never compressed (failures need full context)
- Read deduplication and post-edit verification still run before compression

## Commands

| Command | What it does |
|---|---|
| `glrs headroom init` | Install headroom-ai, start service, persist via launchd |
| `glrs headroom start` | Start the compression service |
| `glrs headroom stop` | Stop the service |
| `glrs headroom status` | Service health, compression stats |

## Disabling

```bash
glrs headroom stop
```

The harness falls back to built-in truncation (head + tail) when headroom isn't running.
