# Pure Agent CLI

An interactive terminal AI agent powered by DeepSeek.

## Requirements

- Node.js 20 or newer
- A DeepSeek API key

## Install

```bash
npm install -g @pure-agent/cli
```

## Configure and chat

```bash
pure-agent
```

At the prompt, run `/config set api-key`, paste the key into the hidden input,
and press Enter.

## Session commands

- `/model` selects `deepseek-v4-pro` or `deepseek-v4-flash`.
- `/effort` selects `off`, `low`, `medium`, or `high`.
- `/new` clears the current conversation.
- `/help` lists available commands.

## Uninstall

```bash
npm uninstall -g @pure-agent/cli
```

## License

MIT. See [LICENSE](./LICENSE).
