# FlClash 脚本合并器

把 **上游覆写脚本** + **个人分流规则** + **自建节点** 在构建期合并成一条可直接导入 FlClash 的脚本 URL。

上游继续按 URL 更新，个人配置不会被覆盖；公开仓库里不出现任何节点凭据。

```
上游脚本 ──┐
个人补丁 ──┼─ build.mjs ─┬─ dist/merged.js（通用版）──> 提交进仓库（public）
自建节点 ──┘   （Secret）  └─ dist/merged.js（带节点）──> secret gist ──> FlClash
```

## 为什么需要它

FlClash 的两个限制让「跟随上游更新」和「保留个人分流」无法共存：

1. 一个 profile 只能挂**一个**脚本，不能「上游 + 我的」并存；
2. 脚本模式下 App 的「全局规则」不生效，Merge/覆写类型只能改 DNS/TUN，加不了规则。

所以本项目在**构建期**合并：上游照常更新，个人规则与节点在合并时注入。

## 工作流程

| 阶段 | 内容 |
|---|---|
| 1. 拉取 | 从上游 raw 取脚本，三级回退 + 重试 |
| 2. 校验 | 上游必须**恰好**有 1 处 `function main(config)`，否则构建失败 |
| 3. 合并 | 上游 `main` 改名 `__v61Main`，末尾追加 `patch/patch.js`；补丁重定义 `main()` 并按序执行：上游 → 个人规则 → 自建节点 |
| 4. 冒烟 | 在 `vm` 里真跑一遍产物，40+ 项断言；不通过就拒绝提交 |
| 5. 分发 | 先构建**无节点版**提交仓库；再用 Secret 构建**带节点版** PATCH 到 secret gist |

## 快速开始

> 仓库必须 **public**，FlClash 才能匿名拉取 raw。公开仓库里只有脚本与规则，没有凭据。

1. **Fork** 本仓库，保留 `.github/`、`patch/`、`rules/`、`test/`。
2. Settings → Actions → General → Workflow permissions → **Read and write**。
3. 建一个 **secret gist**（gist.github.com，默认就是 secret），文件名 `merged.js`，内容随意占位。
4. 配置三个 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 内容 |
|---|---|
| `SELF_NODES_JSON` | 自建节点 JSON 数组，见下节；不填则跳过节点注入 |
| `GIST_ID` | 第 3 步 gist URL 末尾那串 ID |
| `GIST_TOKEN` | 有 `gist` 权限的 PAT（建议 fine-grained，仅 gist:write） |

5. Actions → `build-merged-script` → **Run workflow**。
6. FlClash → 配置 → `+` → 从 URL 导入：

```
https://gist.githubusercontent.com/<用户名>/<GIST_ID>/raw/merged.js
```

> 直接用仓库的 `dist/merged.js` raw 地址也可以，但那是**无节点版**，不含 `🏠 自建节点` 组。

## 自建节点

节点数据只存在于 Secret 与 gist 产物里，仓库中是一个占位符（`__SELF_NODES_JSON__`）。

**格式**：标准 Clash 代理对象数组，支持 vless / vmess / trojan / hysteria2 等。

```json
[
  {
    "name": "🇲🇾 吉隆坡-自建",
    "type": "vless",
    "server": "1.2.3.4",
    "port": 443,
    "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "udp": true,
    "tls": true,
    "network": "tcp",
    "servername": "www.bing.com",
    "client-fingerprint": "chrome",
    "reality-opts": {
      "public-key": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "short-id": "1234abcd"
    }
  }
]
```

| 操作 | 做法 |
|---|---|
| 加节点 | 数组里追加一项 |
| 删节点 | 删掉该项；全删则跳过注入，不报错 |
| 换节点 | 改 `server` / `port` / `uuid` 等字段，`name` 不变即可 |
| 加规则 | 改 `patch/patch.js` 的 `MY_SELF_RULES`，策略留空自动指向自建组 |

注入后的效果：

- 生成 `🏠 自建节点`（select 组），位置紧跟 `🛜 全部节点`
- 该组同时挂进 `🎯 节点选择` 与 34 个业务组候选
- 每个节点的 `server` 自动加一条 `IP-CIDR,<ip>/32,DIRECT`，避免 TUN 把管理流量交给机场
- 节点**不参与**上游地区归类与自动测速，机场节点异常不会连带影响它

