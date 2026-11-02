# flclash-merge — 上游 V61 + 个人分流补丁 的自动合并流水线

解决一个 FlClash 的硬限制：**一个 profile 只能挂一个脚本，而脚本模式下 App 的「全局规则」根本不生效**
（源码 `lib/providers/state/profile.dart`：只有 `extendType == standard` 才读取 `addedRules`）。

所以本项目的思路是：上游 V61 仍然通过 URL 跟随作者更新，你的个人规则在**构建时**注入进去，
产出一个**你自己的 raw URL**，FlClash 只填这一个地址。作者更新、你的需求，两头都不丢。

```
作者 raw ──┐
           ├─ build.mjs ─ 改名 main → 追加包装 main → 校验 → dist/merged.js ─→ 你的 raw URL ─→ FlClash
你的补丁 ──┘                    └─ test/smoke.mjs（33 项，vm 里真跑一遍）
```

## 我的实例（已建好）

| 项目 | 地址 |
|---|---|
| 仓库 | https://github.com/Govern-joy/flclash-merge |
| **FlClash 脚本 URL（用这个）** | `https://raw.githubusercontent.com/Govern-joy/flclash-merge/main/dist/merged.js` |
| 规则 provider 目录 | `https://raw.githubusercontent.com/Govern-joy/flclash-merge/main/rules/` |
| 构建信息（上游版本/sha256） | `https://raw.githubusercontent.com/Govern-joy/flclash-merge/main/dist/build-info.json` |

更新方式二选一：

- **GitHub Actions**（推荐）：push `patch/**`、`rules/**`、`build.mjs` 自动重建；上游更新靠每日 03:17 UTC 定时任务。需要先授予 GitHub CLI 的 `workflow` scope 才能提交 `.github/workflows/build.yml`。
- **本地一键重建**（Actions 未启用时）：在本目录跑 `pwsh -File .\rebuild.ps1`，拉上游 → 构建 → 冒烟测试 → 提交推送 `dist/`，再去 FlClash 点「同步」。

## 目录

| 路径 | 作用 |
|---|---|
| `build.mjs` | 拉上游 → 把 `function main(config)` 改名 `__v61Main` → 末尾拼接补丁 → 校验 → 输出 `dist/merged.js` + `dist/build-info.json`，自动跑冒烟测试 |
| `patch/patch.js` | 个人补丁：重新定义 `main()`，先跑上游 `__v61Main`，再把个人规则**原地前置**到 rules 最前 |
| `rules/my-direct.yaml` | 个人直连清单（46 条，`behavior: domain` 的 rule-provider） |
| `rules/my-proxy.yaml` | 个人强制代理清单（anysearch，2 条） |
| `test/smoke.mjs` | 冒烟测试：在 `vm` 里真跑一遍合并产物，检查规则位置、MATCH 唯一性、策略组存在性、缺组回退 |
| `.github/workflows/build.yml` | 每天 03:17 UTC + 手动 + 修改 patch/rules 时自动重建并提交 `dist/` |
| `dist/` | 生成物：`merged.js`（给 FlClash 用）+ `build-info.json`（上游版本/sha256/规则地址） |

## 为什么不会跟丢上游更新

1. **改名法，不改上游一行**：只把 `function main(config)` 替换成 `function __v61Main(config)`，补丁在文件末尾重新定义 `main()` 包装。作者随便改内部逻辑，合并都不会冲突。
2. **结构校验**：上游必须恰好出现 1 处 `function main(config)`，否则构建直接失败（不会产出坏配置）。
3. **规则优先级固定**：个人规则 `splice(0, 0, …)` 原地前置，永远在 V61 一切规则之前；`MATCH` 仍由 V61 唯一提供，只追加不覆盖。
4. **组名容错**：目标组不存在时自动回退或跳过并打日志，不会因为作者改了 emoji/组名就 `proxy not found` 整份配置加载失败。
5. **provider 走代理下载**：`proxy: 🚧 受限网站`，墙内拉 raw.githubusercontent 才拉得动。

## 一次性配置（约 10 分钟）

