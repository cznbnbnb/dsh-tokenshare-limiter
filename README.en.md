# dsh-tokenshare-limiter

[中文](README.md) | English

Outgoing rate limiting, failure recovery, and image-limit recovery for the TokenShare provider route in DeepSeek Harness (`dsh`): stay under the request-rate ceiling and prevent an upstream 503 or a fifth prompt image from ending the turn.

> **No credentials involved.** The plugin never reads, stores, or forwards an API key. TokenShare authentication stays exactly where DSH already keeps it.

## Why

TokenShare enforces a hard per-account request rate; exceeding it triggers a temporary ban measured in hours. Its upstream also returns 503 intermittently, and a single failure ends the whole turn.

The plugin hooks `llm/stream` and `agent/request-error` to do three things:

1. **Outgoing throttle.** Sessions and hosts sharing a DSH data directory space out request starts and share the sliding-window budget.
2. **Failure replay.** A 429 pauses the route until the provider's deadline or the configured retry delay. Other temporary failures such as a 503 delay the individual request.
3. **Image-limit recovery** — offload the oldest retained images during `agent/pre-step`, counting both the existing surface and newly admitted messages against a four-image prompt budget. An explicit image-count 400 from a custom route produces the same durable `image/offload` decision and a retry.

## Install

**Install or update to 1.2.1 on Desktop**

On a fresh installation, open DeepSeek Harness once to create its desktop profile. Fully quit the app, then run the following command in a terminal.

```sh
dsh plugin --profile desktop add https://github.com/cznbnbnb/dsh-tokenshare-limiter/releases/download/v1.2.1/dsh-tokenshare-limiter-1.2.1.tgz
```

Reopen the desktop app and go to **Settings → TokenShare 限流** to see the switch and current usage. For the Web profile, replace `desktop` with `web` and restart `dsh web`.

**From a local checkout**

```sh
git clone https://github.com/cznbnbnb/dsh-tokenshare-limiter.git
dsh plugin --profile desktop add "$PWD/dsh-tokenshare-limiter"
```

**Remove**

```sh
dsh plugin --profile desktop remove dsh-tokenshare-limiter
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

The default cap of 14 requests per 60 seconds spaces starts at least 4.286 seconds apart. Interactive sessions, subagents, scheduled calls and retries share it. Automatic session titles also count when DSH uses TokenShare to generate them. Each admission occupies one slot through its first response or completion and for a full window afterward. Lowering the cap, reloading the plugin or restarting DSH preserves recent usage.

An attempt that emitted only zero-token usage can be retried. Partial text, reasoning, tool output or nonzero usage propagates the failure to the host.

Each request has a default budget of six retries.

**Images are preserved, not copied or deleted.** Offload marks the oldest retained input occurrences as `offloaded`; DSH then sends placeholder text and an available read-only path while preserving the original attachments and session records. Only HTTP 400 failures (or `INVALID_REQUEST` without a status) that explicitly state a per-prompt image limit enter this recovery path.

Any 429, including `account_blacklisted`, pauses all sessions on the route. Timestamps without offsets use Beijing time. The provider's retry delay and any later deadline extend the wait. Pausing local throttling preserves a known embargo. Queued requests can be cancelled and resume at the configured pace.

## Privacy

- Contains no API key, token, or account identifier, and never reads them.
- Sends nothing to any external server. The only HTTP endpoint is a local `127.0.0.1` settings API that accepts loopback origins only.
- Reads exactly two fields of `llm/stream` — `provider` and `signal` — and never rewrites its frozen request messages.
- Only after an explicit image-limit 400 on a matching provider does it inspect image block types and offload markers. It never reads image bytes or logs prompt text; recovery writes DSH's native `image/offload` event to the existing session.
- The settings file stores rate settings. Harness instances using the same data directory share cooldown deadlines and request timestamps in `settings/tokenshare-limiter-cooldowns`. An unanswered request retains its host process ID for recovery after a host exits. Subsequent admissions prune responses older than ten minutes.

## Compatibility

Version 1.2.1 was tested on DSH Desktop `0.2.3-alpha.2`. The plugin requires DSH 0.2.0 or later and a host running Node.js 22.13.0 or later with the built-in `node:sqlite` module.

## Known limitations

- The full "wait five minutes then replay" path has not been exercised against a real 503 (it needs the upstream to fail at that moment). Every queue and replay is recorded on the settings page, so it can be verified in practice.
- Other applications and devices can contribute to the same account's upstream usage through their own connections.
- Throttling happens at `llm/stream` only, not inside provider adapters' other network calls such as model discovery.

## License

[MIT](LICENSE)
