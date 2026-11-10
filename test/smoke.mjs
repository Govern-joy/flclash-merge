#!/usr/bin/env node
// =====================================================================
// 冒烟测试：在 Node 的 vm 里真跑一遍合并后的脚本，验证：
//   · 个人 provider / 规则是否正确注入且排在最前
//   · MATCH 是否唯一且在最后
//   · 所有规则的目标策略组是否真实存在（防 proxy not found）
//   · 目标组缺失时的回退逻辑是否生效
// 用法: node test/smoke.mjs [dist/merged.js]
// =====================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] || path.join(ROOT, "dist", "merged.js"));

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function parsePolicy(rule) {
  if (typeof rule !== "string") return "";
  const parts = rule.split(",");
  if (parts.length < 2) return "";
  if (parts[0].toUpperCase() === "MATCH") return parts[1].trim();
  return (parts[2] || "").trim();
}

const BUILTIN = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

async function runScript() {
  const code = await readFile(target, "utf8");
  const logs = [];
  const sandbox = {
    console: {
      log: (...args) => logs.push(args.map((item) => String(item)).join(" ")),
      warn: (...args) => logs.push(args.map((item) => String(item)).join(" ")),
      error: (...args) => logs.push(args.map((item) => String(item)).join(" ")),
    },
    print: (...args) => logs.push(args.map((item) => String(item)).join(" ")),
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "merged.js", timeout: 120000 });
  return { sandbox, logs, code };
}

function makeConfig() {
  const proxies = [
    { name: "🇭🇰 香港 01", type: "ss", server: "198.51.100.10", port: 443, cipher: "aes-128-gcm", password: "pw" },
    { name: "🏡 香港家宽 01", type: "ss", server: "198.51.100.11", port: 443, cipher: "aes-128-gcm", password: "pw" },
    { name: "🇺🇸 美国 01", type: "ss", server: "198.51.100.12", port: 443, cipher: "aes-128-gcm", password: "pw" },
    { name: "🇯🇵 日本 01", type: "ss", server: "198.51.100.13", port: 443, cipher: "aes-128-gcm", password: "pw" },
  ];
  return {
    proxies,
    "proxy-groups": [{ name: "🔰 订阅默认", type: "select", proxies: proxies.map((p) => p.name) }],
    rules: ["DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,🔰 订阅默认"],
    dns: { nameserver: ["223.5.5.5"], fallback: ["8.8.8.8"], "fake-ip-filter": [] },
  };
}

