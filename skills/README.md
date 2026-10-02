# tokenhop — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use tokenhop for you.

> Tip: start with the **tokenhop** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability                          | Copy link below and paste to your AI                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Entry / Setup** (start here)      | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop/SKILL.md>            |
| Chat / code-gen                     | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-chat/SKILL.md>       |
| Image generation                    | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-image/SKILL.md>      |
| Video generation (xAI Grok Imagine) | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-video/SKILL.md>      |
| Text-to-speech                      | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-tts/SKILL.md>        |
| Speech-to-text                      | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-stt/SKILL.md>        |
| Embeddings                          | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-embeddings/SKILL.md> |
| Web search                          | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-web-search/SKILL.md> |
| Web fetch (URL → markdown)          | <https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop-web-fetch/SKILL.md>  |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/tokenhop/tokenhop/refs/heads/master/skills/tokenhop/SKILL.md
```

Then ask normally — _"generate an image of a cat"_, _"transcribe this URL"_, etc.

## Configure your shell once

```bash
export TOKENHOP_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export TOKENHOP_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Older installs may only have the legacy `NINEROUTER_URL` / `NINEROUTER_KEY`; when `TOKENHOP_URL` / `TOKENHOP_KEY` are unset, the skills fall back to them. <!-- legacy(9router): remove in v2 -->

Verify: `curl $TOKENHOP_URL/api/health` → `{"ok":true}`.

## Links

- Source: <https://github.com/tokenhop/tokenhop>
- Docs: <https://tokenhop.dev>
