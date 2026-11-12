# dsh-tokenshare-limiter

[中文](README.md) | English

Outgoing rate limiting and failure recovery for the TokenShare provider route in DeepSeek Harness (`dsh`): stay under a per-minute floor so the platform never bans the account, and turn an upstream 503 into a short wait instead of a dead turn.

> **No credentials involved.** The plugin never reads, stores, or forwards an API key. TokenShare authentication stays exactly where DSH already keeps it.

## Why

TokenShare enforces a hard per-account request rate; exceeding it triggers a temporary ban measured in hours. Its upstream also returns 503 intermittently, and a single failure ends the whole turn.

The plugin hooks the `llm/stream` waterfall and does two things:

1. **Outgoing throttle** — at most N requests per sliding window. Requests beyond the budget queue until the window rolls over instead of failing.
2. **Failure replay** — on upstream 429/5xx, wait M minutes and retry, instead of handing the error to the conversation.

## Install

**From GitHub**

```sh
dsh plugin --profile <profile> add github:cznbnbnb/dsh-tokenshare-limiter
```

Restart `dsh web` (or reload the desktop app). A **TokenShare 限流** page in Settings means it is live.

**From a local checkout**

```sh
git clone https://github.com/cznbnbnb/dsh-tokenshare-limiter.git
dsh plugin --profile <profile> add ./dsh-tokenshare-limiter
```

**Remove**

```sh
dsh plugin --profile <profile> remove dsh-tokenshare-limiter
```

## Use

It works on install with safe defaults: **14 requests per minute**, **5 minutes between retries**.

Settings → **TokenShare 限流** shows:

- A status pill: running / paused (click to toggle)
- Two sliders — per-minute cap (1–60) and retry wait in minutes (1–60). Dragging saves immediately and applies at once
- Counters: current window usage, total requests, queue waits, replay attempts, failures
- A recent-events log: every queue and every replay is recorded, so you can confirm it is actually working

Slider values live in `~/.dsh/settings/tokenshare-limiter.json`. Changing them needs no restart and survives disabling/enabling the plugin.

## Configuration

Defaults can be set in the profile's `cordis.patch.yml`:

```yaml
- id: tokenshare-limiter
  name: dsh-tokenshare-limiter
  config:
    enabled: true
    providers: tokenshare
    perMinute: 14
    retryWaitMinutes: 5
    windowSeconds: 60
    maxRetries: 6
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `providers` | `tokenshare` | Provider routes to govern, comma separated |
| `perMinute` | `14` | Requests allowed per window |
| `retryWaitMinutes` | `5` | Wait before replaying a failed request |
| `windowSeconds` | `60` | Window length |
| `maxRetries` | `6` | Replay budget per request; `0` disables replay |

Slider values take precedence; fields absent from the saved file fall back to this configuration.

## Behaviour details

**The cap means "at most N per minute."** The first N requests go out immediately; request N+1 queues until the window rolls over (about a minute). Lower N to be more conservative.

**Only requests that emitted no content are replayed.** A stream that already produced tokens is never replayed — restarting it would duplicate text in the reply. Those failures propagate to the conversation as usual.

**Replays are bounded.** After six consecutive failures (about half an hour) the error goes back to the caller instead of hanging forever.

**The plugin degrades to pass-through on its own errors.** It sits on every model request, so any internal exception is logged and the request continues untouched.

## Privacy

- Contains no API key, token, or account identifier, and never reads them.
- Sends nothing to any external server. The only HTTP endpoint is a local `127.0.0.1` settings API that accepts loopback origins only.
- Reads exactly two fields of `llm/stream` — `provider` and `signal`. It never reads, modifies, or logs request content.
- Persists three numbers: `perMinute`, `retryWaitMinutes`, `enabled`.

## Compatibility

Built and verified on DSH `0.2.2-rc.2`. Declares `engines.dsh: >=0.2.0`; older hosts may lack the `settings.section` slot, in which case the settings page does not appear but throttling still works.

## Known limitations

- The full "wait five minutes then replay" path has not been exercised against a real 503 (it needs the upstream to fail at that moment). Every queue and replay is recorded on the settings page, so it can be verified in practice.
- Throttle state is in-process; the window starts empty after a DSH restart.
- Throttling happens at `llm/stream` only, not inside provider adapters' other network calls such as model discovery.

## License

[MIT](LICENSE)
