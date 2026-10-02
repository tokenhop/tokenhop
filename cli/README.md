# tokenhop - FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![npm](https://img.shields.io/npm/v/tokenhop.svg)](https://www.npmjs.com/package/tokenhop)
[![Downloads](https://img.shields.io/npm/dm/tokenhop.svg)](https://www.npmjs.com/package/tokenhop)
[![GHCR](https://img.shields.io/badge/GHCR-tokenhop%2Ftokenhop-blue?logo=github)](https://github.com/tokenhop/tokenhop/pkgs/container/tokenhop)
[![License](https://img.shields.io/npm/l/tokenhop.svg)](https://github.com/tokenhop/tokenhop/blob/master/LICENSE)

[🌐 Website](https://tokenhop.ai) • [📖 Docs](https://tokenhop.dev) • [💻 GitHub](https://github.com/tokenhop/tokenhop)

---

## 🤔 Why tokenhop?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**tokenhop solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — npm (recommended for desktop):**

```bash
npm install -g tokenhop
tokenhop

# Or run directly with npx
npx tokenhop
```

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name tokenhop -p 20128:20128 \
  -v "$HOME/.tokenhop:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/tokenhop/tokenhop:latest
```

Published images: [GHCR](https://github.com/tokenhop/tokenhop/pkgs/container/tokenhop) (multi-platform amd64/arm64).

Both the npm package and the Docker image ship with Google OAuth clients built in, so
Gemini/Gemini CLI/Antigravity login works with no setup.

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
tokenhop                   # Start with default settings
tokenhop --port 8080       # Custom port
tokenhop --no-browser      # Don't open browser
tokenhop --help            # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.tokenhop/db/data.sqlite`
- **Windows**: `%APPDATA%/tokenhop/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.tokenhop` to persist)

Upgrading from 9router? An existing `~/.9router` is used automatically until you run
`tokenhop data migrate`. See the [upgrade guide](https://github.com/tokenhop/tokenhop/blob/master/UPGRADING.md).

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: <https://github.com/tokenhop/tokenhop>
- **Full README**: <https://github.com/tokenhop/tokenhop/blob/master/README.md>
- **Docs**: <https://tokenhop.dev>
- **Website**: <https://tokenhop.ai>

---

## 🙏 Acknowledgments

- **[9Router](https://github.com/decolua/9router)** by decolua - the project tokenhop started as a fork of (MIT)
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
