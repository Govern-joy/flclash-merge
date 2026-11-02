// =====================================================================
// MY-PATCH v1.0.0 —— 个人分流补丁（自动拼接到上游 FlClash-V61.js 末尾）
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
// =====================================================================

var MY_PATCH_VERSION = "1.0.0";

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
// 内联规则：provider 只支持域名/IP 类规则，进程类必须写在这里
// 格式：类型,匹配值,策略名[,no-resolve]
// ---------------------------------------------------------------------
var MY_INLINE_RULES = [
  // 游戏：进程直连（VALORANT / Riot 走 UDP，只能靠进程识别）
  "PROCESS-NAME-REGEX,(?i)^(VALORANT|RiotClient|RiotClientServices|vgc|vgtray)\\.exe$,DIRECT",
  // 通讯：V61 已有精确进程规则，这里补版本变体（QQNT / WeChatAppEx）
  "PROCESS-NAME-REGEX,(?i)^(WeChat|Weixin|WeChatAppEx)\\.exe$,DIRECT",
  "PROCESS-NAME-REGEX,(?i)^QQ(NT)?\\.exe$,DIRECT",
  // 本机工具
  "PROCESS-NAME-REGEX,(?i)^DeepSeek Harness(\\.exe)?$,DIRECT",
  // 校园网 / 内网（V61 的 GEOIP,private 已覆盖，这里只做显式兜底）
  "IP-CIDR,172.30.255.42/32,DIRECT,no-resolve",
  "IP-CIDR,172.31.80.14/32,DIRECT,no-resolve"
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
