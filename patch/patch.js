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
//   VM 出口隔离       → 本文件 MY_VM_ENABLE / MY_VM_SRC_CIDRS（按源 IP 强制 VM 走代理）
//   自建节点          → 仓库 Secret SELF_NODES_JSON（不在本文件里，见 README）
// =====================================================================

var MY_PATCH_VERSION = "1.3.0";

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
// VM 出口：优先跟随宿主机总控组（与宿主/Claude 账号地区一致），找不到再退
var MY_VM_POLICY_CANDIDATES = [
  "🎯 节点选择",
  "🏠 自建节点",
  "🚀 自动优选",
  "🐟 漏网之鱼"
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
    var vmPolicy = myPick_(MY_VM_POLICY_CANDIDATES, policySet);
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
    myLog_(
      "vm: src=" + MY_VM_SRC_CIDRS.join("|") + " policy=" + (myPick_(MY_VM_POLICY_CANDIDATES, policySet) || "(none)")
    );
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
var MY_SELF_ICON = "https://fastly.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Static.png";

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
  return result;
}
