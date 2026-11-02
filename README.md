# FlClash 上游脚本合并器

把「上游作者维护的 FlClash 覆写脚本」和「你自己的分流规则」在构建期自动合并，
产出一条可直接导入 FlClash 的脚本 URL：**上游继续按 URL 更新，个人规则不会被覆盖。**

```
上游脚本 raw ──┐
               ├─ build.mjs ──> dist/merged.js ──> 你的 raw URL ──> FlClash
个人补丁 + 规则 ─┘        └─ test/smoke.mjs（33 项冒烟测试）
```

## 为什么需要它

FlClash 有两个硬限制，导致「跟随上游更新」和「保留个人分流」无法共存：

1. **一个 profile 只能挂一个脚本**（`profile.scriptId` 是单值），不能「上游脚本 + 我的脚本」两条并存；
2. **脚本模式下 App 的「全局规则」不生效**（`lib/providers/state/profile.dart` 只在 `extendType == standard` 时读取 `addedRules`），而 Merge/覆写类型只处理 DNS/TUN/sniffer，不能加规则。

所以直接改上游脚本副本会失去同步能力，不改又加不了自己的规则。本项目在**构建期**合并，两条需求都保留。

## 工作原理

`build.mjs` 做四件事：

| 步骤 | 内容 |
|---|---|
| 1. 拉取 | 从上游 raw 拉脚本（支持三级回退与重试） |
| 2. 校验 | 上游必须**恰好**出现 1 处 `function main(config)`，否则构建失败，不产出坏配置 |
| 3. 合并 | 把 `main` 改名 `__v61Main`，末尾追加 `patch/patch.js`；补丁重新定义 `main()`，先跑上游再注入个人规则 |
| 4. 验证 | 写 `dist/merged.js`，在 `vm` 里真跑一遍（33 项断言）后才会提交 |

四条关键保证：

- **不改上游一行**：只重命名入口函数，作者随便改内部逻辑都不冲突；
- **优先级固定**：个人规则 `splice(0, 0, …)` 原地前置，永远在上游规则之前，`MATCH` 仍由上游唯一提供；
- **失败隔离**：上游抛错 → 个人规则照常注入；个人补丁抛错 → 上游配置完好；
- **组名容错**：目标策略组不存在时按候选顺序回退或跳过，不会因上游改组名而 `proxy not found`。

## 特性

- 规则数据（域名）外置为 rule-provider：**改域名不用重建脚本**，FlClash 按 24h 周期自动拉取；
- 进程/IP 等 provider 放不下的规则走内联补丁；
- 去重：与上游完全相同的规则不会重复添加；
- 确定性构建：产物不含时间戳，上游与补丁都没变时**不会产生提交**；
- 自动跟随上游：默认每天 03:17 UTC 检查一次；
- 产物可匿名访问（仓库 public），不接触订阅、节点或任何凭据。

## 目录结构

| 路径 | 作用 |
|---|---|
| `build.mjs` | 拉上游 → 校验 → 合并 → 冒烟 → 输出 `dist/` |
| `patch/patch.js` | 个人补丁：包装入口 `main()`，注入 provider 与前置规则 |
| `rules/my-direct.yaml` | 强制直连域名（`behavior: domain` provider） |
| `rules/my-proxy.yaml` | 强制代理域名（`behavior: domain` provider） |
| `test/smoke.mjs` | 冒烟测试：`vm` 里真跑合并产物，校验规则位置 / MATCH / 目标组 / 回退 |
| `.github/workflows/build.yml` | 定时 + 手动 + 改动时自动重建并提交 `dist/` |
| `rebuild.ps1` / `rebuild.cmd` | 本机一键重建并推送（Actions 不可用时的备用通道） |
| `dist/` | 生成物：`merged.js`（FlClash 用）、`build-info.json`（上游版本与哈希） |

## 快速开始

> 仓库必须是 **public**：FlClash 匿名拉取 raw，私有库会 404。仓库里只有规则文本与上游脚本的合并产物，不含任何凭据或节点信息。

1. **Fork / 新建仓库**，把本项目全部文件上传（保留 `.github/` 路径）。
2. 仓库 **Settings → Actions → General → Workflow permissions** 选 **Read and write permissions**。
3. **Actions → build-merged-script → Run workflow**，等约 15 秒。
4. 确认 `dist/merged.js` 已提交，复制它的 Raw 地址：
   `https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/dist/merged.js`
5. FlClash → **配置 → 脚本 → 从 URL 导入**，粘贴上面的地址。
6. FlClash → 你的 profile → **扩展（Extend）→ 脚本** → 选中该脚本 → 应用配置。
7. 看日志确认注入成功：

```
[my-patch] dns hardened: nameserver=foreign DoH via 🚧 受限网站 fallback=cn policy=cn ipv6=off
[my-patch] v1.1.0 providers+2 rules+5 skipped=0 total=1379
[my-patch] proxy-policy=🎯 节点选择 download-policy=🚧 受限网站
```

8. 配置预览确认：第一条是 `RULE-SET,my-proxy,…`，最后一条是唯一的 `MATCH,…`。

## DNS 与 IPv6 收口

补丁默认会做一层 DNS 收口（`MY_DNS_HARDEN = true`），目的是：**让没被任何域名规则命中的域名也用可信 DNS 解析，避免被污染后又被 `GEOIP,CN` 误判成直连**，同时关掉 IPv6 减少绕过代理的通道。

