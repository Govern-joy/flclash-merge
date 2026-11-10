// =====================================================================
// 个人补丁 v1.2.0 —— 由 build.mjs 自动追加到上游 FlClash-V61.js 末尾
//
// 执行链：build.mjs 把上游 main() 改名为 __v61Main()
//         → 本文件重新定义 main()：上游 → 个人规则/DNS → 自建节点
//
// 改动指引：
//   域名/IP 清单      → rules/my-direct.yaml · rules/my-proxy.yaml（改完即生效，无需重建）
//   进程/内联规则     → 本文件 MY_INLINE_RULES（需重建）
//   策略组目标        → 本文件 MY_*_POLICY_CANDIDATES（按顺序取第一个存在的组）
//   DNS/IPv6          → 本文件 MY_DNS_HARDEN / MY_DNS_OFF_IPV6
//   VM 出口隔离       → 本文件 MY_VM_*（按源 IP 强制 VM 走「🖥️ VM 出口」组）
//   VM 出口组         → 本文件 MY_VM_GROUP_*（位置固定在 ⚖️ 负载均衡 之后）
//   AI 分组细分       → 本文件 MY_AI_SPLIT（🤖 Claude / 🤖 OpenAI / 🤖 其他 AI）
//   GitHub 分组       → 本文件 MY_GITHUB_SPLIT（从 🛠️ 工具与服务 拆出 GitHub，配 GitHub 图标）
//   自建节点          → 仓库 Secret SELF_NODES_JSON（不在本文件里，见 README）
// =====================================================================

var MY_PATCH_VERSION = "1.8.0";

// build.mjs 会把 __RULES_BASE__ 替换成仓库 rules 目录的 raw 地址
var MY_RULES_BASE = "__RULES_BASE__";
// 拼接写法：避免 build 的全文替换把这段自检也一起替换掉
var MY_RULES_BASE_MARK = "__RULES_" + "BASE__";

var MY_PROXY_PROVIDER = "my-proxy";
var MY_DIRECT_PROVIDER = "my-direct";
var MY_PROVIDER_INTERVAL = 86400; // rule-provider 拉取间隔（秒）

// 「强制走代理」目标组：按顺序取第一个真实存在的
var MY_PROXY_POLICY_CANDIDATES = [
  "🎯 节点选择",
  "🚀 自动优选",
  "🐟 漏网之鱼",
  "Proxies",
  "Final"
];

// provider 自身的下载走哪个组（墙内直连 raw.githubusercontent 不可用）
var MY_DOWNLOAD_POLICY_CANDIDATES = [
  "🚧 受限网站",
  "🎯 节点选择",
  "🐟 漏网之鱼"
];

// ---------------------------------------------------------------------
// 虚拟机出口隔离（Claude VM）
//
// 背景：VM 经 Hyper-V Default Switch 访问宿主机 FlClash 的混合端口
// （172.28.0.1:7897），连接在宿主机上按「规则模式」分流。若不处理，
// VM 访问国内站点会命中上游的 DOMAIN-SUFFIX,cn / GEOIP,CN → DIRECT，
// 于是出口 IP 是宿主机的真实公网 IP。
//
// 做法：把 SRC-IP-CIDR 规则放在整份规则最前面，按来源地址把 VM 的流量
// 直接送进指定策略组。宿主机自身流量源地址是 198.18.0.1（TUN）或
// 127.0.0.1（系统代理），不在此网段，因此宿主机分流不受影响。
//
// 注意：
//   · 只约束经过混合端口的流量；VM 里绕过系统代理的应用/协议仍可能直连，
//     要绝对保证需在 VM 侧用防火墙只放行宿主代理端口。
//   · Default Switch 的网段在宿主机重启后可能变化，故同时配置当前 VM 的
//     /32 与 Default Switch 的 /20 网段；VM IP 变化时更新 MY_VM_SRC_CIDRS。
// ---------------------------------------------------------------------
var MY_VM_ENABLE = true;
// 当前 VM 实际 IP（ARP 看到的是 172.28.0.2）
var MY_VM_SRC_CIDRS = [
  "172.28.0.2/32",
  "172.28.0.0/20",
  "172.28.48.0/20"
];
// VM 出口：规则先按候选组落地，随后 injectVmGroup() 会把 SRC-IP-CIDR 的目标
// 统一改到「🖥️ VM 出口」选择器（放在 ⚖️ 负载均衡 之后），由你在代理页选节点。
// 这里的候选仅作兜底（VM 组创建失败时使用）。
var MY_VM_POLICY_CANDIDATES = [
  "🏠 自建节点",
  "🎯 节点选择",
  "🚀 自动优选",
  "🐟 漏网之鱼"
];

