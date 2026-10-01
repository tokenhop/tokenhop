# YAN-58 + YAN-122: TTS body voice/response_format, Kiro CLIProxyAPI import close

GitHub: tokenhop/tokenhop#424, #425 · Linear: YAN-58, YAN-122 · Target: v0.5.x patch (PR into `master`, then
`backport:0.5` to `release/0.5`)

Both bugs reproduce on `origin/master` (9b3169db) and `origin/release/0.5` (b20ed47e). The touched files are
byte-identical on both branches, so the squash commit cherry-picks cleanly.

## YAN-58: `/v1/audio/speech` ignores OpenAI `voice` and `response_format`

### Research

- `src/sse/handlers/tts.js` reads `response_format` only from the query string. There it is the **envelope**
  (`mp3` = binary body, `json` = `{audio, format}`), used by the dashboard example and playground. `body.voice` is
  never read.
- `open-sse/handlers/ttsProviders/openai.js` reads a bare model as the voice. `openai/tts-1` (the id
  `/v1/models/tts` lists) sends `voice:"tts-1"` with model `gpt-4o-mini-tts`, and the output is always MP3.
- `open-sse/handlers/ttsProviders/selfhostedTts.js` forwards the envelope as the codec, so
  `?response_format=json` sends `response_format:"json"` upstream. This is the same mix-up, so it is fixed here too.
- The dashboard playground always sends `voice` (default `"alloy"`) alongside model ids that already encode a
  voice (`openai/tts-1/nova`).

### Design

- Query `response_format` keeps its envelope meaning. Body `response_format` is the audio codec, as in OpenAI:
  `mp3 | opus | aac | flac | wav | pcm`. Any other value, or a non-string `voice`, returns 400.
- **A voice in the model id wins.** Body `voice` fills in only when the model has no voice. This keeps every
  existing request (including the playground's default `alloy`) unchanged and fixes `openai/tts-1` + `voice`.
- `handleTtsCore` takes `voice` and `format` and passes them to adapters in the options object next to
  `language` and `style`.
- OpenAI adapter: a bare known TTS model id (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, taken from the registry) is
  the model, not the voice. Other bare values stay voices (legacy `openai/nova`). It sends `response_format` and
  returns the matching `format`, so `Content-Type` is `audio/<format>`.
- Self-hosted adapter: codec from `options.format` (default `mp3`), voice fallback from `options.voice`.

### Not in this change

- Other adapters (edge, google, elevenlabs, gemini, mimo, generic formats) keep encoding the voice in the model id.
  Add body-voice support when someone asks for it.
- OpenRouter's model/voice parser mis-reads `openai/gpt-4o-mini-tts` with no voice. That is a separate bug, tracked as YAN-613.

## YAN-122: Kiro CLIProxyAPI import never closes the modal

`KiroAuthModal` reports success with `onMethodSelect("import-cli-proxy")`, but `KiroOAuthWrapper` only treats
`import | api-key` as finished. Add `import-cli-proxy` to that branch.

## Tasks

1. `src/sse/handlers/tts.js`: validate and read body `voice` / `response_format`. Pass them through both the single
   and the combo path.
2. `open-sse/handlers/ttsCore.js`: accept `voice` and `format`, and forward them in the adapter options.
3. `open-sse/handlers/ttsProviders/openai.js` and `selfhostedTts.js`: apply the design above.
4. `src/shared/components/KiroOAuthWrapper.js`: handle `import-cli-proxy`.
5. Test: `tests/unit/openai-tts-body-fields.test.js` covers the OpenAI upstream body, `Content-Type`, the
   precedence of a voice in the model id, and the self-hosted envelope-vs-codec split.

## Validation

`npm run lint`, then the new test plus the existing TTS tests (`gemini-tts`, `minimax-tts`, `fish-audio-tts`,
`xiaomi-mimo-tts`, `media-*`), then `npm test` (the gate) and `npm run build`.
