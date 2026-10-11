# Changelog

## 0.1.0

首个版本。把 DSH 压缩摘要调用的**请求信封**对齐成该会话真实路由头，让 provider 的前缀缓存继续命中，
而不是把整段回放的历史按全价重算一遍。

**实测**（本机：1M 窗口 / `deepseek-account` + `deepseek-flash` / 会话档位 `max`，DSH Desktop 2.0.17
+ `@deepseek-ai/dsh-compaction-basic` 0.2.0-rc.2）。同一会话、同一条命令（手动 `/compact`，
`source: user`）、同一条路由，唯一差别是有没有本插件：

| | 折叠区间 | prompt | `inputTokens` | `cacheReadTokens` | 命中 | 输出 | 墙钟 |
|---|---|---|---|---|---|---|---|
| 装插件前 | 113,767 | 150,320 | **132,528** | 17,792 | **11.8%** | 3,749 | 17.0 s |
| 装插件后 | 170,026 | 223,920 | **560** | **223,360** | **99.7%** | 4,590 | 18.2 s |

修后剩下的 560 token 新鲜输入 ≈ 追加在末尾的那条压缩指令本身（`1802 + 534 = 2336` 字符）——
即**整段回放前缀全部由缓存服务**，正是 `summarizeWithLlm` 的文档注释所承诺的
（"replay the conversation prefix … so the provider's warm prefix cache is reused"）。

**归因**（本机 216 个会话档案里 52 次带 `request/header` 前情的折叠）：分裂缓存键的决定性字段是
`reasoningEffort`——7 次 effort 与普通回合一致的折叠全部 **99.9%** 命中（新鲜输入 448–589 token），
45 次不一致的平均 **12.7%**；而那 7 次的 `maxTokens` 仍然是分叉的（65536 vs 256000），
说明本 provider 的缓存键**不含** `max_tokens`。

**上报**：上游 `deepseek-harness` discussion
[#1944](https://github.com/deepseek-ai/deepseek-harness/discussions/1944) 三条评论——
独立复现 + A/B 实测（[discussioncomment-18862211](https://github.com/deepseek-ai/deepseek-harness/discussions/1944#discussioncomment-18862211)）、
字段归因（[discussioncomment-18862227](https://github.com/deepseek-ai/deepseek-harness/discussions/1944#discussioncomment-18862227)）、
"名字像修复、实际复制了缺陷"的社区包核对（[discussioncomment-18862357](https://github.com/deepseek-ai/deepseek-harness/discussions/1944#discussioncomment-18862357)）。

**边界**：只改标量参数，不碰消息列表；不碰任何普通请求；任何异常都被吞掉并照常 `next()`——
插件坏掉时只会退化成官方原样，绝不会阻断一次模型调用。
