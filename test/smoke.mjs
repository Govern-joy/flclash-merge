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
  const providers = result["rule-providers"] || {};
  const proxyNames = new Set((result.proxies || []).map((item) => item && item.name).filter(Boolean));
  const selfPresent = groupSet.has("🏠 自建节点");

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
  const firstRule = rules[0] || "";
  if (selfPresent) {
    // 有自建节点时，VM 的源 IP 规则会插到最前面
    check("rules[0] 是 VM 出口的 SRC-IP 规则", firstRule === "SRC-IP-CIDR,172.31.0.0/24,🖥️ VM 出口", firstRule);
  } else {
    check("rules[0] 是 RULE-SET,my-proxy", firstRule.startsWith("RULE-SET,my-proxy,"), firstRule);
  }
  check("第 1 条规则的策略组合法", policySet.has(parsePolicy(firstRule)), parsePolicy(firstRule));

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

  section("5. MATCH 唯一且在最后");
  const matchRules = rules.filter((rule) => String(rule).toUpperCase().startsWith("MATCH,"));
  check("MATCH 规则只有 1 条", matchRules.length === 1, `实际 ${matchRules.length} 条`);
  check("最后一条是 MATCH", String(rules[rules.length - 1]).toUpperCase().startsWith("MATCH,"));
  check("MATCH 的目标组存在", policySet.has(parsePolicy(rules[rules.length - 1])), parsePolicy(rules[rules.length - 1]));

  section("6. VM 出口隔离");
  const vmGroup = (result["proxy-groups"] || []).find((group) => group && group.name === "🖥️ VM 出口");
  const srcRules = rules.filter((rule) => String(rule).startsWith("SRC-IP-CIDR,"));
  const listeners = Array.isArray(result.listeners) ? result.listeners : [];
  const vmListener = listeners.find((item) => item && item.name === "vm-gateway");
  if (!selfPresent) {
    check("无自建节点时不创建 VM 组", !vmGroup);
    check("无自建节点时不注入 SRC-IP 规则", srcRules.length === 0);
    check("无自建节点时不注入 listener", !vmListener);
    check("日志说明跳过原因", logs.some((line) => line.includes("vm: 未找到")), "缺少 vm: 未找到");
  } else {
    check("VM 组存在", Boolean(vmGroup));
    if (vmGroup) {
      check("VM 组是 select", vmGroup.type === "select");
      check(
        "VM 组默认出口是自建组",
        Array.isArray(vmGroup.proxies) && vmGroup.proxies[0] === "🏠 自建节点",
        JSON.stringify((vmGroup.proxies || []).slice(0, 3))
      );
      check(
        "VM 组候选不含直连/拦截策略",
        (vmGroup.proxies || []).every(
          (name) => !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"].includes(name)
        )
      );
      check(
        "VM 组候选全部真实存在",
        (vmGroup.proxies || []).every((name) => policySet.has(name) || proxyNames.has(name)),
        JSON.stringify((vmGroup.proxies || []).filter((name) => !policySet.has(name) && !proxyNames.has(name)))
      );
      const selfGroupIdx = groups.indexOf("🏠 自建节点");
      const vmGroupIdx = groups.indexOf("🖥️ VM 出口");
      check("VM 组紧跟自建组之后", vmGroupIdx === selfGroupIdx + 1, `self=${selfGroupIdx}, vm=${vmGroupIdx}`);
    }
    check("SRC-IP 规则只有 1 条", srcRules.length === 1, JSON.stringify(srcRules));
    check("SRC-IP 规则在最前", srcRules.length === 1 && rules[0] === srcRules[0], `rules[0]=${rules[0]}`);
    check("SRC-IP 子网与目标正确", srcRules[0] === "SRC-IP-CIDR,172.31.0.0/24,🖥️ VM 出口", String(srcRules[0]));
    check("listener 存在", Boolean(vmListener));
    if (vmListener) {
      check("listener 类型 mixed", vmListener.type === "mixed");
      check("listener 端口正确", Number(vmListener.port) === 17890, String(vmListener.port));
      check("listener 出口指向 VM 组", vmListener.proxy === "🖥️ VM 出口", String(vmListener.proxy));
      check("listener 有绑定地址", Boolean(vmListener.listen), String(vmListener.listen));
    }
  }

  section("7. 全量规则目标校验");
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

  section("8. 目标组缺失时的回退");
  const fallbackConfig = JSON.parse(JSON.stringify(result));
  fallbackConfig["proxy-groups"] = fallbackConfig["proxy-groups"].filter(
    (group) => group && !["🎯 节点选择", "🚧 受限网站"].includes(group.name)
  );
  fallbackConfig.rules = fallbackConfig.rules.filter((rule) => !String(rule).startsWith("RULE-SET,my-"));
  delete fallbackConfig["rule-providers"]["my-direct"];
  delete fallbackConfig["rule-providers"]["my-proxy"];
  try {
    const fallbackResult = sandbox.injectMyPatch(fallbackConfig);
    const fallbackFirst = String(fallbackResult.rules[0] || "");
    check(
      "缺少首选组时回退到其它代理组",
      fallbackFirst.startsWith("RULE-SET,my-proxy,") && fallbackFirst !== "RULE-SET,my-proxy,🎯 节点选择",
      fallbackFirst
    );
    const fallbackGroups = new Set(
      (fallbackResult["proxy-groups"] || []).map((group) => group && group.name).filter(Boolean)
    );
    const fallbackPolicySet = new Set([...BUILTIN, ...fallbackGroups]);
    const fallbackProvider = (fallbackResult["rule-providers"] || {})["my-proxy"];
    check(
      "缺少下载组时 provider.proxy 仍然合法",
      !fallbackProvider || !fallbackProvider.proxy || fallbackPolicySet.has(fallbackProvider.proxy),
      fallbackProvider ? String(fallbackProvider.proxy) : "(provider 缺失)"
    );
  } catch (error) {
    check("缺少首选组时不崩溃", false, error && error.message);
  }

  section("9. DNS / IPv6 收口");
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

  section("10. 运行日志（个人补丁部分）");
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
