# Plan: Translator fixes — Gemini schema param names, Claude think tags, Ollama image-only messages (YAN-17, YAN-33, YAN-39)

## Summary

Three live translator bugs, shipped in v0.6.0 and present on `release/0.6`, fixed in one PR
(target `v0.6.x`: PR into `master`, then backport with `backport:0.6`):

- **YAN-17 / #466**: `cleanJSONSchemaForAntigravity` treats keys of the `properties` map as schema
  keywords, so tool parameters named `format`, `title`, `default`, `const`, `examples`, `x-*`, … are
  deleted (and dropped from `required`) on every Gemini / Gemini CLI / Vertex / Antigravity route.
- **YAN-33 / #467**: the Claude→OpenAI stream translator emits empty `<think>` / `</think>` into
  `content`, while the thinking text already goes to `reasoning_content`.
- **YAN-39 / #468**: OpenAI→Ollama skips image-only user messages.

## User Story

As a client of the gateway, I want tool schemas, reasoning output and images to survive format
translation unchanged, so that the model sees every tool parameter, chat clients don't see stray
`<think></think>` tags, and vision prompts reach Ollama.

## Problem → Solution

- Every recursive pass in `formats/gemini.js` walks `Object.values(obj)`, so it treats the
  `properties` map as a schema → one shared walker that steps over name maps (`properties`,
  `patternProperties`, `$defs`, `definitions`, `dependentSchemas`) and only recurses into their values.
- `claude-to-openai.js` pushes tag chunks → drop them. The Responses translator relied on `</think>`
  to close the reasoning item before text, so `openai-responses.js` closes reasoning when text or a
  tool call starts.
- `openai-to-ollama.js` skip test ignores `images` → keep the message when it carries images.

## Metadata

- **Complexity**: Small
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 9
- **Target release**: v0.6.x (PR into `master`, label `backport:0.6`, then backport to `release/0.6`)

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/tokenhop/tokenhop/.claude/worktrees/tokenhop-fix-yan-17-33-39/ (branch: fix/yan-17-33-39-translator-fixes)

## Batches

| Batch | Tasks         | Notes                              |
| ----- | ------------- | ---------------------------------- |
| B1    | 1.1, 1.2, 1.3 | Disjoint files, run in parallel    |
| B2    | 2.1           | Validation after all of B1 is done |

---

## UX Design

### Before

Chat client streaming a Claude thinking model: `content = "<think></think>Hello"`.

### After

`content = "Hello"`, `reasoning_content = "…"`.

### Interaction Changes

| Touchpoint                  | Before                          | After                        | Notes                   |
| --------------------------- | ------------------------------- | ---------------------------- | ----------------------- |
| OpenAI chat stream (Claude) | Empty think tags in content     | Clean content                | Reasoning unchanged     |
| Gemini-family tool calls    | Params named like keywords lost | Params kept, still cleaned   | Keywords still stripped |
| Ollama vision               | Image-only message dropped      | `content: ""`, `images: […]` |                         |

---

## Mandatory Reading

| Priority | File                                               | Lines   | Why                                                       |
| -------- | -------------------------------------------------- | ------- | --------------------------------------------------------- |
| P0       | `open-sse/translator/formats/gemini.js`            | 186-479 | Every recursive pass to fix                               |
| P0       | `open-sse/translator/response/claude-to-openai.js` | 79-152  | Tag emission to remove                                    |
| P0       | `open-sse/translator/response/openai-responses.js` | 69-125  | Reasoning close ordering                                  |
| P0       | `open-sse/translator/request/openai-to-ollama.js`  | 125-142 | Skip condition                                            |
| P1       | `open-sse/utils/codexToolSchema.js`                | 57-67   | Precedent: `properties` is a name map                     |
| P1       | `open-sse/translator/index.js`                     | 262-275 | `initState` fields `inThinkingBlock`, `currentBlockIndex` |
| P2       | `tests/translator/golden-response-stream.test.js`  | 23-69   | Golden snapshot that locks the tags                       |
| P2       | `tests/unit/openai-to-ollama-malformed.test.js`    | 1-30    | Test style to mirror                                      |

## External Documentation

No external research needed.

---

## Patterns to Mirror

### NAMING_CONVENTION

```js
// SOURCE: open-sse/translator/formats/gemini.js:354-359
// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
```

### SERVICE_PATTERN (name maps are not schemas)

```js
// SOURCE: open-sse/utils/codexToolSchema.js:57-60
if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
  for (const [propName, propSchema] of Object.entries(value)) {
    const cleaned = stripNode(propSchema, stats);
```

### ERROR_HANDLING

Translators are pure transforms; no throws added. Keep guards `if (!obj || typeof obj !== "object") return;`.

### TEST_STRUCTURE

```js
// SOURCE: tests/unit/openai-to-ollama-malformed.test.js:2-3,19
import { describe, it, expect } from "vitest";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";
describe("openaiToOllamaRequest - tool_calls arguments parsing", () => {
```

