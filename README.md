# dsh-tokenshare-limiter

中文 | [English](README.en.md)

给 DSH 的 TokenShare provider 路由加一层**出门节流**和**异常重放**：避免超频触发平台封号，也避免上游 503 直接把这一轮对话打断。

> 给同事的话：装完不用配任何 key——插件本身不碰任何凭据，TokenShare 的 API key 仍然由 DSH 的 provider 配置管理。

## 为什么需要它

TokenShare 对每个账号的请求频率有硬性限制，超了会临时封禁（几小时到几天）。同时它的上游偶发 503，一次失败会让整轮对话终止，还得手动重发。

这个插件在 `llm/stream` 瀑布上做两件事：

1. **出门节流** —— 滑动窗口内最多放行 N 次请求，超出的请求排队到窗口滚动之后再发，而不是失败重试。
2. **异常重放** —— 上游 429/5xx 时等 M 分钟重新发起，而不是把错误抛给对话。

## 安装

**从 GitHub 安装（推荐）**

```sh
dsh plugin --profile <你的 profile> add github:cznbnbnb/dsh-tokenshare-limiter
```

装完重启 `dsh web`（或刷新桌面版页面）。设置 →「TokenShare 限流」里能看到状态页，说明装好了。

**从本地目录安装**

```sh
git clone https://github.com/cznbnbnb/dsh-tokenshare-limiter.git
dsh plugin --profile <你的 profile> add ./dsh-tokenshare-limiter
```

**卸载**

```sh
dsh plugin --profile <你的 profile> remove dsh-tokenshare-limiter
```

## 使用

装好即生效，默认参数就是安全值：**每分钟最多 14 次**、**异常后等 5 分钟重试**。

打开 设置 →「TokenShare 限流」：

- 顶部状态胶囊：运行中 / 已暂停（点一下切换）
- 两条滑块：每分钟上限（1–60）、异常后等待分钟（1–60），拖动即保存、立刻生效
- 状态区：本窗口用量、累计请求、排队等待次数、异常重放次数、失败次数
- 最近记录：每一次排队和重放都会留一条，方便核对它到底有没有在工作

滑块值存在 `~/.dsh/settings/tokenshare-limiter.json`，改参数不需要重启，也不受插件启用/停用影响。

## 配置项

想一次性改默认值，可以写进 profile 的 `cordis.patch.yml`：

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

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `providers` | `tokenshare` | 管控的 provider 路由名，逗号分隔 |
| `perMinute` | `14` | 每个窗口内最多放行几次 |
| `retryWaitMinutes` | `5` | 上游异常后等待多久重放 |
| `windowSeconds` | `60` | 窗口长度 |
| `maxRetries` | `6` | 同一请求连续重放上限，`0` 表示不重放 |

设置页的滑块值优先于这里的配置；存档里没有的字段才回落到配置默认值。

## 行为细节

**限流口径是「每分钟最多 N 次」**：前 N 次直接发出，第 N+1 次排到窗口滚动之后（约一分钟）。想要更保守就调小 N。

**只对「还没吐出正文」的请求重放**：已经输出过 token 的流不重放——重来一次会让回复里出现重复段落，反而更糟。这类失败会正常抛给对话。

**连续失败有上限**：默认 6 次（约半小时）后把错误交回上层，不会无限挂着。

**插件自身异常时降级放行**：它卡在所有模型请求的路径上，所以内部任何异常都会变成「原样放行」并记一条日志，不会因为限流器出 bug 让别人的对话卡死。

## 隐私

- 不包含任何 API key、令牌或账号信息，也不读取它们。
- 不向任何外部服务器发送数据；唯一的 HTTP 接口是本地 `127.0.0.1` 上的设置页接口，且只接受本机回环来源。
- 只读取 `llm/stream` 的 `provider` 和 `signal` 两个字段，不读取、不修改、不记录请求内容。
- 落盘的只有三个数：`perMinute`、`retryWaitMinutes`、`enabled`。

## 兼容性

在 DSH `0.2.2-rc.2` 上开发并验证。声明 `engines.dsh: >=0.2.0`——更早的版本可能没有 `settings.section` 槽位，设置页不会出现，但节流本身仍然工作。

## 已知限制

- 尚未在真实 503 场景下实测完整的「等 5 分钟重发」链路（需要上游恰好故障）；排队与重放都会记在设置页的「最近记录」里，可以据此核对。
- 限流状态是进程内的，DSH 重启后窗口计数从零开始。
- 只节流 `llm/stream` 这一层，不拦截 provider adapter 内部的其它网络请求（如模型列表发现）。

## 许可

[MIT](LICENSE)