// VM 出口业务组：一个普通 select 组，候选克隆自标准业务组（剔除直连/拦截策略），
// 放在 ⚖️ 负载均衡 之后；SRC-IP-CIDR 规则统一指向它。
var MY_VM_GROUP_ENABLE = true;
var MY_VM_GROUP_NAME = "🖥️ VM 出口";
var MY_VM_GROUP_ANCHOR = "⚖️ 负载均衡";
var MY_VM_GROUP_NODES_SRC = "🛜 全部节点";
var MY_VM_GROUP_ICON = "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Windows_11.png";

// ---------------------------------------------------------------------
// AI 服务组细分：🤖 AI 服务 → 🤖 Claude / 🤖 OpenAI / 🤖 其他 AI
//
// 做法（在 V61 全部注入完成之后执行，只改结果、不改上游逻辑）：
//   1. 用原 AI 组的候选克隆出 🤖 Claude、🤖 OpenAI 两个 select 组
//      （自建节点注入在本步之前完成，因此新组候选同样包含 🏠 自建节点）；
//   2. 原组原地改名 🤖 其他 AI（不重建组对象，保持引用与位置）；
//   3. 扫描规则：指向原 AI 组的规则按内容重定向
//        claude / anthropic                          → 🤖 Claude
//        openai / chatgpt / oaistatic / oaiusercontent /
//        sora.com / livekit.cloud / statsigapi.net   → 🤖 OpenAI
//        其余（gemini / copilot / grok / perplexity / huggingface…）→ 🤖 其他 AI
//   4. 再补少量精确域名规则，保证两家主干域名必中新组（防上游规则集改名）。
// ---------------------------------------------------------------------
var MY_AI_SPLIT = true;
var MY_AI_GROUP_SRC = "🤖 AI 服务";
var MY_AI_GROUP_OTHER = "🤖 其他 AI";
var MY_AI_GROUP_CLAUDE = "🤖 Claude";
var MY_AI_GROUP_OPENAI = "🤖 OpenAI";
var MY_AI_CLAUDE_RE = /(claude|anthropic)/i;
var MY_AI_OPENAI_RE = /(openai|chatgpt|oaistatic|oaiusercontent|sora\.com|livekit\.cloud|statsigapi\.net)/i;
var MY_AI_CLAUDE_DOMAINS = ["claude.ai", "claude.com", "claudeusercontent.com", "anthropic.com"];
var MY_AI_OPENAI_DOMAINS = ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "sora.com"];

// ---------------------------------------------------------------------
// GitHub 分组：从 🛠️ 工具与服务 拆出独立的 GitHub（组名不带 emoji，配 GitHub 图标）
//
// 做法：克隆 TOOLS 组候选（自建节点注入之后执行 → 含 🏠 自建节点）建新组；
//       只重定向「域名类规则 / RULE-SET,github」，进程规则保持不动
//       （上游有 PROCESS-NAME,com.github.metacubex.clash.meta → 工具组，
//        那是 Clash 客户端进程，不属于 GitHub 流量）。
// ---------------------------------------------------------------------
var MY_GITHUB_SPLIT = true;
var MY_GITHUB_GROUP_SRC = "🛠️ 工具与服务";
var MY_GITHUB_GROUP_NEW = "GitHub";
var MY_GITHUB_ICON = "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/GitHub.png";
var MY_GITHUB_RULE_RE = /github/i;
var MY_GITHUB_DOMAINS = [
  "github.com",
  "github.io",
  "githubusercontent.com",
  "githubassets.com",
  "github.blog",
  "githubstatus.com",
  "github.dev",
  "ghcr.io"
];

// ---------------------------------------------------------------------
// DNS / IPv6 收口：境外 DoH 主解析 + 国内 DNS 失败兜底 + 关闭 IPv6
//
// 为什么不用「国内主 + 境外 fallback」：国内 DNS 会返回被污染的地址，
// 未命中域名可能因此被 GEOIP,CN 判成直连，直接绕过代理。
//
//   nameserver        境外 DoH，带 #下载组 经代理连接
//   fallback          国内 DNS，仅解析失败时使用
//   fallback-filter   删除（它会把非 CN 结果打回 fallback，与主解析冲突）
//   nameserver-policy rule-set:cn / +.cn 仍走国内 DNS，保 CDN 就近
//   default-nameserver 纯 IP，用于引导 DoH 域名自身解析
// ---------------------------------------------------------------------
var MY_DNS_HARDEN = true;
var MY_DNS_OFF_IPV6 = true;

var MY_CN_DNS = ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query", "223.5.5.5"];
var MY_FOREIGN_DNS = ["https://dns.google/dns-query", "https://1.1.1.1/dns-query"];
var MY_BOOTSTRAP_DNS = ["223.5.5.5", "119.29.29.29"];