```js
// SOURCE: tests/translator/golden-response-stream.test.js:4-6,23-31 (stream helper)
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
const out = translateResponse(targetFormat, sourceFormat, ev, state);
```

---

## Files to Change

| File                                                                 | Action | Justification                                        |
| -------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| `open-sse/translator/formats/gemini.js`                              | UPDATE | Shared name-map-aware walker for every pass (YAN-17) |
| `open-sse/translator/response/claude-to-openai.js`                   | UPDATE | Drop `<think>`/`</think>` content chunks (YAN-33)    |
| `open-sse/translator/index.js`                                       | UPDATE | Remove dead `inThinkingBlock`/`currentBlockIndex`    |
| `open-sse/translator/response/openai-responses.js`                   | UPDATE | Close reasoning before text / tool call (YAN-33)     |
| `open-sse/translator/request/openai-to-ollama.js`                    | UPDATE | Keep image-only messages (YAN-39)                    |
| `tests/translator/__snapshots__/golden-response-stream.test.js.snap` | UPDATE | Golden no longer has tag chunks                      |
| `tests/unit/gemini-schema-cleaner.test.js`                           | CREATE | Regression test for YAN-17                           |
| `tests/unit/claude-thinking-stream.test.js`                          | CREATE | No tags in chat content; Responses ordering intact   |
| `tests/unit/openai-to-ollama-malformed.test.js`                      | UPDATE | One image-only case (YAN-39)                         |

## NOT Building

- Copying `tool.input_schema` before cleaning in `openai-to-gemini.js:445` (in-place mutation is pre-existing, separate concern).
- http(s) image URLs for Ollama (Ollama needs base64; out of scope).
- `open-sse/transformer/responsesTransformer.js` — `handleResponsesCore` has no importer (unreachable).
- Shared `output_index` between reasoning and message items (pre-existing, tracked separately as YAN-37).

---

## Step-by-Step Tasks

### Task 1.1: Gemini schema cleaner respects name maps (YAN-17) — Depends on [none]

- **BATCH**: B1
- **ACTION**: In `open-sse/translator/formats/gemini.js`, add `SCHEMA_NAME_MAPS = new Set(["properties","patternProperties","$defs","definitions","dependentSchemas"])` and `forEachSubschema(obj, fn)` that, for each own entry with an object value, calls `fn` on each value of a name map (never on the map itself) and `fn(value)` otherwise. Replace every `for (const value of Object.values(obj)) …recurse(value)` loop in `convertConstToEnum`, `convertEnumValuesToStrings`, `mergeAllOf`, `flattenAnyOfOneOf`, `flattenTypeArrays`, `ensureObjectType`, `convertPrefixItems`, `ensureArrayItems`, `cleanupRequired`, `addPlaceholders` with `forEachSubschema(obj, <pass>)`. In `removeUnsupportedKeywords`, keep the delete check for real keys first, then recurse with the walker (so property names are never matched against the list or the `x-` prefix).
- **IMPLEMENT**: Arrays still pass through (`Object.entries` on an array yields items). No other behavior change.
- **MIRROR**: SERVICE_PATTERN (codexToolSchema).
- **IMPORTS**: none.
- **GOTCHA**: A name map whose key is itself in `UNSUPPORTED_SCHEMA_CONSTRAINTS` (`patternProperties`, `$defs`, `definitions`, `dependentSchemas`) must still be deleted by `removeUnsupportedKeywords`. `ensureObjectType` must not add `type` to a `properties` map.
- **VALIDATE**: New `tests/unit/gemini-schema-cleaner.test.js`: (a) schema with params `url`, `format` (enum), `title`, `default`, `const`, `examples`, `x-trace` and `required: ["url","format","const"]` keeps every param and every required entry; (b) a nested `format: "uri"` keyword on a string schema and a `title` keyword on the root are still stripped; (c) a param named `properties` does not get a `type` key added to the map. Run `cd tests && npx vitest run --config vitest.config.js unit/gemini-schema-cleaner.test.js translator/`.

### Task 1.2: Drop think tags from Claude→OpenAI stream, keep Responses ordering (YAN-33) — Depends on [none]

