# Plan: keep images and documents across Claude→OpenAI and the Antigravity Claude envelope

Linear: YAN-40, YAN-41 · GitHub: #499, #500 · Target: v0.6.x (`backport:0.6`)

## Research summary

- **YAN-40**: `open-sse/translator/request/claude-to-openai.js` converts only
  base64 `image` blocks. `image` blocks with `source.type: "url"` and every
  `document` block are dropped. A known-fail test (`bugs-openai-bridge.test.js`)
  already pins the url case.
- **YAN-41**: `wrapInCloudCodeEnvelopeForClaude` in
  `open-sse/translator/request/openai-to-gemini.js` handles only text, tool_use
  and tool_result. User `image` blocks (and PDF `document` blocks produced by
  `openai-to-claude`) vanish. `tool_result` content runs non-text items through
  `JSON.stringify`, so images become base64 JSON text. Tool-result items arrive
  in Claude shape (`image`) or raw OpenAI shape (`image_url` data URI), because
  `openai-to-claude` passes tool message content through as-is.
- Both files are byte-identical on `master` and `release/0.6`, so the backport
  cherry-picks cleanly.
- Capability stripping (`concerns/modality.js`) runs before translation, so
  models without `vision`/`pdf` never see the new parts.

## Design

1. `claude-to-openai.js`: url image → `image_url { url }`; base64 document →
   `file { filename, file_data }`; text document → text part. URL and
   content-block documents stay dropped (Chat has no equivalent part).
2. `openai-responses.js` (Chat → Responses): a Chat `file` part becomes
   `input_file` instead of being serialized into `input_text`. Without this,
   step 1 would dump base64 PDFs into the prompt of Codex targets.
3. `openai-to-gemini.js`: `toInlineDataPart` maps Claude base64 image/document
   and OpenAI data-URI `image_url` to `inlineData`. User blocks use it directly.
   Tool-result media (including Chat `file` data URIs) are pulled out of the
   stringified result and appended after the message's parts, tagged with the
   tool call id.
4. `executors/codex.js` `prefetchImages`: also inline remote `input_image`
   URLs. Claude URL images now reach Codex in that shape, and the Codex backend
   can't fetch remote images (review finding).

## Tasks

| #   | File                                              | Change                                     |
| --- | ------------------------------------------------- | ------------------------------------------ |
| 1   | `open-sse/translator/request/claude-to-openai.js` | url image + document cases                 |
| 2   | `open-sse/translator/schema/blocks.js`            | `RESPONSES_ITEM.INPUT_FILE`                |
| 3   | `open-sse/translator/request/openai-responses.js` | Chat `file` → `input_file`                 |
| 4   | `open-sse/translator/request/openai-to-gemini.js` | `toInlineDataPart`, user + tool-result use |
| 5   | `tests/translator/bugs-openai-bridge.test.js`     | flip url known-fail, add document cases    |
| 6   | `tests/translator/bugs-antigravity.test.js`       | user image + tool-result image cases       |

## Validation

`npm run lint`, targeted vitest files, then `npm test` (touches gateway code).