// ---------------------------------------------------------------------
// 内联规则：provider 只能放域名/IP，进程类只能写在这里
// 格式：类型,匹配值,策略名[,no-resolve]
//
// 只补上游没有的。上游已覆盖 WeChat / QQ.exe / private 网段，重复添加
// 只会让这些流量提前绕过上游的广告与安全规则。
// ---------------------------------------------------------------------
var MY_INLINE_RULES = [
  // VALORANT / Riot 走 UDP，上游只有域名规则 → 会进「国外游戏」代理，延迟高
  "PROCESS-NAME-REGEX,(?i)^(VALORANT|RiotClient|RiotClientServices|vgc|vgtray)\\.exe$,DIRECT",
  // 新版 QQ 进程名是 QQNT.exe，上游只写了 QQ.exe
  "PROCESS-NAME,QQNT.exe,DIRECT",
  // 本机工具：上游无对应进程规则
  "PROCESS-NAME-REGEX,(?i)^DeepSeek Harness(\\.exe)?$,DIRECT"
];

// 内置策略名：不在 proxy-groups 里也算合法目标
var MY_BUILTIN_POLICIES = {
  DIRECT: true,
  REJECT: true,
  "REJECT-DROP": true,
  PASS: true,
  "PASS-RULE": true,
  COMPATIBLE: true,
  GLOBAL: true
};

function myLog_(msg) {
  try {
    log("[my-patch] " + msg);
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
}

// 收集所有可用策略名：内置策略 + 实际存在的 proxy-groups
function myPolicySet_(config) {
  var set = {};
  var k;
  for (k in MY_BUILTIN_POLICIES) {
    if (Object.prototype.hasOwnProperty.call(MY_BUILTIN_POLICIES, k)) {
      set[k] = true;
    }
  }
  var groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (g && g.name) set[g.name] = true;
  }
  return set;
}

// 按候选顺序取第一个存在的策略名，都没有则返回 null
function myPick_(candidates, policySet) {
  for (var i = 0; i < candidates.length; i++) {
    if (policySet[candidates[i]]) return candidates[i];
  }
  return null;
}

// 注册 my-direct / my-proxy 两个 rule-provider，返回新增数量
function myEnsureProviders_(config, downloadPolicy) {
  if (!config["rule-providers"] || typeof config["rule-providers"] !== "object") {
    config["rule-providers"] = {};
  }
  var defs = [
    [MY_DIRECT_PROVIDER, "my-direct.yaml"],
    [MY_PROXY_PROVIDER, "my-proxy.yaml"]
  ];
  var added = 0;
  for (var i = 0; i < defs.length; i++) {
    var id = defs[i][0];
    if (config["rule-providers"][id]) continue;
    var provider = {
      type: "http",
      behavior: "domain",
      format: "yaml",
      url: MY_RULES_BASE + "/" + defs[i][1],
      path: "./ruleset/" + id + ".yaml",
      interval: MY_PROVIDER_INTERVAL
    };
    // 不指定 proxy 时 mihomo 走 DIRECT，墙内会拉取失败
    if (downloadPolicy) provider.proxy = downloadPolicy;
    config["rule-providers"][id] = provider;
    added++;
  }
  return added;
}

// DNS / IPv6 收口，返回 1 表示已处理
function myHardenDns_(config, downloadPolicy) {
  if (!config.dns || typeof config.dns !== "object") {
    myLog_("DNS 收口跳过：配置里没有 dns 段");
    return 0;
  }
  var tag = downloadPolicy ? "#" + downloadPolicy : "";
  var i;

  // 默认解析走境外 DoH（经代理）
  config.dns["nameserver"] = MY_FOREIGN_DNS.map(function (item) {
    return item + tag;
  });

  // 国内 DNS 仅作失败兜底
  config.dns["fallback"] = MY_CN_DNS.slice();

  // 与「境外主解析」冲突，删除
  if (config.dns["fallback-filter"]) delete config.dns["fallback-filter"];

  // 引导 DNS：纯 IP，用于解析 DoH 服务器域名
  config.dns["default-nameserver"] = MY_BOOTSTRAP_DNS.slice();

  // 国内域名仍走国内 DNS；已存在的 policy 不覆盖
  if (!config.dns["nameserver-policy"] || typeof config.dns["nameserver-policy"] !== "object") {
    config.dns["nameserver-policy"] = {};
  }
  var policy = config.dns["nameserver-policy"];
  var cnPolicyKeys = ["rule-set:cn", "+.cn"];
  for (i = 0; i < cnPolicyKeys.length; i++) {
    if (!policy[cnPolicyKeys[i]]) policy[cnPolicyKeys[i]] = MY_CN_DNS.slice();
  }

  // 直连目标与代理服务器自身解析保持国内
  config.dns["direct-nameserver"] = MY_CN_DNS.slice();
  config.dns["direct-nameserver-follow-policy"] = true;
  config.dns["proxy-server-nameserver"] = MY_CN_DNS.slice();

  // 关 IPv6：避免 AAAA 解析绕过代理
  if (MY_DNS_OFF_IPV6) {
    config.ipv6 = false;
    config.dns.ipv6 = false;
  }

  myLog_(
    "dns hardened: nameserver=" +
      (downloadPolicy ? "foreign DoH via " + downloadPolicy : "foreign DoH (direct)") +
      " fallback=cn policy=cn ipv6=" +
      (MY_DNS_OFF_IPV6 ? "off" : "on")
  );
  return 1;
}

