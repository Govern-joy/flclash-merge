// =====================================================================
// MY-PATCH v1.1.0 —— 个人分流补丁（自动拼接到上游 FlClash-V61.js 末尾）
//
// 工作方式：
//   1. build.mjs 把上游的 `function main(config)` 改名为 `function __v61Main(config)`
//      并把本文件追加到文件末尾；
//   2. 本文件末尾重新定义 `main(config)`：先跑上游 V61，再注入个人补丁；
//   3. 个人规则以「原地前置」的方式插到 rules 最前面（不改 MATCH，不重建数组）。
//
// 改哪里：
//   · 域名 / IP 清单  -> rules/my-direct.yaml · rules/my-proxy.yaml（改了即生效，无需重新构建）
//   · 进程类 / 少量 IP -> 本文件 MY_INLINE_RULES（改了要等 Action 重新构建）
//   · 目标策略组      -> 本文件 MY_*_POLICY_CANDIDATES（按顺序取第一个存在的组）
//   · DNS / IPv6 收口 -> 本文件 MY_DNS_HARDEN（false 可整体关闭）
// =====================================================================

var MY_PATCH_VERSION = "1.1.0";

// build.mjs 会把 __RULES_BASE__ 替换成你自己仓库的 rules 目录 raw 地址
var MY_RULES_BASE = "__RULES_BASE__";
// 用拼接写法，避免 build 的全文替换把这段校验也一起替换掉
var MY_RULES_BASE_MARK = "__RULES_" + "BASE__";

var MY_PROXY_PROVIDER = "my-proxy";
var MY_DIRECT_PROVIDER = "my-direct";
var MY_PROVIDER_INTERVAL = 86400; // 秒；rule-provider 多久拉一次

// 「强制走代理」的目标组：按顺序取第一个在配置里真实存在的
var MY_PROXY_POLICY_CANDIDATES = [
  "🎯 节点选择",
  "🚀 自动优选",
  "🐟 漏网之鱼",
  "Proxies",
  "Final"
];

// rule-provider 自身的下载走哪个组（raw.githubusercontent.com 在墙内直连不到）
var MY_DOWNLOAD_POLICY_CANDIDATES = [
  "🚧 受限网站",
  "🎯 节点选择",
  "🐟 漏网之鱼"
];

// ---------------------------------------------------------------------
// DNS / IPv6 收口（默认开启；不想要就把 MY_DNS_HARDEN 改成 false）
//
// 目标：让「没被任何域名规则命中」的域名也用可信 DNS 解析，避免被污染后
// 又被 GEOIP,CN 误判成直连；同时关掉 IPv6，减少绕过代理的通道。
//
// 设计（与「国内主 + 境外 fallback」相反，这里是「境外主 + 国内失败兜底」）：
//   · nameserver        = 境外 DoH，经代理下载组连接（#组名），解析结果不被国内 DNS 污染
//   · fallback          = 国内 DNS，仅在内核解析失败时使用（不参与污染判定）
//   · fallback-filter   = 删除。它把「非 CN 结果」视为污染并打回 fallback，
//                         与「境外主解析」直接冲突，留着会把境外域名打回国内 DNS
//   · nameserver-policy = 国内域名（rule-set:cn / +.cn）继续走国内 DNS，保速度与 CDN 就近
//   · direct-nameserver = 国内 DNS（直连目标用）
//   · default-nameserver= 国内纯 IP，用于引导 DoH 服务器自身域名解析
// ---------------------------------------------------------------------
var MY_DNS_HARDEN = true;
var MY_DNS_OFF_IPV6 = true;

var MY_CN_DNS = ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query", "223.5.5.5"];
var MY_FOREIGN_DNS = ["https://dns.google/dns-query", "https://1.1.1.1/dns-query"];
var MY_BOOTSTRAP_DNS = ["223.5.5.5", "119.29.29.29"];

