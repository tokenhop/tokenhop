# Out-of-credit lock (billing lock)

When a supported API-key connection runs out of credit or hits its spending limit,
tokenhop takes that whole connection out of rotation and checks it in the
background until credit is back. No manual step is needed.

## What happens

1. A request fails with a billing error, for example Anthropic's
   `credit balance is too low` (HTTP 400) or an OpenAI `insufficient_quota` /
   `credit_balance_exhausted` code. Errors are classified by their structured
   code first; generic 400, 403 and 429 errors are never treated as billing.
2. The connection gets a saved `billingLock`. It is skipped for **every** model,
   not only the one that failed, and the lock survives restarts.
3. The same request falls back to the next account or combo member. If every
   connection is locked, the client gets the usual 503 with a credit-specific
   message.
4. While tokenhop runs, a probe re-checks each locked connection about every 3
   hours (with jitter). It sends one minimal, non-streaming request with
   `max_tokens: 1` to the provider's configured probe model (see the table
   below).
5. The lock clears only when the probe gets a real completion back. Any other
   result (still out of credit, timeout, network error, 5xx, 401) keeps the lock
   and schedules the next probe.

Normal successful traffic on other models does not clear the lock, and clearing
it never touches model cooldowns, auth errors or a manual disable.

## Dashboard

The provider page shows an **Out of credit** badge with the last and next probe
times and, when the last probe failed, a short reason. **Probe now** runs the
same probe immediately. It needs the `workspace.connections.manage` permission
and can run at most once every 5 minutes per connection.

Replacing the API key, or disabling and re-enabling the connection, also clears
the lock.

## Cost

A successful probe is a real, billable request (a few input tokens and one
output token). Whether a rejected probe is billed is not documented by the
providers. Probe usage is recorded in request details under
`/internal/billing-probe`, with its real tokens and cost. It is kept out of user
usage stats, budgets and the Home live-routes feed.

## Supported providers

| Provider  | Probe model                              | Notes                                              |
| --------- | ---------------------------------------- | -------------------------------------------------- |
| Anthropic | `claude-haiku-4-5-20251001`              | Thinking not requested                             |
| OpenAI    | Cheapest priced non-reasoning chat model | Picked from the registry (currently `gpt-4o-mini`) |
| DeepSeek  | `deepseek-chat`                          | Sent with `thinking: { type: "disabled" }`         |

OpenRouter documents `max_tokens: 1` but has no chat models in the static
registry (its catalog is live), so it is not probed or locked yet. All other
API-key providers are excluded until their docs confirm a safe minimum request.
Excluded providers keep the existing per-model cooldowns. OAuth and subscription
connections are not affected.

If a probe model is retired, the probe reports "Probe model unavailable" and the
lock stays. Replace the key or re-enable the connection to clear it.

This feature does not display exact balances. Anthropic has no documented
prepaid-balance endpoint usable with the connection's normal inference key.

## References

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic errors](https://platform.claude.com/docs/en/api/errors)
- [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [DeepSeek chat completion](https://api-docs.deepseek.com/api/create-chat-completion)
- [OpenRouter parameters](https://openrouter.ai/docs/api_reference/parameters.md)
