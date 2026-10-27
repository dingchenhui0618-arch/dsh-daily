# 安全模型 / Security model

这份文档说明 **dsh-daily** 每天读什么、把这些内容发给谁、写到哪里，以及你点「做这个」之后
会发生什么。它从实现（`src/host.js`、`src/market.js`、`src/profile.js`、`src/spawn.js`、
`src/deliver.js`、`src/panel-api.js`）里读出来；**如果文档和代码不一致，以代码为准，
那说明这份文档是个 bug。**

> 一句话：它每天 11:00 把**你的私人画像**（`~/.codex` 的记忆摘要、`~/.dsh/AGENTS.md`、
> 已装插件清单）和一份第三方插件目录一起塞给模型，产出一份简报；你点一下「做这个」，
> 它会**新建一个会话**，让那个会话在你指定的目录里独立实现一个插件、并用 `gh repo create
> --public` 推到你自己的 GitHub 上。插件本身不替你发任何东西，但它递过去的那条指令会。

## 信任边界

插件跑在 DSH 宿主进程里，`inject: ['timer', 'webServer']`（`src/host.js`）。

| 表面 | 谁触发 | 这一层有没有鉴权 |
| --- | --- | --- |
| 每日定时器（默认 11:00，`hour`/`minute` 可配） | 宿主的 `timer` 服务 | 没有独立鉴权；到点就花一次模型调用 |
| 面板路由 `/dsh-daily` | 能访问 DSH web server 的人 | **没有自己的 token**；边界是宿主 web server |
| `POST /dsh-daily/approve` | 面板上的「做这个」 | 同上；没有二次确认，但要求匹配当天的候选 |
| 新建会话 | 上面的 approve 动作 | 走宿主 `sessionController` 或 `agents`，用宿主自己的权限 |

**视为不可信输入的**：

- **第三方目录 `catalog.json`**（`https://awesome-dsh-plugin.com/catalog.json`）：每个字段
  都可缺省，没有可用 `slug`/`owner` 的条目直接丢弃而不是补默认值；描述截断到 220 字符；
- **模型的 JSON 输出**：解析失败会重试，最终仍不可解析就记为失败，不把半截文本当报告；
- **HTTP 请求体**：上限 1 MiB，JSON 解析失败当空对象；未知动作 404；
- **画像文件**：`~/.codex/memories/memory_summary.md`、`~/.dsh/AGENTS.md`、profile 的
  `package.json` 读不到就记入 `missing`，不抛错；
- **`$DSH_HOME/daily/config.json`**：手写配置解析失败当空对象，不让坏配置阻塞加载。

## 它会把你自己的东西发给模型（最重要的一条）

每次生成日报，`buildProfileBrief` 会把下面三类内容拼进 prompt：

1. `~/.codex/memories/memory_summary.md`（默认最多 4000 字符）——你的长期记忆摘要；
2. `$DSH_HOME/AGENTS.md`（默认最多 2500 字符）——你的工作约定；
3. 当前 profile 的已装插件清单（`$DSH_HOME/profiles/<profile>/package.json` 的
   `dependencies` 与 `dsh.profile.bundles`）。

以及候选池（目录里的名称、描述、下载量、星数）。这份 prompt 通过宿主自己的 `llm`
服务发给**你配置的模型提供方**——也就是说，这些文本离开本机，和你在会话里直接问模型
是同一类数据流动，但它是**自动发生**的（每天到点一次，不需要你在场）。不想让它读到
某些内容，就别放在这两个文件里；`hour`/`minute` 之外没有"先问我再发"的开关。

## 它写什么

只写 `$DSH_HOME/daily/`（`dataDir` 可配）：

| 路径 | 内容 |
| --- | --- |
| `state.json` | 已跳过的仓库、历史标题、最近的运行记录 |
| `reports/<YYYY-MM-DD>.json` | 当天简报全文（候选、改进项、灵感、证据） |
| `approvals.jsonl` | 每次「做这个」的会话 id、是否真的开了会话、失败原因 |
| `market-cache.json` | 目录缓存（条目、抓取时间、来源日期） |
| `market.json` | 最近一次目录读取的状态（供面板显示，不重新联网） |
| `corpus.csv` | 可选：从 `seedCorpus` 复制来的初始语料 |

