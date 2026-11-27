# dsh-tokenshare-limiter

中文 | [English](README.en.md)

给 DSH 的 TokenShare provider 路由加一层**出门节流**、**异常重放**和**图片上限恢复**：避免超频触发平台封号，也避免上游 503 或第 5 张图片直接把这一轮对话打断。

> 给同事的话：装完不用配任何 key——插件本身不碰任何凭据，TokenShare 的 API key 仍然由 DSH 的 provider 配置管理。

## 为什么需要它

TokenShare 对每个账号的请求频率有硬性限制，超了会临时封禁（几小时到几天）。同时它的上游偶发 503，一次失败会让整轮对话终止，还得手动重发。

这个插件通过 `llm/stream` 与 `agent/request-error` 做三件事：

1. **请求节流**。同一 DSH 数据目录的会话和宿主共用滑动窗口，按窗口长度和请求上限均匀放行。
2. **异常重放**。上游返回 429 时，整条线路等待服务端指定的时间。未指定期限时采用设置中的重试间隔。5xx 等临时故障按请求等待重试。
3. **图片上限恢复** —— 在 `agent/pre-step` 按单 prompt 最多 4 张图提前转存最旧图片，合计计算已有 surface 与本批新消息。若自定义路由仍返回明确的图片数量 400，则记录同样的 `image/offload` 决策并重试。

## 安装

**桌面版安装或更新到 1.2.1**

首次安装先打开一次 DeepSeek Harness，让它创建桌面配置。完全退出桌面版后，在终端运行下面的命令。

```sh
dsh plugin --profile desktop add https://github.com/cznbnbnb/dsh-tokenshare-limiter/releases/download/v1.2.1/dsh-tokenshare-limiter-1.2.1.tgz
```

重新打开桌面版，在「设置 → TokenShare 限流」查看开关和当前额度。使用 Web 版时，把命令中的 `desktop` 换成 `web`，然后重启 `dsh web`。

**从本地目录安装**

```sh
git clone https://github.com/cznbnbnb/dsh-tokenshare-limiter.git
dsh plugin --profile desktop add "$PWD/dsh-tokenshare-limiter"
```

**卸载**

```sh
dsh plugin --profile desktop remove dsh-tokenshare-limiter
```

## 使用

默认每分钟最多放行 14 次。通用上游故障等待 5 分钟后重试。

打开 **设置 → TokenShare 限流**。

- 用右上角的开关启用或暂停限流。
- 在用量面板查看当前窗口用量和累计统计。等待时会显示原因、北京时间的恢复时刻和排队请求数。
- 在「限流规则」里拖动滑块或直接输入数值，调整请求上限和故障重试间隔（均为 1–60）。更改会自动保存，保存失败可点击「重试保存」。
- 在「最近活动」中按时间查看记录，也可以只看警告和错误，展开查看失败详情。

设置保存在 `~/.dsh/settings/tokenshare-limiter.json`，保存后立即生效。

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
    maxImages: 4
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `providers` | `tokenshare` | 管控的 provider 路由名，逗号分隔 |
| `perMinute` | `14` | 每个窗口内最多放行几次 |
| `retryWaitMinutes` | `5` | 上游异常后等待多久重放 |
| `windowSeconds` | `60` | 窗口长度 |
| `maxRetries` | `6` | 同一请求连续重放上限，`0` 表示不重放 |
| `maxImages` | `4` | 单 prompt 图片预算（1–50），历史与本批新图一起计数 |

设置页的滑块值优先于这里的配置；存档里没有的字段才回落到配置默认值。

## 行为细节

默认设置为每 60 秒 14 次，相邻放行至少间隔 4.286 秒。主会话、子会话、自动任务和重试共用额度。自动生成会话标题也会发起一次模型请求，走 TokenShare 时同样计数。每次放行先占一个名额，收到首个响应或请求结束后再保留一个完整窗口。降低上限、重新加载插件或重启 Harness 时，窗口内的请求继续计数。

只有零 token 用量记录的失败可以重试。已经产生正文、推理、工具输出或非零用量的失败会交回宿主。

每个请求默认最多重试 6 次。

**图片不删除、不复制**：转存只把最旧的输入图片标记为 `offloaded`，宿主改发占位文本和可用的只读路径；原始附件和会话记录都保留。恢复逻辑只处理状态为 400（或无状态时 `INVALID_REQUEST`）且明确指出单 prompt 图片上限的错误，其它错误继续走原有流程。

TokenShare 返回普通 429 或 `account_blacklisted` 时，同一线路上的所有会话一起等待。无时区的解限时间按北京时间解析，同时遵守服务端给出的重试间隔。暂停本地节流仍会遵守已知的账号期限。解限后队列按发送间隔恢复，排队中的请求可以取消。

## 隐私

- 不包含任何 API key、令牌或账号信息，也不读取它们。
- 不向任何外部服务器发送数据；唯一的 HTTP 接口是本地 `127.0.0.1` 上的设置页接口，且只接受本机回环来源。
- `llm/stream` 只读取 `provider` 和 `signal`，不改写冻结的请求消息。
- 仅在匹配的 provider 返回明确图片上限 400 时读取会话中的图片类型及转存标记，不读取图片字节、不记录提示词正文；恢复产生的 `image/offload` 事件由宿主写入原会话。
- 设置文件保存限流开关、速率和重试间隔。`settings/tokenshare-limiter-cooldowns` 共享解限时刻和请求时间戳。等待首个响应时暂存宿主进程号，以便宿主退出后收回名额。后续放行时清理已响应超过十分钟的记录。

## 兼容性

1.2.1 已在 DSH 桌面版 `0.2.3-alpha.2` 上实测。插件要求 DSH 0.2.0 及以上，宿主的 Node.js 运行时须为 22.13.0 及以上并提供内置的 `node:sqlite`。

## 已知限制

- 尚未在真实 503 场景下实测完整的「等 5 分钟重发」链路（需要上游恰好故障）；排队与重放都会记在设置页的「最近记录」里，可以据此核对。
- 其它应用和设备有独立的请求通道。同一账号的服务端用量还可能包含这些来源。
- 只节流 `llm/stream` 这一层，不拦截 provider adapter 内部的其它网络请求（如模型列表发现）。

## 许可

[MIT](LICENSE)