- **BATCH**: B1
- **ACTION**: In `open-sse/translator/response/claude-to-openai.js` remove the `<think>` push in `content_block_start` and the `</think>` block in `content_block_stop` (with `inThinkingBlock` / `currentBlockIndex` writes). Remove the now-dead `inThinkingBlock` and `currentBlockIndex` from `initState` in `open-sse/translator/index.js` (keep `thinkingBlockStarted`, `textBlockStarted`). In `open-sse/translator/response/openai-responses.js`, call `closeReasoning(state, emit)` before `emitTextContent` when not `state.inThinking`, and before emitting tool calls.
- **IMPLEMENT**: `closeReasoning` is already idempotent (`reasoningDone` guard). The `<think>`-tag parsing in `openai-responses.js` stays for providers that inline tags.
- **MIRROR**: existing `closeMessage(state, emit, idx)` call before tool calls.
- **IMPORTS**: none.
- **GOTCHA**: Without the `closeReasoning` change, Claude→Responses emits the message item while the reasoning item is still open and closes reasoning only at finish. Update the golden snapshot with `-u` only for `golden-response-stream.test.js`.
- **VALIDATE**: New `tests/unit/claude-thinking-stream.test.js`: (a) Claude thinking+text stream → OpenAI chunks: joined `content` is `"Hello"`, joined `reasoning_content` is the thinking text, no chunk content contains `<think`; (b) same Claude stream → `openai-responses` client: the reasoning `response.output_item.done` comes before the message `response.output_item.added`; (c) reasoning then tool_use (no text) → reasoning done before function_call added. Run `cd tests && npx vitest run --config vitest.config.js -u translator/golden-response-stream.test.js` then the new test and `translator/`.

### Task 1.3: Keep image-only messages for Ollama (YAN-39) — Depends on [none]

- **BATCH**: B1
- **ACTION**: In `open-sse/translator/request/openai-to-ollama.js` change the skip to `if (!content && images.length === 0 && role !== ROLE.ASSISTANT) continue;`.
- **IMPLEMENT**: One line.
- **MIRROR**: TEST_STRUCTURE.
- **IMPORTS**: none.
- **GOTCHA**: `content` must still be `""` (not undefined) in the output message.
- **VALIDATE**: Add an `it` to `tests/unit/openai-to-ollama-malformed.test.js` (new `describe("openaiToOllamaRequest - image-only messages")`): user message with only a `data:image/png;base64,AAAA` image_url → `messages[0]` equals `{ role: "user", content: "", images: ["AAAA"] }`.

### Task 2.1: Validate — Depends on [1.1, 1.2, 1.3]

- **BATCH**: B2
- **ACTION**: Run lint and the full suite with the regression gate.
- **IMPLEMENT**: `npm run lint`, `npm test`.
- **MIRROR**: N/A.
- **IMPORTS**: N/A.
- **GOTCHA**: `npm test` needs `tests/node_modules` (already installed in main checkout; run `cd tests && npm ci` in the worktree if missing).
- **VALIDATE**: Lint clean; `verify-no-regression.mjs` reports no new failures.

---

## Testing Strategy

### Unit Tests

| Test                           | Input                               | Expected Output                     | Edge Case? |
| ------------------------------ | ----------------------------------- | ----------------------------------- | ---------- |
| keyword-named params survive   | params format/title/default/const/… | all kept, required kept             | Yes        |
| real keywords still stripped   | `format: "uri"`, root `title`       | removed                             | No         |
| `properties` param             | param named `properties`            | map has no added `type`             | Yes        |
| Claude→OpenAI no tags          | thinking + text stream              | content `Hello`, reasoning separate | No         |
| Claude→Responses ordering      | thinking + text                     | reasoning done before message added | Yes        |
| Claude→Responses tool ordering | thinking + tool_use                 | reasoning done before function_call | Yes        |
| Ollama image-only              | user msg with only image            | `content: ""`, `images: [b64]`      | Yes        |

### Edge Cases Checklist

- [x] Empty input (empty `properties`, empty content)
- [ ] Maximum size input — N/A
- [x] Invalid types (non-object schema values)
- [ ] Concurrent access — N/A
- [ ] Network failure — N/A
- [ ] Permission denied — N/A

---

## Validation Commands

### Static Analysis

```bash
npm run lint
```

EXPECT: No lint errors

### Unit Tests

```bash
cd tests && npx vitest run --config vitest.config.js unit/gemini-schema-cleaner.test.js unit/claude-thinking-stream.test.js unit/openai-to-ollama-malformed.test.js translator/
```

EXPECT: All pass

### Full Test Suite

```bash
npm test
```

EXPECT: No regressions (`verify-no-regression.mjs`)

### Manual Validation

- [ ] Diff of the golden snapshot only removes the two tag chunks.

---

## Acceptance Criteria

- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing
- [ ] No lint errors
- [ ] Change cherry-picks cleanly onto `release/0.6`

## Completion Checklist

- [ ] Code follows discovered patterns
- [ ] No hardcoded values beyond the keyword/name-map sets
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks

| Risk                                                         | Likelihood | Impact | Mitigation                                               |
| ------------------------------------------------------------ | ---------- | ------ | -------------------------------------------------------- |
| A client relied on `<think>` tags in content                 | Low        | Low    | Reasoning still delivered via `reasoning_content`        |
| Walker changes schemas Gemini previously accepted            | Low        | Medium | Keyword stripping unchanged; tests cover both sides      |
| Responses ordering change affects native reasoning providers | Low        | Low    | Closing reasoning before text matches the Responses spec |

## Notes

All touched source files are identical on `master` and `release/0.6` (checked with `git diff`), so the
squash commit should cherry-pick cleanly.
