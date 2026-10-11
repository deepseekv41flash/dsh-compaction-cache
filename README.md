# dsh-compaction-cache

> 让 DSH 的**压缩摘要调用**带上和它替代的那一轮**完全相同的请求参数**，于是 provider 的前缀缓存继续命中——而不是把整段回放的历史按全价重算一遍。

DSH（DeepSeek Harness）插件 · **零依赖** · **零工具** · **零 UI** · **免构建** · MIT

**这是一个绕官方缺陷的临时补丁。** 官方修好后（上游 `deepseek-harness` discussion
[#1944](https://github.com/deepseek-ai/deepseek-harness/discussions/1944)）请把它整包删掉。

English: [README-en.md](README-en.md)

---

## 它解决什么问题

`dsh-compaction-basic` 的 `summarizeWithLlm` 组装摘要请求长这样：

```js
{ provider, model, messages, toolHistory, tools?, maxTokens: config.maxTokens,
  sessionId, purpose: 'compaction', signal }
```

它只从会话已固化的路由头里取了 `provider` / `model`，于是：

| 参数 | 正常一轮 | 压缩调用 | |
|---|---|---|---|
| `reasoningEffort` | `max`（会话档位） | **不带** → 适配器回落 `high` | 分叉 |
| `maxTokens` | `256000`（适配器默认） | **`65536`**（`config.maxTokens ?? headroomTokens`） | 必分叉 |

而 provider 侧的缓存键按**请求信封**分区，其中起决定作用的是**思考档位**（`reasoningEffort`，
实测归因见下）——档位一分叉，整段回放前缀全部 miss，压缩本身
（一次本来只该多付"指令那几个 token"的调用）变成全价重算上一整段上下文。

### 实测（1M 窗口，DeepSeek 路由，会话档位 `max`）

同一会话、同一条命令（手动 `/compact`，`source: user`）、同一条路由，唯一差别是有没有本插件
（修后那次紧跟在一次宿主重启之后——provider 缓存是服务端的，而"前缀命中 99.7%"本身就证明
重启后回放的前缀字节与重启前一致）：

| | 折叠区间 | prompt | `inputTokens` | `cacheReadTokens` | 命中 | 输出 | 墙钟 |
|---|---|---|---|---|---|---|---|
| 装插件前 | 113,767 | 150,320 | **132,528** | 17,792 | **11.8%** | 3,749 | 17.0 s |
| 装插件后 | 170,026 | 223,920 | **560** | **223,360** | **99.7%** | 4,590 | 18.2 s |

修后剩下的 560 token 新鲜输入 ≈ 那条追加在末尾的压缩指令本身（`1802 + 534 = 2336` 字符，
≈4.2 字符/token）——即**整段回放前缀全部由缓存服务**，这正是 `summarizeWithLlm` 的文档注释
所承诺的（"replay the conversation prefix … so the provider's **warm prefix cache** is reused"）。
同一会话的普通回合本来就是 149,632 / 149,837（命中 99.9%），修后折叠与它们回到了同一个缓存条目。

修前的形态也自洽：本机 216 个会话档案里今天之前录得的 **51 次折叠**，平均命中 **23%**，其中 40 次低于 50%，
且**命中的那一截恒定在 ~17.3–18K**（= 系统提示 + 工具 schema），与折叠大小无关——那是
"参数分叉的信封自己攒下的缓存条目"，永远轮不到普通回合刚写热的回放前缀。
这一现象**早于任何第三方压缩插件**存在：9-28 的第一次折叠就是 518,458 / 0（0.0%）。

### 归因：分叉的**决定性**字段是 `reasoningEffort`，不是 `maxTokens`

把 52 次带 `request/header` 前情的 LLM 折叠按"折叠信封 vs 该会话普通回合信封"分组
（折叠信封固定 = 不带 effort → 适配器回落 `high`，`maxTokens 65536`）：

| 分组 | 次数 | 平均命中 | 新鲜输入 |
|---|---|---|---|
| effort 相同（会话档位 = `high`） | 7 | **99.9%** | 448–589 token |
| effort 不同（会话档位 = `max`） | 45 | **12.7%** | 5 万–66 万 token |

那 7 次全命中里，**`maxTokens` 依然是分叉的**（折叠发 65536、普通回合发 256000）。
若 `max_tokens` 参与缓存键，这 7 次应当和另外 45 次一样全 miss——所以**本 provider 的键不含它**。

两个独立佐证：

- **同会话内切换档位**（`b2d7c860…`，HD2SDK 会话）：10-01 15:38 → 10-02 16:55 的 5 次折叠在
  档位 `high` 下命中 **99.9%**（in = 540 / 492 / 589 / 448 / 448）；档位切成 `max` 之后，
  同一个会话、同一条路由的后续 27 次折叠里有 **22 次落在 0.3–3.4%**（in ≈ 50 万–66 万），
  例外只有两次过渡态（73%、71%）和下面的两次重试对。
- **"中止后重试"的自然对照 ×2**：10-06 22:13:56 与 10-09 19:03:46 各有一次 `/compact`
  在 11–12 秒后被中止（`This operation was aborted`），随后重发同一条命令——重试那次
  **in=177 / cached=639,744**、**in=171 / cached=659,712**（都是 99.97%）。
  被中止的那次已经把这段前缀写进了**分叉信封自己**的缓存条目，重试立刻全中。
  这证明分叉信封的缓存条目是存在且可用的：历史上的 miss 不是"压缩请求注定冷启动"，纯粹是信封不同。

结论：上游修法**必须**带上 `reasoningEffort`（或等价的思考档位字段）；对齐 `maxTokens` 是
防御性的（别的 provider 可能真的把它算进键），在本机实测里它不影响命中。

## 它做什么

挂在公开的 `llm/stream` 瀑布上，只对**调用方自己打了 `purpose: 'compaction'` 标签**的请求，
把上面两个参数补齐成路由头里的值：

```js
reasoningEffort = header.config.reasoningEffort   // 仅当 options 未设置，且 header.adapterDefaults 未标记它
temperature     = header.config.temperature       // 同上
maxTokens       = header.config.maxTokens         // 无条件覆盖（摘要器总是强设它）
```

两条不同的规则来自缺陷的两半：`mirror` 类参数正常一轮本来就是让适配器物化的，摘要调用也一样，
所以只在"未被显式标记为适配器默认"时才注入；而 `maxTokens` 摘要器**永远**会覆盖成自己的值，
正常一轮永远不可能与它一致，所以必须对齐成路由值。

**边界**：只改标量参数，**不碰消息列表**；不碰任何普通请求；任何异常都被吞掉并照常
调用 `next()`——这个插件坏掉时只会退化成官方原样，绝不会阻断一次模型调用。

## 安装（只从 GitHub 分发）

本包**不发布 npm、不进插件市场**：它是对上游那个三行修复的临时补丁，官方修好后就该整包删掉，
不适合做成长期存在的包。`package.json` 里的 `private: true` 是刻意加的。

方式一 · 作为依赖写进 profile（`github:` 规格）：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
"dependencies": { "dsh-compaction-cache": "github:deepseekv41flash/dsh-compaction-cache" },
"dsh": { "profile": { "bundles": ["…", "dsh-compaction-cache"] } }
```

> 本机实测（pnpm 11.22.0）：`pnpm add github:deepseekv41flash/dsh-compaction-cache` 解析到 `0.1.0`、
> 导入正常，`private: true` 不影响安装。profile 的依赖本来就是 pnpm 装的，所以这条规格可用。
> （`npm install github:…` 在本机会被解析成 `ssh://git@github.com/…`，没配 SSH key 就是
> `Permission denied (publickey)`——那是 npm 的 shorthand 行为，与包无关。）

方式二 · 本地 clone + `link:`（本机实测走的就是这条）：

```sh
git clone https://github.com/deepseekv41flash/dsh-compaction-cache
# dependencies 里写 "dsh-compaction-cache": "link:<clone 路径>"，bundles 里再加同名一项
```

本包带 `dsh.bundle.patch`，列进 `dsh.profile.bundles` 即自动装配；`lib/` 是纯 JS、无构建步骤，
clone 下来就能跑。不想用 bundles 的话，也可以在 profile 的 patch 层显式插入：

```yaml
- insert:
    - id: compaction-cache
      name: dsh-compaction-cache
```

## 配置（全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `log` | `true` | 每次对齐写一行 `info` |
| `mirror` | `['reasoningEffort','temperature']` | 会话路由头里要镜像的参数名 |
| `alignMaxTokens` | `true` | 是否把 `maxTokens` 对齐成路由值 |

## 验证

```sh
npm test          # 20 项单测：镜像/适配器默认/幂等/冻结信封/缺服务降级/标签判定/挂载自证
```

生效后，宿主日志里会出现：

```
compaction-cache: aligned summarization envelope (reasoningEffort=max maxTokens=256000 (was 65536)) session=...
```

判据（对比修前）：下一次折叠的 `compaction/summary.usage` 里，
`inputTokens` 从 ~13 万掉到几百、`cacheReadTokens` 变成六位数。

## 已知不确定处

- 归因已由 52 次折叠的自然实验定位到 `reasoningEffort`（见上）；仍未做的只剩**主动**单字段实验
  （把 `mirror` 置空、保留 `alignMaxTokens: true` 再折一次）——但从数据看预期是"命中不变"。
- 上游的正确修法是**整包继承路由信封**，而不是逐字段打补丁。
- 一个只影响审计、不影响账单的坑：`compaction/summary` 事件里记录的 `maxTokens`
  取的是 spec（`config.maxTokens`），**不是**实际发出的信封——所以事件里永远写着 65536。
  判断本插件是否生效要看 `usage` 的 `inputTokens` / `cacheReadTokens` 分裂，不要看那个字段。

## 卸载

从 profile patch / bundles 里删掉那一行即可，重启即净——没有工具、没有落盘状态、不改任何包源码。
**官方修复落地后应当卸载。**

## License

MIT
