# dsh-tokenshare-limiter

[中文](README.md) | English

Outgoing rate limiting, failure recovery, and image-limit recovery for the TokenShare provider route in DeepSeek Harness (`dsh`): stay under the request-rate ceiling and prevent an upstream 503 or a fifth prompt image from ending the turn.

> **No credentials involved.** The plugin never reads, stores, or forwards an API key. TokenShare authentication stays exactly where DSH already keeps it.

## Why

TokenShare enforces a hard per-account request rate; exceeding it triggers a temporary ban measured in hours. Its upstream also returns 503 intermittently, and a single failure ends the whole turn.

The plugin hooks `llm/stream` and `agent/request-error` to do three things:

1. **Outgoing throttle** — at most N requests per sliding window. Requests beyond the budget queue until the window rolls over instead of failing.
2. **Failure replay** — on upstream 429/5xx, wait M minutes and retry, instead of handing the error to the conversation.
3. **Image-limit recovery** — offload the oldest retained images during `agent/pre-step`, counting both the existing surface and newly admitted messages against a four-image prompt budget. An explicit image-count 400 from a custom route produces the same durable `image/offload` decision and a retry.

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

The defaults are 14 requests per minute and 5 minutes between retries for temporary upstream failures.

Open **Settings → TokenShare 限流**.

- Use the switch at the top right to enable or pause the limiter.
- The usage panel shows the current window and cumulative counts. While requests are waiting, it shows the reason, the expected resume time in Beijing time and the queue length.
- Under rate rules, drag a slider or enter a number to change the request cap or the retry delay (1–60 each). Changes save automatically. A failed save can be retried in place.
- Filter recent activity to warnings and errors, or expand a failure to read the details.

Settings take effect on save and are stored in `~/.dsh/settings/tokenshare-limiter.json`.

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
    maxImages: 4
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `providers` | `tokenshare` | Provider routes to govern, comma separated |
| `perMinute` | `14` | Requests allowed per window |
| `retryWaitMinutes` | `5` | Wait before replaying a failed request |
| `windowSeconds` | `60` | Window length |
| `maxRetries` | `6` | Replay budget per request; `0` disables replay |
| `maxImages` | `4` | Images per prompt (1–50), counting existing history and the new batch |

Slider values take precedence; fields absent from the saved file fall back to this configuration.

## Behaviour details

**The cap means "at most N per minute."** The first N requests go out immediately; request N+1 queues until the window rolls over (about a minute). Lower N to be more conservative.

An attempt that emitted only zero-token usage can be retried. Partial text, reasoning, tool output or nonzero usage propagates the failure to the host.

Each request has a default budget of six retries.

**Images are preserved, not copied or deleted.** Offload marks the oldest retained input occurrences as `offloaded`; DSH then sends placeholder text and an available read-only path while preserving the original attachments and session records. Only HTTP 400 failures (or `INVALID_REQUEST` without a status) that explicitly state a per-prompt image limit enter this recovery path.

All sessions on a TokenShare route wait until the deadline reported by `account_blacklisted`. A timestamp without an offset uses Beijing time. A later deadline extends the wait. Pending requests can be cancelled and resume in queue order subject to the rate cap.

## Privacy

- Contains no API key, token, or account identifier, and never reads them.
- Sends nothing to any external server. The only HTTP endpoint is a local `127.0.0.1` settings API that accepts loopback origins only.
- Reads exactly two fields of `llm/stream` — `provider` and `signal` — and never rewrites its frozen request messages.
- Only after an explicit image-limit 400 on a matching provider does it inspect image block types and offload markers. It never reads image bytes or logs prompt text; recovery writes DSH's native `image/offload` event to the existing session.
- The settings file stores rate settings. Harness instances using the same data directory share cooldown deadlines in `settings/tokenshare-limiter-cooldowns`. Expired records are removed automatically.

## Compatibility

Verified on DSH desktop `0.2.2-rc.2` and `0.2.3-alpha.2`. Declares `engines.dsh: >=0.2.0`; older hosts may lack the `settings.section` slot, in which case the settings page does not appear but throttling still works.

## Known limitations

- The full "wait five minutes then replay" path has not been exercised against a real 503 (it needs the upstream to fail at that moment). Every queue and replay is recorded on the settings page, so it can be verified in practice.
- The rate window starts empty after a DSH restart. Account cooldown deadlines persist across restarts.
- Throttling happens at `llm/stream` only, not inside provider adapters' other network calls such as model discovery.

## License

[MIT](LICENSE)