// ---------------------------------------------------------------------
// 内联规则：provider 只支持域名/IP 类规则，进程类必须写在这里
// 格式：类型,匹配值,策略名[,no-resolve]
//
// 去重原则：V61 已经写过的规则不再重复。当前 V61 已覆盖且这里不重复的：
//   · PROCESS-NAME,WeChat.exe / Weixin.exe / WeChatAppEx.exe → DIRECT
//   · PROCESS-NAME,QQ.exe → DIRECT（这里只补新版 QQNT.exe）
//   · GEOIP,private / GEOSITE,private → DIRECT（校园网 172.16/12 已含）
// 重复添加只会让这些流量提前绕过 V61 的广告与安全规则。
// ---------------------------------------------------------------------
var MY_INLINE_RULES = [
  // 游戏：进程直连（VALORANT / Riot 走 UDP，只能靠进程识别；
  // V61 只有域名规则 → 会送进「🕹️ 国外游戏」= 代理，对局延迟高）
  "PROCESS-NAME-REGEX,(?i)^(VALORANT|RiotClient|RiotClientServices|vgc|vgtray)\\.exe$,DIRECT",
  // 通讯：V61 只有精确的 QQ.exe，新版 QQ 是 QQNT.exe，这里补差集
  "PROCESS-NAME,QQNT.exe,DIRECT",
  // 本机工具：V61 没有对应进程规则
  "PROCESS-NAME-REGEX,(?i)^DeepSeek Harness(\\.exe)?$,DIRECT"
];

// 内置策略名（不属于 proxy-groups 也算合法目标）
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

function myPick_(candidates, policySet) {
  for (var i = 0; i < candidates.length; i++) {
    if (policySet[candidates[i]]) return candidates[i];
  }
  return null;
}

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
    // 不写 proxy 时 mihomo 默认走 DIRECT；墙内拉 raw 会失败，所以优先走代理组
    if (downloadPolicy) provider.proxy = downloadPolicy;
    config["rule-providers"][id] = provider;
    added++;
  }
  return added;
}

// DNS / IPv6 收口：境外主解析 + 国内失败兜底 + 关 IPv6
function myHardenDns_(config, downloadPolicy) {
  if (!config.dns || typeof config.dns !== "object") {
    myLog_("DNS 收口跳过：配置里没有 dns 段");
    return 0;
  }
  var tag = downloadPolicy ? "#" + downloadPolicy : "";
  var i;

  // 1) 默认解析走境外 DoH（经代理），避免未命中域名被国内 DNS 污染
  config.dns["nameserver"] = MY_FOREIGN_DNS.map(function (item) {
    return item + tag;
  });

  // 2) 国内 DNS 只做失败兜底
  config.dns["fallback"] = MY_CN_DNS.slice();

  // 3) 删除与「境外主解析」冲突的污染过滤器（否则非 CN 结果会被打回 fallback）
  if (config.dns["fallback-filter"]) delete config.dns["fallback-filter"];

  // 4) 引导 DNS：用纯 IP 解析 DoH 服务器自身
  config.dns["default-nameserver"] = MY_BOOTSTRAP_DNS.slice();

  // 5) 国内域名继续走国内 DNS（policy 已存在则不覆盖，保留上游更细的条目）
  if (!config.dns["nameserver-policy"] || typeof config.dns["nameserver-policy"] !== "object") {
    config.dns["nameserver-policy"] = {};
  }
  var policy = config.dns["nameserver-policy"];
  var cnPolicyKeys = ["rule-set:cn", "+.cn"];
  for (i = 0; i < cnPolicyKeys.length; i++) {
    if (!policy[cnPolicyKeys[i]]) policy[cnPolicyKeys[i]] = MY_CN_DNS.slice();
  }

  // 6) 直连解析/代理服务器自身解析保持国内（上游本来如此，这里防止被改坏）
  config.dns["direct-nameserver"] = MY_CN_DNS.slice();
  config.dns["direct-nameserver-follow-policy"] = true;
  config.dns["proxy-server-nameserver"] = MY_CN_DNS.slice();

  // 7) 关 IPv6：避免 AAAA 解析把流量导向绕过代理的通道
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

function myBuildRules_(config, policySet) {
  var rules = [];

  // 1. 强制代理（放最前，能盖住后面所有直连/进程规则）
  var proxyPolicy = myPick_(MY_PROXY_POLICY_CANDIDATES, policySet);
  if (proxyPolicy) {
    rules.push("RULE-SET," + MY_PROXY_PROVIDER + "," + proxyPolicy);
  } else {
    myLog_("找不到可用的强制代理组，跳过 my-proxy");
  }

  // 2. 内联规则：策略名不存在就跳过，避免 proxy not found 导致整份配置加载失败
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

  // 3. 个人直连清单
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

  var added = 0;
  var skipped = 0;
  // 倒序 splice(0,0,...) = 原地前置，保持数组引用不变（QuickJS FFI 要求）
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

// ---------------------------------------------------------------------
// 包装入口：先跑上游 V61，再注入个人补丁；任何一步失败都不影响另一块
// ---------------------------------------------------------------------
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
  return result;
}