async function main() {
  console.log(`[smoke] 目标文件: ${target}`);
  const { sandbox, logs, code } = await runScript();

  section("1. 合并产物自检");
  check("文件里没有残留占位符 __RULES_BASE__", !code.includes("__RULES_BASE__"));
  check("存在上游改名后的 __v61Main", code.includes("function __v61Main(config)"));
  check("存在包装后的 main", /function main\(config\)/.test(code));
  check("存在个人补丁函数 injectMyPatch", code.includes("function injectMyPatch(config)"));

  const mainFn = sandbox.main;
  check("main 是可调用函数", typeof mainFn === "function");
  if (typeof mainFn !== "function") return finish();

  section("2. 跑一遍上游 + 个人补丁");
  const config = makeConfig();
  let result;
  try {
    result = mainFn(config);
  } catch (error) {
    check("main(config) 不抛异常", false, error && error.message);
    return finish();
  }
  check("main(config) 不抛异常", true);
  check("返回值是对象", result && typeof result === "object");
  check("rules 是数组且非空", Array.isArray(result.rules) && result.rules.length > 0);

  const rules = result.rules || [];
  const groups = (result["proxy-groups"] || []).map((group) => group && group.name).filter(Boolean);
  const groupSet = new Set(groups);
  const policySet = new Set([...BUILTIN, ...groups]);
  const proxyNames = new Set((result.proxies || []).map((item) => item && item.name).filter(Boolean));
  const selfPresent = groupSet.has("🏠 自建节点");
  const providers = result["rule-providers"] || {};

  console.log(`  · 上游规则数: ${rules.length}，策略组数: ${groups.length}，provider 数: ${Object.keys(providers).length}`);

  section("3. 个人 provider");
  for (const id of ["my-direct", "my-proxy"]) {
    const provider = providers[id];
    check(`provider ${id} 存在`, Boolean(provider));
    if (!provider) continue;
    check(`provider ${id} 为 http 类型`, provider.type === "http");
    check(`provider ${id} behavior=domain`, provider.behavior === "domain");
    check(`provider ${id} url 是 http(s) 地址`, /^https?:\/\//.test(String(provider.url)));
    check(`provider ${id} 有本地缓存 path`, Boolean(provider.path));
    if (provider.proxy) {
      check(`provider ${id} 的下载组 "${provider.proxy}" 存在`, policySet.has(provider.proxy));
    }
  }

  section("4. 个人规则排在最前");
  const proxyRuleIndex = rules.findIndex((rule) => String(rule).startsWith("RULE-SET,my-proxy,"));
  check("存在 RULE-SET,my-proxy 规则", proxyRuleIndex !== -1, JSON.stringify(rules.slice(0, 5)));
  check("my-proxy 的策略组合法", policySet.has(parsePolicy(rules[proxyRuleIndex] || "")), parsePolicy(rules[proxyRuleIndex] || ""));

  const directIndex = rules.indexOf("RULE-SET,my-direct,DIRECT");
  check("存在 RULE-SET,my-direct,DIRECT", directIndex !== -1);

  const geoipCnIndex = rules.findIndex((rule) => String(rule).startsWith("GEOIP,CN,"));
  check("个人直连规则排在 GEOIP,CN 之前", directIndex !== -1 && geoipCnIndex !== -1 && directIndex < geoipCnIndex, `direct=${directIndex}, geoipCN=${geoipCnIndex}`);

  const inlineChecks = [
    ["VALORANT 进程直连", (rule) => rule.startsWith("PROCESS-NAME-REGEX") && /VALORANT/.test(rule)],
    ["QQNT 进程直连", (rule) => rule === "PROCESS-NAME,QQNT.exe,DIRECT"],
    ["DeepSeek Harness 进程直连", (rule) => rule.startsWith("PROCESS-NAME-REGEX") && /DeepSeek Harness/.test(rule)],
  ];
  for (const [name, matcher] of inlineChecks) {
    const idx = rules.findIndex((rule) => matcher(String(rule)));
    check(`${name}存在且前置`, idx !== -1 && idx < geoipCnIndex, `index=${idx}`);
  }

  section("4b. 虚拟机出口隔离");
  const vmCidrs = ["172.28.0.2/32", "172.28.0.0/20", "172.28.48.0/20"];
  const vmRules = rules.filter((rule) => String(rule).startsWith("SRC-IP-CIDR,"));
  check("VM 出口规则条数正确", vmRules.length === vmCidrs.length, JSON.stringify(vmRules));
  check(
    "VM 出口规则覆盖预期网段",
    vmCidrs.every((cidr) => vmRules.some((rule) => String(rule).startsWith(`SRC-IP-CIDR,${cidr},`))),
    JSON.stringify(vmRules)
  );
  const vmPolicy = parsePolicy(vmRules[0] || "");
  check("VM 出口策略组真实存在", policySet.has(vmPolicy), vmPolicy);
  check(
    "VM 出口策略不是直连/拦截",
    !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE"].includes(vmPolicy),
    vmPolicy
  );
  if (groupSet.has("🏠 自建节点")) {
    check("有自建节点时 VM 出口固定为自建组", vmPolicy === "🏠 自建节点", vmPolicy);
  } else {
    check("无自建节点时 VM 出口回退到节点选择", vmPolicy === "🎯 节点选择", vmPolicy);
  }
  check(
    "VM 规则排在 my-proxy 之前",
    vmRules.length > 0 && proxyRuleIndex !== -1 && rules.indexOf(vmRules[0]) < proxyRuleIndex,
    `vm=${rules.indexOf(vmRules[0] || "")}, proxy=${proxyRuleIndex}`
  );
  check(
    "VM 规则排在 GEOIP,CN 之前",
    vmRules.length > 0 && geoipCnIndex !== -1 && rules.indexOf(vmRules[0]) < geoipCnIndex,
    `vm=${rules.indexOf(vmRules[0] || "")}, geoipCN=${geoipCnIndex}`
  );

  section("4c. AI 分组细分");
  const aiClaude = "🤖 Claude";
  const aiOpenai = "🤖 OpenAI";
  const aiOther = "🤖 其他 AI";
  for (const name of [aiClaude, aiOpenai, aiOther]) {
    check(`策略组 ${name} 存在`, groupSet.has(name));
  }
  check("旧组 🤖 AI 服务 已不存在", !groupSet.has("🤖 AI 服务"));
  for (const name of [aiClaude, aiOpenai, aiOther]) {
    const g = (result["proxy-groups"] || []).find((item) => item && item.name === name);
    if (!g) continue;
    check(`${name} 是 select 组`, g.type === "select");
    check(`${name} 候选非空`, Array.isArray(g.proxies) && g.proxies.length > 0);
    check(`${name} 候选全部真实存在`, (g.proxies || []).every((p) => policySet.has(p) || proxyNames.has(p)));
    if (selfPresent) check(`${name} 候选包含自建节点`, (g.proxies || []).includes("🏠 自建节点"));
  }
  const aiClaudeRules = rules.filter((rule) => parsePolicy(rule) === aiClaude);
  const aiOpenaiRules = rules.filter((rule) => parsePolicy(rule) === aiOpenai);
  const aiOtherRules = rules.filter((rule) => parsePolicy(rule) === aiOther);
  check("存在指向 🤖 Claude 的规则", aiClaudeRules.length > 0, String(aiClaudeRules.length));
  check("存在指向 🤖 OpenAI 的规则", aiOpenaiRules.length > 0, String(aiOpenaiRules.length));
  check("存在指向 🤖 其他 AI 的规则", aiOtherRules.length > 0, String(aiOtherRules.length));
  check("没有规则仍指向旧 AI 组", !rules.some((rule) => parsePolicy(rule) === "🤖 AI 服务"));
  check(
    "RULE-SET,claude 已重定向到 🤖 Claude",
    rules.includes(`RULE-SET,claude,${aiClaude}`),
    JSON.stringify(rules.filter((rule) => String(rule).startsWith("RULE-SET,claude")).slice(0, 3))
  );
  check(
    "RULE-SET,openai 已重定向到 🤖 OpenAI",
    rules.includes(`RULE-SET,openai,${aiOpenai}`),
    JSON.stringify(rules.filter((rule) => String(rule).startsWith("RULE-SET,openai")).slice(0, 3))
  );
  check("显式规则 claude.ai → 🤖 Claude", rules.includes(`DOMAIN-SUFFIX,claude.ai,${aiClaude}`));
  check("显式规则 anthropic.com → 🤖 Claude", rules.includes(`DOMAIN-SUFFIX,anthropic.com,${aiClaude}`));
  check("显式规则 chatgpt.com → 🤖 OpenAI", rules.includes(`DOMAIN-SUFFIX,chatgpt.com,${aiOpenai}`));
  check("显式规则 openai.com → 🤖 OpenAI", rules.includes(`DOMAIN-SUFFIX,openai.com,${aiOpenai}`));
  check(
    "AI 显式规则排在 my-proxy 之前",
    proxyRuleIndex !== -1 && rules.indexOf(`DOMAIN-SUFFIX,claude.ai,${aiClaude}`) < proxyRuleIndex,
    `claude=${rules.indexOf(`DOMAIN-SUFFIX,claude.ai,${aiClaude}`)}, proxy=${proxyRuleIndex}`
  );

  section("4d. GitHub 分组");
  const ghName = "🐙 GitHub";
  const toolsName = "🛠️ 工具与服务";
  check("策略组 🐙 GitHub 存在", groupSet.has(ghName));
  check("🛠️ 工具与服务 组仍存在", groupSet.has(toolsName));
  const ghGroup = (result["proxy-groups"] || []).find((item) => item && item.name === ghName);
  if (ghGroup) {
    check("🐙 GitHub 是 select 组", ghGroup.type === "select");
    check("🐙 GitHub 候选非空", Array.isArray(ghGroup.proxies) && ghGroup.proxies.length > 0);
    check("🐙 GitHub 候选全部真实存在", (ghGroup.proxies || []).every((p) => policySet.has(p) || proxyNames.has(p)));
    if (selfPresent) check("🐙 GitHub 候选包含自建节点", (ghGroup.proxies || []).includes("🏠 自建节点"));
  }
  check(
    "RULE-SET,github 已重定向到 🐙 GitHub",
    rules.includes(`RULE-SET,github,${ghName}`),
    JSON.stringify(rules.filter((rule) => String(rule).startsWith("RULE-SET,github")).slice(0, 2))
  );
  check("显式规则 github.com → 🐙 GitHub", rules.includes(`DOMAIN-SUFFIX,github.com,${ghName}`));
  check(
    "工具与服务组不再有 GitHub 域名规则",
    !rules.some(
      (rule) =>
        parsePolicy(rule) === toolsName &&
        /github/i.test(String(rule)) &&
        !String(rule).toUpperCase().startsWith("PROCESS")
    )
  );
  check(
    "GitHub 显式规则排在 my-proxy 之前",
    proxyRuleIndex !== -1 && rules.indexOf(`DOMAIN-SUFFIX,github.com,${ghName}`) < proxyRuleIndex,
    `gh=${rules.indexOf(`DOMAIN-SUFFIX,github.com,${ghName}`)}, proxy=${proxyRuleIndex}`
  );

  section("5. MATCH 唯一且在最后");
  const matchRules = rules.filter((rule) => String(rule).toUpperCase().startsWith("MATCH,"));
  check("MATCH 规则只有 1 条", matchRules.length === 1, `实际 ${matchRules.length} 条`);
  check("最后一条是 MATCH", String(rules[rules.length - 1]).toUpperCase().startsWith("MATCH,"));
  check("MATCH 的目标组存在", policySet.has(parsePolicy(rules[rules.length - 1])), parsePolicy(rules[rules.length - 1]));

  section("6. 全量规则目标校验");
  const invalid = [];
  for (const rule of rules) {
    const policy = parsePolicy(rule);
    if (!policy) {
      invalid.push({ rule, policy: "(空)" });
      continue;
    }
    if (!policySet.has(policy)) invalid.push({ rule, policy });
  }
  const oursInvalid = invalid.filter((item) => /^RULE-SET,my-|^(PROCESS-NAME|PROCESS-NAME-REGEX|SRC-IP-CIDR),/.test(String(item.rule)));
  check("个人规则的目标组全部存在", oursInvalid.length === 0, JSON.stringify(oursInvalid.slice(0, 3)));
  if (invalid.length > 0) {
    console.log(`  · 提示：上游有 ${invalid.length} 条规则引用了当前不存在的策略组（可能导致加载失败，先观察上游版本）`);
    invalid.slice(0, 5).forEach((item) => console.log(`      ${item.rule}  →  ${item.policy}`));
  }

  section("7. 目标组缺失时的回退");
  const fallbackConfig = JSON.parse(JSON.stringify(result));
  fallbackConfig["proxy-groups"] = fallbackConfig["proxy-groups"].filter(
    (group) => group && !["🎯 节点选择", "🚧 受限网站"].includes(group.name)
  );
  fallbackConfig.rules = fallbackConfig.rules.filter(
    (rule) => !String(rule).startsWith("RULE-SET,my-") && !String(rule).startsWith("SRC-IP-CIDR,")
  );
  delete fallbackConfig["rule-providers"]["my-direct"];
  delete fallbackConfig["rule-providers"]["my-proxy"];
  try {
    const fallbackResult = sandbox.injectMyPatch(fallbackConfig);
    const fallbackProxyRule =
      (fallbackResult.rules || []).find((rule) => String(rule).startsWith("RULE-SET,my-proxy,")) || "";
    check(
      "缺少首选组时回退到其它代理组",
      fallbackProxyRule !== "" && fallbackProxyRule !== "RULE-SET,my-proxy,🎯 节点选择",
      String(fallbackProxyRule)
    );
    const fallbackVmRules = (fallbackResult.rules || []).filter((rule) => String(rule).startsWith("SRC-IP-CIDR,"));
    check("缺少首选组时 VM 规则仍然注入", fallbackVmRules.length === vmCidrs.length, JSON.stringify(fallbackVmRules));
    check(
      "缺少首选组时 VM 规则回退到其它代理组",
      fallbackVmRules.length > 0 && parsePolicy(fallbackVmRules[0]) !== "🎯 节点选择",
      JSON.stringify(fallbackVmRules.slice(0, 1))
    );
    const fallbackGroups = new Set(
      (fallbackResult["proxy-groups"] || []).map((group) => group && group.name).filter(Boolean)
    );
    const fallbackPolicySet = new Set([...BUILTIN, ...fallbackGroups]);
    check(
      "回退后的 VM 策略组真实存在",
      fallbackVmRules.length > 0 && fallbackPolicySet.has(parsePolicy(fallbackVmRules[0])),
      parsePolicy(fallbackVmRules[0] || "")
    );
    const fallbackProvider = (fallbackResult["rule-providers"] || {})["my-proxy"];
    check(
      "缺少下载组时 provider.proxy 仍然合法",
      !fallbackProvider || !fallbackProvider.proxy || fallbackPolicySet.has(fallbackProvider.proxy),
      fallbackProvider ? String(fallbackProvider.proxy) : "(provider 缺失)"
    );
  } catch (error) {
    check("缺少首选组时不崩溃", false, error && error.message);
  }

  section("8. DNS / IPv6 收口");
  const dns = result.dns || {};
  const nameservers = Array.isArray(dns.nameserver) ? dns.nameserver : [];
  check("nameserver 非空", nameservers.length > 0, JSON.stringify(nameservers));
  check(
    "nameserver 全部指定代理组（#组名）",
    nameservers.length > 0 && nameservers.every((item) => String(item).includes("#")),
    JSON.stringify(nameservers)
  );
  check(
    "nameserver 的代理组存在",
    nameservers.every((item) => {
      const group = String(item).split("#")[1];
      return !group || policySet.has(group);
    }),
    JSON.stringify(nameservers)
  );
  const fallbackDns = Array.isArray(dns.fallback) ? dns.fallback : [];
  check("fallback 非空", fallbackDns.length > 0, JSON.stringify(fallbackDns));
  check(
    "fallback 是国内 DNS",
    fallbackDns.length > 0 && fallbackDns.every((item) => /alidns|doh\.pub|223\.5\.5\.5/.test(String(item))),
    JSON.stringify(fallbackDns)
  );
  check("已删除冲突的 fallback-filter", !dns["fallback-filter"]);
  const policy = dns["nameserver-policy"] || {};
  check("国内域名 policy 存在（rule-set:cn）", Array.isArray(policy["rule-set:cn"]) && policy["rule-set:cn"].length > 0);
  check("国内域名 policy 存在（+.cn）", Array.isArray(policy["+.cn"]) && policy["+.cn"].length > 0);
  check("default-nameserver 是纯 IP 引导 DNS", (dns["default-nameserver"] || []).every((item) => /^\d+\.\d+\.\d+\.\d+$/.test(String(item))));
  check("direct-nameserver 是国内 DNS", (dns["direct-nameserver"] || []).every((item) => /alidns|doh\.pub|223\.5\.5\.5/.test(String(item))));
  check("IPv6 已关闭（config.ipv6 && dns.ipv6）", result.ipv6 === false && dns.ipv6 === false);

  section("9. 运行日志（个人补丁部分）");
  logs
    .filter((line) => line.includes("[my-patch]"))
    .slice(0, 8)
    .forEach((line) => console.log(`  · ${line}`));

  finish();
}

function finish() {
  console.log(`\n[smoke] 共 ${checks} 项检查，失败 ${failures} 项`);
  if (failures > 0) {
    console.error("[smoke] ✗ 冒烟测试未通过");
    process.exit(1);
  }
  console.log("[smoke] ✓ 全部通过");
}

main().catch((error) => {
  console.error("[smoke] 运行异常:", error);
  process.exit(1);
});