1. 新建一个 GitHub 仓库（**必须 public**，否则 FlClash 拉不到 raw），例如 `flclash-merge`。
2. 把本目录上传上去，注意 `.github/workflows/build.yml` 的路径要保留（Web 上传也支持）。
3. 仓库 **Settings → Actions → General → Workflow permissions** → 选 **Read and write permissions** → Save。
4. **Actions** 页 → 左侧 `build-merged-script` → **Run workflow**（分支 main）。
5. 等 1 分钟，`dist/merged.js` 会被自动提交。打开它 → **Raw** → 复制地址。
6. FlClash → **配置 → 脚本 → 从 URL 导入** → 粘贴第 5 步的地址。
7. 你的 profile → **扩展（Extend）→ 脚本** → 选中它 → 应用配置。
8. 看 FlClash 日志，应出现：`[my-patch] v1.0.0 providers+2 rules+8 skipped=0 total=…`
9. 配置预览里确认：第一条是 `RULE-SET,my-proxy,🎯 节点选择`，最后一条是唯一 `MATCH,🐟 漏网之鱼`。

## 日常维护

| 场景 | 要做什么 |
|---|---|
| 上游 V61 更新 | 无需动手：Action 每天 03:17 UTC 自动重建并提交；FlClash 到脚本页点**同步**（或「资源」页批量更新），重连生效 |
| 增删直连/代理域名 | 只改 `rules/*.yaml` 并 commit，**不用等 Action**：FlClash 按 provider `interval`（24h）自动拉；想立刻生效就断开重连或到「资源」页手动更新该 provider |
| 改进程规则 / 策略组映射 | 改 `patch/patch.js` → push 触发 Action 重建 `dist/` |
| 想钉住上游某个版本 | 仓库 Settings → Variables → 新建 `V61_URL`，填某个 commit 的 raw 地址，Action 会使用它 |
| 作者改了入口函数导致构建失败 | 看报错里的 `MAIN_SIGNATURE`；先把 `V61_URL` 钉到能用的旧版，再适配 |

## 本地调试（可选，Node 20+）

```powershell
cd flclash-merge
$env:RULES_BASE='https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/rules'
node build.mjs                      # 含冒烟测试
node test/smoke.mjs dist/merged.js  # 只跑冒烟测试
```

离线调试（用本地保存的上游副本，不联网）：

```powershell
$env:V61_FILE='C:\path\to\FlClash-V61.js'
```

## 规则清单说明

- `my-direct.yaml`（46 条）：Steam 下载/CDN 13、EDA/PCB 8、校园网/学习 7、WPS/金山 8、其他常用域名。
  其中一部分（如 `lceda.cn`、`szu.edu.cn`、`wps.cn`）其实已被 V61 的 `RULE-SET,cn` 覆盖，
  属于"保险"，嫌冗余可放心删。
- `my-proxy.yaml`（2 条）：`anysearch` —— 工具链路不能被 `GEOIP,CN`/`🐟 漏网之鱼` 兜成直连。
- 进程与 IP 规则内联在 `patch/patch.js` 的 `MY_INLINE_RULES`：VALORANT/Riot、WeChat/QQNT、DeepSeek Harness、校园网 `/32`。
  （provider 只支持域名/IP 类，进程规则必须内联。）

## 排错

| 现象 | 处理 |
|---|---|
| 构建失败「上游脚本结构变了」 | 作者改了入口：用 `V61_URL` 钉旧版，或改 `build.mjs` 的 `MAIN_SIGNATURE` |
| 启动日志没有 `[my-patch]` | profile 没选中这个脚本；或填的是作者原版 URL，不是你的 `dist/merged.js` |
| `proxy not found` | 补丁已做存在性校验；若仍报错，检查是否手改过 `patch/patch.js` 的策略名 |
| provider 404 | 仓库不是 public / `rules/` 没上传 / `RULES_BASE` 不对（看 `dist/build-info.json` 的 `rulesBase`） |
| 想临时回滚 | FlClash 里把脚本换回作者原 URL 即可，个人需求丢失但不影响上网 |

## 说明

- 本流水线只托管脚本与规则文本，不含任何订阅或凭据；GitHub Actions 使用仓库默认 `GITHUB_TOKEN`，权限仅限本仓库。
- `dist/` 是生成物，会在每次构建时被覆盖；想改逻辑请改 `patch/`、`rules/`、`build.mjs`。