// 生成待前置的个人规则（顺序即最终优先级）
function myBuildRules_(config, policySet) {
  var rules = [];

  // 虚拟机出口隔离：必须排在最前，覆盖后面所有直连/进程规则
  if (MY_VM_ENABLE) {
    // 自建节点组是在 injectSelfNode() 里创建的，晚于本函数执行；
    // 这里按 SELF_NODES 提前把它算作可用，否则 VM 会错误地回退到 🎯 节点选择。
    var vmPolicySet = policySet;
    if (typeof MY_SELF_GROUP === "string" && Array.isArray(MY_SELF_NODES)) {
      for (var s = 0; s < MY_SELF_NODES.length; s++) {
        if (MY_SELF_NODES[s] && MY_SELF_NODES[s].name) {
          vmPolicySet[MY_SELF_GROUP] = true;
          break;
        }
      }
    }
    var vmPolicy = myPick_(MY_VM_POLICY_CANDIDATES, vmPolicySet);
    if (vmPolicy) {
      for (var v = 0; v < MY_VM_SRC_CIDRS.length; v++) {
        rules.push("SRC-IP-CIDR," + MY_VM_SRC_CIDRS[v] + "," + vmPolicy);
      }
    } else {
      myLog_("vm: 未找到可用策略组，跳过 VM 出口隔离");
    }
  }

  // 强制代理：放最前，可覆盖后面的直连/进程规则
  var proxyPolicy = myPick_(MY_PROXY_POLICY_CANDIDATES, policySet);
  if (proxyPolicy) {
    rules.push("RULE-SET," + MY_PROXY_PROVIDER + "," + proxyPolicy);
  } else {
    myLog_("找不到可用的强制代理组，跳过 my-proxy");
  }

  // 内联规则：目标组不存在就跳过，避免 proxy not found 导致整份配置加载失败
  for (var i = 0; i < MY_INLINE_RULES.length; i++) {
    var rule = MY_INLINE_RULES[i];
    var parts = rule.split(",");
    var target = parts.length >= 3 ? parts[2] : "";
    if (!target || !policySet[target]) {
      myLog_("跳过内联规则（目标组不存在: " + target + "）: " + rule);
      continue;
    }
    rules.push(rule);
  }

  // 个人直连清单
  rules.push("RULE-SET," + MY_DIRECT_PROVIDER + ",DIRECT");

  return rules;
}

function injectMyPatch(config) {
  if (!config || typeof config !== "object") return config;
  if (!Array.isArray(config["proxy-groups"]) || config["proxy-groups"].length === 0) {
    myLog_("没有 proxy-groups，跳过个人补丁");
    return config;
  }
  if (!Array.isArray(config.rules)) config.rules = [];
  if (String(MY_RULES_BASE).indexOf(MY_RULES_BASE_MARK) !== -1) {
    myLog_("MY_RULES_BASE 未配置，已跳过个人补丁（先跑一次 build.mjs）");
    return config;
  }

  var policySet = myPolicySet_(config);
  var downloadPolicy = myPick_(MY_DOWNLOAD_POLICY_CANDIDATES, policySet);
  var providerAdded = myEnsureProviders_(config, downloadPolicy);
  var rules = myBuildRules_(config, policySet);
  if (MY_DNS_HARDEN) myHardenDns_(config, downloadPolicy);
  if (MY_VM_ENABLE) {
    // 从实际生成的规则里取目标组，避免日志与真实规则不一致
    var vmLogPolicy = "(none)";
    for (var ri = 0; ri < rules.length; ri++) {
      if (String(rules[ri]).indexOf("SRC-IP-CIDR,") === 0) {
        var vp = String(rules[ri]).split(",");
        vmLogPolicy = vp.length >= 3 ? vp[2] : "(none)";
        break;
      }
    }
    myLog_("vm: src=" + MY_VM_SRC_CIDRS.join("|") + " policy=" + vmLogPolicy);
  }

  // 倒序前置：结果是原顺序，且保持 config.rules 引用不变（QuickJS FFI 要求）
  var added = 0;
  var skipped = 0;
  for (var i = rules.length - 1; i >= 0; i--) {
    var r = rules[i];
    if (config.rules.indexOf(r) !== -1) {
      skipped++;
      continue;
    }
    config.rules.splice(0, 0, r);
    added++;
  }

  myLog_(
    "v" +
      MY_PATCH_VERSION +
      " providers+" +
      providerAdded +
      " rules+" +
      added +
      " skipped=" +
      skipped +
      " total=" +
      config.rules.length
  );
  myLog_(
    "proxy-policy=" +
      (myPick_(MY_PROXY_POLICY_CANDIDATES, policySet) || "(none)") +
      " download-policy=" +
      (downloadPolicy || "(direct)")
  );
  return config;
}