> ⚠️ **改 Secret 不会自动触发构建**。改完要手动跑一次 workflow，或等每日 03:17 UTC 定时构建。

## 个人规则

| 位置 | 内容 | 生效方式 |
|---|---|---|
| `rules/my-proxy.yaml` | 强制走代理的域名 | 推送后 FlClash 按 24h 拉取，改域名无需重建 |
| `rules/my-direct.yaml` | 强制直连的域名 | 同上 |
| `patch/patch.js` 的 `MY_INLINE_RULES` | 进程名、少量 IP（provider 放不下） | 需重建 |
| `patch/patch.js` 的 `MY_SELF_RULES` | 指定走自建节点的域名 | 需重建 |

个人规则会被**前置**到规则列表最前面，优先级高于上游。因此只放确实需要的条目——写多了会让这些流量提前绕过上游的广告与安全规则。

## DNS 与 IPv6

补丁默认做一层收口（`MY_DNS_HARDEN = true`）：境外 DoH 主解析 + 国内 DNS 失败兜底 + 关闭 IPv6。

目的：避免未命中域名被国内 DNS 污染后又被 `GEOIP,CN` 判成直连。

代价：未命中域名首次解析会绕经代理，多 100–300ms，之后走缓存。

不想要就把 `MY_DNS_HARDEN` / `MY_DNS_OFF_IPV6` 改成 `false`。

> 脚本只能关内核层 IPv6；系统网卡与 TUN 的 IPv6 需要在 FlClash 和操作系统里另外关。

## 维护

| 场景 | 操作 |
|---|---|
| 跟随上游 | 自动，每日定时构建 |
| 改规则 | 推送即生效（provider 24h 内拉取），或手动更新 provider |
| 改节点 | 改 `SELF_NODES_JSON` → 手动跑 workflow |
| 立即重建 | Actions → Run workflow |
| 回滚 | FlClash 里把脚本切回上游原 URL，或撤回提交 |
| 确认产物 | 看 `dist/build-info.json` 的 `upstreamVersion` / `upstreamSha256` |

本地构建（Node 20+）：

```powershell
$env:RULES_BASE = 'https://raw.githubusercontent.com/<owner>/<repo>/main/rules'
$env:SELF_NODES_JSON = '[]'      # 可选，不设则视为空
node build.mjs                    # 含冒烟测试
```

## 排错

| 现象 | 原因与处理 |
|---|---|
| 构建失败「上游脚本结构变了」 | 上游改了入口函数：用 Variables `V61_URL` 钉旧版本 |
| 日志里没有 `[my-patch]` | profile 没选中脚本，或填的是上游原 URL |
| `proxy not found` | 手写的策略名拼错（注意 emoji 与空格） |
| provider 404 | 仓库非 public，或 `rules/` 缺失 |
| 改了规则没生效 | provider 按 24h 拉取，或 raw CDN 有几分钟缓存 |
| gist 里没有节点 | 没配 `SELF_NODES_JSON`，或没手动跑 workflow |
| 节点连不上 | 检查 `uuid` / `public-key` / `short-id` 三元组是否与服务端一致 |

## 安全模型

- **公开仓库零凭据**：节点通过 Secret 注入，`dist/merged.js` 里是空数组 `[]`。
- **gist URL 等同于密码**：secret gist 不做鉴权，任何拿到链接的人都能读取产物（含节点）。
- **泄露处理**：轮换服务端凭据（uuid / REALITY 密钥对 / short-id）→ 更新 Secret → 重跑 workflow，旧参数立即失效。
- **PAT 权限最小化**：`GIST_TOKEN` 只需要 `gist` 写权限，不要复用带 repo/workflow 的 OAuth token。
- **历史提交不可忽视**：提交进 git 的内容即使删掉仍可追溯，凭据一旦入库必须轮换，不能只删文件。

## 许可

- 上游脚本版权归原作者，`dist/merged.js` 含其代码，按上游许可证（GPL-3.0）使用与分发。
- 本仓库的构建脚本、补丁与规则仅用于合并与个人分流演示，请自行确认上游条款。