| 字段 | 设置 | 原因 |
|---|---|---|
| `nameserver` | 境外 DoH（`dns.google` / `1.1.1.1`），带 `#下载组` 经代理连接 | 默认解析不被国内 DNS 污染 |
| `fallback` | 国内 DoH + `223.5.5.5` | 仅当境外解析失败时兜底，不参与污染判定 |
| `fallback-filter` | **删除** | 它把「非 CN 结果」视为污染并打回 fallback，与「境外主解析」直接冲突 |
| `nameserver-policy` | `rule-set:cn`、`+.cn` → 国内 DoH | 国内域名保持快解析与 CDN 就近 |
| `direct-nameserver` / `proxy-server-nameserver` | 国内 DoH | 直连目标解析、代理服务器域名解析 |
| `default-nameserver` | `223.5.5.5`、`119.29.29.29` | 纯 IP 引导 DoH 服务器自身解析 |
| `ipv6` / `dns.ipv6` | `false` | 避免 AAAA 解析把流量导向绕过代理的通道 |

代价与注意：

- 未命中域名首次解析会走境外 DoH（经代理），比国内 DNS 多 100–300 ms，之后由缓存覆盖；
- 代理不可用时，境外解析会失败并回退到国内 fallback（能上网，但可能拿到被污染结果）；
- **脚本只能关内核层的 IPv6**，系统网卡 / TUN 的 IPv6 仍需在 FlClash 与操作系统里同步关闭，否则仍可能有 IPv6 直连泄漏；
- 不想要这层收口就把 `MY_DNS_HARDEN` 改成 `false` 后重建。

## 定制

| 想改什么 | 改哪里 | 生效方式 |
|---|---|---|
| 直连 / 代理域名 | `rules/my-direct.yaml`、`rules/my-proxy.yaml` | push 后 24h 内自动拉取；急用可断开重连或「资源」页手动更新 provider |
| 进程规则、内联 IP | `patch/patch.js` 的 `MY_INLINE_RULES` | push → Actions 重建（~15 秒）→ FlClash 点「同步」 |
| 强制代理的目标组 | `MY_PROXY_POLICY_CANDIDATES`（按顺序取第一个存在的组） | 同上 |
| provider 下载走的组 | `MY_DOWNLOAD_POLICY_CANDIDATES` | 同上 |
| 补丁版本号（日志标识） | `MY_PATCH_VERSION` | 同上 |
| 上游版本 | 仓库 Settings → Variables 新建 `V61_URL` 指向指定 commit | 下次构建生效 |

**去重原则**：上游已经写过的规则不要在补丁里重复。重复写不会报错，但会让这些流量提前绕过上游的广告与安全规则，同时增加两份维护成本。当前补丁只保留上游没有的三类：V61 无进程规则的游戏（VALORANT/Riot）、V61 只写了 `QQ.exe` 而缺的 `QQNT.exe`、本机工具进程。

## 更新与维护

| 场景 | 操作 |
|---|---|
| 上游更新 | 无需动手：每日定时构建；FlClash 到脚本页点「同步」 |
| 自己改了规则/补丁 | push 即可；规则类不用重建脚本，补丁类由 Actions 重建 |
| 想立刻重建 | Actions → Run workflow；或本机跑 `rebuild.cmd` |
| 想降低构建频率 | 改 `build.yml` 的 cron，例如每周三次 `0 3 * * 1,3,5` |
| 临时回滚 | FlClash 里把脚本切回上游原 URL |

## 验证与排错

| 现象 | 处理 |
|---|---|
| Actions 构建失败「上游脚本结构变了」 | 上游改了入口函数：用 `V61_URL` 钉旧版，或调整 `build.mjs` 的 `MAIN_SIGNATURE` |
| 日志里没有 `[my-patch]` | profile 没选中该脚本；或填的是上游原版 URL 而不是 `dist/merged.js` |
| `proxy not found` | 补丁已做存在性校验；若仍出现，检查 `patch/patch.js` 里手改的策略名拼写（含 emoji 与空格） |
| provider 404 | 仓库非 public、`rules/` 未上传，或 `RULES_BASE` 不对（查看 `dist/build-info.json` 的 `rulesBase`） |
| 改了规则但没生效 | provider 按 interval 拉取（默认 24h），或 raw CDN 有几分钟缓存 |
| 想确认产物被替换过 | 看 `dist/build-info.json` 的 `upstreamVersion` / `upstreamSha256` |

本地自检（Node 20+）：

```powershell
$env:RULES_BASE='https://raw.githubusercontent.com/<owner>/<repo>/main/rules'
node build.mjs                      # 含冒烟测试
node test/smoke.mjs dist/merged.js  # 只跑冒烟测试
```

离线调试：把上游脚本存到本地，设 `$env:V61_FILE='C:\path\FlClash-V61.js'` 即可跳过网络。

## 设计边界

- 个人规则位于最终规则列表**最前面**，因此这些域名/进程不受上游广告与安全规则约束；只放确实需要的条目，不要把整段国内域名表搬进来。
- rule-provider 的下载走代理组（默认 `🚧 受限网站`），否则墙内无法拉取 raw.githubusercontent。
- 上游与补丁任一环节失败都不会拖垮另一环节；最坏情况是退回"只有上游脚本"的行为。
- 空订阅（无 `proxy-groups`）时补丁整体跳过，避免生成非法引用。

## 许可

- 上游脚本版权归其作者所有；`dist/merged.js` 包含上游代码，按其许可证（GPL-3.0）使用与分发。
- 本仓库提供的构建脚本、补丁与规则示例仅用于合并与个人分流演示，请自行确认上游使用条款。