// =====================================================================
// 自建节点补丁
// 在 __v61Main 之后执行，节点不参与上游地区归类与自动测速
// =====================================================================

// 节点数据由 build.mjs 从环境变量 SELF_NODES_JSON 注入（来源：GitHub Actions Secret）。
// 仓库里只有这个占位符，凭据不会进入公开代码。增删改节点见 README。
var MY_SELF_NODES = __SELF_NODES_JSON__;

var MY_SELF_GROUP = "🏠 自建节点"; // 策略组名
var MY_SELF_ANCHOR = "🛜 全部节点"; // 组与候选都紧跟这个组
var MY_SELF_MASTER = "🎯 节点选择"; // 总控组
var MY_SELF_ICON = "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Server.png";

// 自建节点专属规则：插到最前面，命中后走自建组
// 格式：类型,匹配值,策略 —— 策略留空自动填 MY_SELF_GROUP
var MY_SELF_RULES = [
  // "DOMAIN-SUFFIX,claude.ai,",
  // "DOMAIN-SUFFIX,openai.com,",
];

// 把 value 移到 anchor 之后；anchor 不存在则追加到末尾
function mySelfInsertAfter_(arr, anchor, value) {
  var i = arr.indexOf(value);
  if (i !== -1) arr.splice(i, 1);
  var a = arr.indexOf(anchor);
  if (a === -1) arr.push(value);
  else arr.splice(a + 1, 0, value);
}

function injectSelfNode(config) {
  if (!config || typeof config !== "object") return config;
  var groups = config["proxy-groups"];
  if (!Array.isArray(groups)) return config;
  var i, j;

  // 1) 注入节点（同名跳过，支持重复加载）
  if (!Array.isArray(config.proxies)) config.proxies = [];
  var names = [];
  for (i = 0; i < MY_SELF_NODES.length; i++) {
    var n = MY_SELF_NODES[i];
    if (!n || !n.name) continue;
    names.push(n.name);
    var found = false;
    for (j = 0; j < config.proxies.length; j++) {
      if (config.proxies[j] && config.proxies[j].name === n.name) { found = true; break; }
    }
    if (!found) config.proxies.push(JSON.parse(JSON.stringify(n)));
  }
  if (!names.length) { myLog_("self-node: 列表为空，跳过"); return config; }

  // 2) 建组，插到锚点之后
  var group = { name: MY_SELF_GROUP, type: "select", proxies: names, icon: MY_SELF_ICON };
  var gi = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_SELF_GROUP) { gi = i; break; }
  }
  if (gi !== -1) groups.splice(gi, 1);
  var anchorIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_SELF_ANCHOR) { anchorIdx = i; break; }
  }
  if (anchorIdx === -1) groups.push(group);
  else groups.splice(anchorIdx + 1, 0, group);

  // 3) 总控组 + 各业务组的候选：同样紧跟锚点
  var bizNames = Object.values(BIZ);
  var touched = 0;
  for (i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g || !g.name || !Array.isArray(g.proxies)) continue;
    if (g.name === MY_SELF_GROUP) continue;
    if (g.name !== MY_SELF_MASTER && bizNames.indexOf(g.name) === -1) continue;
    mySelfInsertAfter_(g.proxies, MY_SELF_ANCHOR, MY_SELF_GROUP);
    touched++;
  }

  // 4) 服务器 IP 直连：否则 TUN 会把到自建节点的流量交给机场（机场通常封 22，会切断 SSH）
  //    有 VM 出口规则时 rules[0] 是 SRC-IP-CIDR，这里插到 0 号位正好让服务器直连优先级最高
  var insertAt = String(config.rules[0] || "").indexOf("RULE-SET,my-proxy") === 0 ? 1 : 0;
  var seenServer = {};
  for (i = 0; i < MY_SELF_NODES.length; i++) {
    var srv = MY_SELF_NODES[i] && MY_SELF_NODES[i].server;
    if (!srv || seenServer[srv]) continue;
    seenServer[srv] = 1;
    var bypass = "IP-CIDR," + srv + "/32,DIRECT,no-resolve";
    if (config.rules.indexOf(bypass) === -1) {
      config.rules.splice(insertAt, 0, bypass);
      insertAt++;
    }
  }

  // 5) 专属规则：倒序前置，保持数组引用不变
  var added = 0;
  for (i = MY_SELF_RULES.length - 1; i >= 0; i--) {
    var raw = String(MY_SELF_RULES[i] || "").trim();
    if (!raw) continue;
    var parts = raw.split(",");
    if (parts.length >= 3 && !parts[2].trim()) parts[2] = MY_SELF_GROUP;
    var rule = parts.join(",");
    if (config.rules.indexOf(rule) === -1) { config.rules.splice(0, 0, rule); added++; }
  }

  myLog_("self-node: nodes=" + names.length + " groups=" + touched + " rules=" + added);
  return config;
}