**不会**写你的项目目录——但 `projectsRoot`（默认 `~/Projects`）是它**开出新会话的工作
目录**，那个会话会按契约在里面新建项目。

## 网络

只有一个出口，`src/market.js` 的 `readUrl`：

- 只允许 **https**；
- 只允许两个主机：`awesome-dsh-plugin.com`、`raw.githubusercontent.com`（`ALLOWED_HOSTS`）；
- 超时默认 20 秒（`marketTimeoutMs`），响应体上限 16 MiB；
- 响应必须是 JSON 且有非空 `items` 数组，否则当作"目录不可用"而不是半份数据；
- 失败会退回本地语料（`corpus.csv`），两者都没有就报错，不编造候选。

`POST /dsh-daily/market` 是唯一允许绕过缓存的路径——你点「刷新」时才会多发一次请求。

## 点「做这个」到底做了什么

`POST /dsh-daily/approve` → `approvalFor(body)` 在**当天的报告**里按 repo/标题找回条目
→ `spawnFor` → 新会话（`cwd = projectsRoot`），prompt 是 `src/deliver.js` 拼的契约：

- 明确禁止 `gh repo fork`、禁止 clone 别人的仓库再改；
- 要求在 `projectsRoot\<你自己的项目名>` 新建工程；
- 全部通过后执行 `gh repo create <名字> --public --source . --push`。

也就是说，**一次点击的终点是"你自己的公开仓库"**，而中间那一整轮开发由那个新会话的模型
自由发挥——它会不会真的按契约做，这个插件无法强制（它只递 prompt）。重复点击同一个条目
不会重复开会话：`approvals.jsonl` 里有 `spawned: true` 的同名记录时直接重放结果。

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **画像会被自动发给模型**：见上。没有脱敏、没有白名单、没有"先问我"。
2. **目录是第三方数据**：它能决定候选池里有什么（以及描述里写什么），插件只做形状校验，
   不校验内容真实性；星数/下载量来自目录，不是插件自己算的。
3. **`/run`、`/approve`、`/market` 没有独立鉴权**：能访问 DSH web server 的人可以触发一次
   付费模型调用、一次出站请求，或一次新会话（后者还要求匹配当天候选）。边界是宿主的
   web server，不是这个路由。
4. **新会话的能力边界由宿主决定**：`approve` 不额外收紧它的权限；如果那个 profile 是
   `danger-full-access`，它就能建公开仓库。这是你点之前要想清楚的一件事。
5. **日报不保证正确**：模型只被给了目录和画像，prompt 明确要求"宁可少选，不可凑数"，但它
   仍可能写出不准确的对比；`report.js` 只校验结构（条目数、字段、证据形状），不校验事实。
6. **重试用模型 token**：JSON 解析失败会再请求一次（最多若干次），每次都是一次真实调用。
7. **没有额度和成本上限**：日报每天一次、长度由 `maxTokens` 约束，但一天多跑几次（手动
   `/run`）就会多花几次。
8. **缓存不过期清理**：`market-cache.json`/`reports/` 只增不减，`historyKeep` 只管内存里
   的历史条数。

## 明确不算漏洞的

- **日报读你的记忆与 AGENTS.md**：这是它"按你这个人排序"的前提，见限制 1；
- **点「做这个」之后新会话建了公开仓库**：这是设计动作，也是你点的；
- **目录里有低质量/重复条目**：第三方数据，插件只做形状过滤；
- **面板/路由能触发模型调用**：和这个 profile 里其他插件一样的边界；
- **新会话没有按契约独立实现**：prompt 不是强制机制；
- **日报里的文本导致 XSS**：客户端用 `React.createElement` 渲染，没有 `innerHTML` /
  `dangerouslySetInnerHTML`。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-daily/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但我会读、会修，修完会在提交信息里写清影响面。
请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护 `main` 上的最新一版（当前 `0.3.0`，见 `package.json`），要求 DSH
`>=0.2.1-rc.2 <0.3.0`，Node 用宿主自带的版本。

> 注意：npm 上的 `dsh-daily`（`0.0.1`）**不是这个项目**，它的仓库指向别人；本仓库没有
> 发布到 npm。安装方式是把目录加进 profile。