// =====================================================================
// AI 服务细分：🤖 AI 服务 → 🤖 Claude / 🤖 OpenAI / 🤖 其他 AI
// 在自建节点注入之后执行，克隆候选时能带上 🏠 自建节点
// =====================================================================

// 取规则的目标策略名（兼容 ,no-resolve / ,src 结尾）
function myRulePolicy_(rule) {
  var parts = String(rule || "").split(",");
  if (parts.length < 2) return "";
  var last = parts[parts.length - 1].trim().toLowerCase();
  if (last === "no-resolve" || last === "src") {
    return parts.length >= 3 ? parts[parts.length - 2].trim() : "";
  }
  return parts[parts.length - 1].trim();
}

// 组图标：仓库 icons/ 下的 PNG，通过 jsDelivr 提供（与 Qure 图标同为大陆可达 CDN）。
// URL 由 MY_RULES_BASE 推导，fork 仓库后无需改地址。
function myAssetUrl_(relPath) {
  var base = String(MY_RULES_BASE || "");
  var m = base.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
  if (m) {
    return "https://fastly.jsdelivr.net/gh/" + m[1] + "/" + m[2] + "@" + m[3] + "/" + relPath;
  }
  return base.replace(/\/rules\/?$/, "") + "/" + relPath;
}
var MY_AI_ICON_CLAUDE_PATH = "icons/claude.png";
var MY_AI_ICON_OPENAI_PATH = "icons/openai.png";
var MY_AI_ICON_OTHER = "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AI.png";

function injectAiSplit(config) {
  if (!MY_AI_SPLIT) return config;
  if (!config || !Array.isArray(config["proxy-groups"])) return config;
  var groups = config["proxy-groups"];
  var i;
  var srcIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_AI_GROUP_SRC) { srcIdx = i; break; }
  }
  if (srcIdx === -1) {
    myLog_("ai-split: 未找到 " + MY_AI_GROUP_SRC + "，跳过");
    return config;
  }

  var srcGroup = groups[srcIdx];
  var candidates = Array.isArray(srcGroup.proxies) ? srcGroup.proxies.slice() : [];

  // 1) 原组原地改名（保持组对象引用与位置）；图标换成通用 AI 图标
  srcGroup.name = MY_AI_GROUP_OTHER;
  srcGroup.icon = MY_AI_ICON_OTHER;

  // 2) 清理重复加载时残留的新组
  for (i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    if (groups[i].name === MY_AI_GROUP_CLAUDE || groups[i].name === MY_AI_GROUP_OPENAI) groups.splice(i, 1);
  }

  // 3) 两个新组插在「其他 AI」之后
  var otherIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_AI_GROUP_OTHER) otherIdx = i;
  }
  if (otherIdx === -1) otherIdx = groups.length - 1;

  var claudeGroup = {
    name: MY_AI_GROUP_CLAUDE,
    type: "select",
    proxies: candidates.slice(),
    icon: myAssetUrl_(MY_AI_ICON_CLAUDE_PATH)
  };
  var openaiGroup = {
    name: MY_AI_GROUP_OPENAI,
    type: "select",
    proxies: candidates.slice(),
    icon: myAssetUrl_(MY_AI_ICON_OPENAI_PATH)
  };
  groups.splice(otherIdx + 1, 0, claudeGroup, openaiGroup);

  // 4) 规则重定向（原 AI 组 → 三个新组）
  var rules = Array.isArray(config.rules) ? config.rules : [];
  var counts = { claude: 0, openai: 0, other: 0 };
  for (var r = 0; r < rules.length; r++) {
    if (typeof rules[r] !== "string") continue;
    if (myRulePolicy_(rules[r]) !== MY_AI_GROUP_SRC) continue;
    var parts = rules[r].split(",");
    var pIdx = parts.length - 1;
    var tail = parts[pIdx].trim().toLowerCase();
    if (tail === "no-resolve" || tail === "src") pIdx = parts.length - 2;
    var target = MY_AI_GROUP_OTHER;
    if (MY_AI_CLAUDE_RE.test(rules[r])) target = MY_AI_GROUP_CLAUDE;
    else if (MY_AI_OPENAI_RE.test(rules[r])) target = MY_AI_GROUP_OPENAI;
    parts[pIdx] = target;
    rules[r] = parts.join(",");
    if (target === MY_AI_GROUP_CLAUDE) counts.claude++;
    else if (target === MY_AI_GROUP_OPENAI) counts.openai++;
    else counts.other++;
  }

  // 5) 精确域名兜底：插在 my-proxy 规则之前（高于上游 AI 规则）
  var extra = [];
  for (i = 0; i < MY_AI_CLAUDE_DOMAINS.length; i++) {
    extra.push("DOMAIN-SUFFIX," + MY_AI_CLAUDE_DOMAINS[i] + "," + MY_AI_GROUP_CLAUDE);
  }
  for (i = 0; i < MY_AI_OPENAI_DOMAINS.length; i++) {
    extra.push("DOMAIN-SUFFIX," + MY_AI_OPENAI_DOMAINS[i] + "," + MY_AI_GROUP_OPENAI);
  }
  var insertAt = 0;
  for (i = 0; i < rules.length; i++) {
    if (String(rules[i]).indexOf("RULE-SET,my-proxy,") === 0) {
      insertAt = i;
      break;
    }
  }
  for (i = extra.length - 1; i >= 0; i--) {
    if (rules.indexOf(extra[i]) === -1) rules.splice(insertAt, 0, extra[i]);
  }

  myLog_(
    "ai-split: " + MY_AI_GROUP_CLAUDE + "=" + counts.claude +
      " " + MY_AI_GROUP_OPENAI + "=" + counts.openai +
      " " + MY_AI_GROUP_OTHER + "=" + counts.other +
      " extra=" + extra.length
  );
  return config;
}

// =====================================================================
// GitHub 分组：从 🛠️ 工具与服务 拆出 GitHub（独立图标，组名不带 emoji）
// 在自建节点注入之后执行，克隆候选时能带上 🏠 自建节点
// =====================================================================
function injectGithubSplit(config) {
  if (!MY_GITHUB_SPLIT) return config;
  if (!config || !Array.isArray(config["proxy-groups"])) return config;
  var groups = config["proxy-groups"];
  var i;
  var srcIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_GITHUB_GROUP_SRC) { srcIdx = i; break; }
  }
  if (srcIdx === -1) {
    myLog_("github-split: 未找到 " + MY_GITHUB_GROUP_SRC + "，跳过");
    return config;
  }

  var srcGroup = groups[srcIdx];
  var candidates = Array.isArray(srcGroup.proxies) ? srcGroup.proxies.slice() : [];

  // 1) 清理重复加载时残留的新组
  for (i = groups.length - 1; i >= 0; i--) {
    if (groups[i] && groups[i].name === MY_GITHUB_GROUP_NEW) groups.splice(i, 1);
  }

  // 2) 新组插在「工具与服务」之后
  var toolsIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_GITHUB_GROUP_SRC) toolsIdx = i;
  }
  if (toolsIdx === -1) toolsIdx = groups.length - 1;
  var githubGroup = { name: MY_GITHUB_GROUP_NEW, type: "select", proxies: candidates.slice(), icon: MY_GITHUB_ICON };
  groups.splice(toolsIdx + 1, 0, githubGroup);

  // 3) 重定向规则：域名类规则 / RULE-SET,github；进程规则保持不动
  var rules = Array.isArray(config.rules) ? config.rules : [];
  var redirected = 0;
  for (var r = 0; r < rules.length; r++) {
    if (typeof rules[r] !== "string") continue;
    if (myRulePolicy_(rules[r]) !== MY_GITHUB_GROUP_SRC) continue;
    var type = String(rules[r]).split(",")[0].trim().toUpperCase();
    if (type.indexOf("PROCESS") === 0) continue;
    var matched = type === "RULE-SET"
      ? /,github(,|$)/i.test(rules[r])
      : MY_GITHUB_RULE_RE.test(rules[r]);
    if (!matched) continue;
    var parts = rules[r].split(",");
    var pIdx = parts.length - 1;
    var tail = parts[pIdx].trim().toLowerCase();
    if (tail === "no-resolve" || tail === "src") pIdx = parts.length - 2;
    parts[pIdx] = MY_GITHUB_GROUP_NEW;
    rules[r] = parts.join(",");
    redirected++;
  }

  // 4) 精确域名兜底：插在 my-proxy 规则之前
  var extra = [];
  for (i = 0; i < MY_GITHUB_DOMAINS.length; i++) {
    extra.push("DOMAIN-SUFFIX," + MY_GITHUB_DOMAINS[i] + "," + MY_GITHUB_GROUP_NEW);
  }
  var insertAt = 0;
  for (i = 0; i < rules.length; i++) {
    if (String(rules[i]).indexOf("RULE-SET,my-proxy,") === 0) {
      insertAt = i;
      break;
    }
  }
  for (i = extra.length - 1; i >= 0; i--) {
    if (rules.indexOf(extra[i]) === -1) rules.splice(insertAt, 0, extra[i]);
  }

  myLog_("github-split: rules=" + redirected + " extra=" + extra.length + " -> " + MY_GITHUB_GROUP_NEW);
  return config;
}

// =====================================================================
// VM 出口业务组：把 SRC-IP-CIDR 的出口集中到「🖥️ VM 出口」选择器
// 组放在 ⚖️ 负载均衡 之后；候选剔除 DIRECT/REJECT 等，避免误选导致 VM 直连泄漏
// =====================================================================
function injectVmGroup(config) {
  if (!MY_VM_GROUP_ENABLE) return config;
  if (!config || !Array.isArray(config["proxy-groups"])) return config;
  var groups = config["proxy-groups"];
  var i;

  // 1) 候选：常用选择/自动组 + 全部节点（可直接选单个节点），剔除内置策略
  var preferred = [
    "🎯 节点选择",
    "🚀 自动优选",
    "⚡ 极速自动",
    "🛟 自动兜底",
    "♻️ 自动选择",
    "🏠 自建节点",
    "⚖️ 负载均衡"
  ];
  var raw = [];
  var j;
  for (j = 0; j < preferred.length; j++) raw.push(preferred[j]);
  var hasAllNodes = false;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_VM_GROUP_NODES_SRC && Array.isArray(groups[i].proxies)) {
      for (j = 0; j < groups[i].proxies.length; j++) raw.push(groups[i].proxies[j]);
      hasAllNodes = true;
      break;
    }
  }
  // 兜底：没有「全部节点」组时直接用 config.proxies
  if (!hasAllNodes) {
    var proxiesArr = Array.isArray(config.proxies) ? config.proxies : [];
    for (i = 0; i < proxiesArr.length; i++) {
      if (proxiesArr[i] && proxiesArr[i].name) raw.push(proxiesArr[i].name);
    }
  }

  // 过滤：去掉内置策略 / 不存在的名字 / 重复项
  var groupNames = {};
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name) groupNames[groups[i].name] = true;
  }
  var proxyNames = {};
  var allProxies = Array.isArray(config.proxies) ? config.proxies : [];
  for (i = 0; i < allProxies.length; i++) {
    if (allProxies[i] && allProxies[i].name) proxyNames[allProxies[i].name] = true;
  }
  var seen = {};
  var candidates = [];
  for (i = 0; i < raw.length; i++) {
    var policy = raw[i];
    if (!policy || policy === MY_VM_GROUP_NAME) continue;
    if (MY_BUILTIN_POLICIES[policy]) continue;
    if (seen[policy]) continue;
    if (!groupNames[policy] && !proxyNames[policy]) continue;
    seen[policy] = true;
    candidates.push(policy);
  }
  if (!candidates.length) {
    myLog_("vm-group: 未找到可用的候选（组或节点），跳过");
    return config;
  }

  // 2) 去重 + 建组，插在 ⚖️ 负载均衡 之后（找不到就插在 🛜 全部节点 之后/末尾）
  for (i = groups.length - 1; i >= 0; i--) {
    if (groups[i] && groups[i].name === MY_VM_GROUP_NAME) groups.splice(i, 1);
  }
  var vmGroup = { name: MY_VM_GROUP_NAME, type: "select", proxies: candidates, icon: MY_VM_GROUP_ICON };
  var anchorIdx = -1;
  for (i = 0; i < groups.length; i++) {
    if (groups[i] && groups[i].name === MY_VM_GROUP_ANCHOR) anchorIdx = i;
  }
  if (anchorIdx === -1) {
    for (i = 0; i < groups.length; i++) {
      if (groups[i] && groups[i].name === MY_SELF_ANCHOR) anchorIdx = i;
    }
  }
  if (anchorIdx === -1) groups.push(vmGroup);
  else groups.splice(anchorIdx + 1, 0, vmGroup);

  // 3) SRC-IP-CIDR 规则统一指向新组
  var rules = Array.isArray(config.rules) ? config.rules : [];
  var retargeted = 0;
  for (var r = 0; r < rules.length; r++) {
    if (typeof rules[r] !== "string") continue;
    if (String(rules[r]).indexOf("SRC-IP-CIDR,") !== 0) continue;
    var parts = rules[r].split(",");
    var pIdx = parts.length - 1;
    var tail = parts[pIdx].trim().toLowerCase();
    if (tail === "no-resolve" || tail === "src") pIdx = parts.length - 2;
    if (parts[pIdx] !== MY_VM_GROUP_NAME) {
      parts[pIdx] = MY_VM_GROUP_NAME;
      rules[r] = parts.join(",");
      retargeted++;
    }
  }

  myLog_(
    "vm-group: " + MY_VM_GROUP_NAME + " candidates=" + candidates.length + " retargeted=" + retargeted
  );
  return config;
}

// =====================================================================
// 包装入口：上游 → 个人规则 → 自建节点；任一环失败不影响其他环节
// =====================================================================
function main(config) {
  var result = config;
  try {
    result = __v61Main(config) || config;
  } catch (e) {
    myLog_("上游 V61 执行失败，仍继续注入个人补丁: " + e);
  }
  try {
    injectMyPatch(result);
  } catch (e) {
    myLog_("个人补丁注入失败: " + e);
  }
  try {
    injectSelfNode(result);
  } catch (e) {
    myLog_("自建节点注入失败: " + e);
  }
  try {
    injectAiSplit(result);
  } catch (e) {
    myLog_("AI 分组细分失败: " + e);
  }
  try {
    injectGithubSplit(result);
  } catch (e) {
    myLog_("GitHub 分组失败: " + e);
  }
  try {
    injectVmGroup(result);
  } catch (e) {
    myLog_("VM 出口组失败: " + e);
  }
  return result;
}
