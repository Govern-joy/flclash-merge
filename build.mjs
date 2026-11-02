#!/usr/bin/env node
// =====================================================================
// 自建 URL 合并流水线：上游 FlClash-V61.js → 注入个人补丁 → dist/merged.js
//
// 用法：
//   node build.mjs                     # 拉取上游最新版并构建（CI 里用这个）
//   node build.mjs --no-smoke          # 跳过冒烟测试
//   V61_URL=<固定地址> node build.mjs   # 上游改坏时临时钉住某个版本
//   V61_FILE=<本地文件> node build.mjs  # 离线：直接用本地上游副本
//   RULES_BASE=<raw 地址> node build.mjs
//
// 环境变量：
//   V61_URL      上游脚本地址（默认用作者 main 分支的 raw，失败自动换 jsdelivr）
//   V61_FILE     本地上游脚本路径（优先于 V61_URL，离线调试用）
//   RULES_BASE   你自己的 rules 目录 raw 地址（CI 里根据 GITHUB_REPOSITORY 自动推导）
// =====================================================================

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "dist");
const OUT_FILE = path.join(OUT_DIR, "merged.js");
const INFO_FILE = path.join(OUT_DIR, "build-info.json");

const UPSTREAM_CANDIDATES = [
  "https://raw.githubusercontent.com/Wuzhenshi8874/flclash-v-series/main/FlClash-V61.js",
  "https://cdn.jsdelivr.net/gh/Wuzhenshi8874/flclash-v-series@main/FlClash-V61.js",
];

const MAIN_SIGNATURE = "function main(config)";
const RENAMED_SIGNATURE = "function __v61Main(config)";
const PLACEHOLDER = "__RULES_BASE__";

const args = process.argv.slice(2);
const skipSmoke = args.includes("--no-smoke");

function fail(message) {
  console.error(`\n[build] ✗ ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[build] ${message}`);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function resolveRulesBase() {
  const explicit = (process.env.RULES_BASE || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const repo = (process.env.GITHUB_REPOSITORY || "").trim();
  const ref = (process.env.GITHUB_REF_NAME || "main").trim() || "main";
  if (repo) {
    return `https://raw.githubusercontent.com/${repo}/${ref}/rules`;
  }
  return null;
}

async function fetchWithTimeout(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { "user-agent": "flclash-merge-bot" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

async function loadUpstream() {
  const localFile = (process.env.V61_FILE || "").trim();
  if (localFile) {
    log(`使用本地上游副本: ${localFile}`);
    return { text: await readFile(path.resolve(localFile), "utf8"), source: `file://${localFile}` };
  }

  const urls = process.env.V61_URL ? [process.env.V61_URL.trim()] : UPSTREAM_CANDIDATES;
  const errors = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const text = await fetchWithTimeout(url);
        log(`上游拉取成功 (${attempt} 次尝试): ${url}`);
        return { text, source: url };
      } catch (error) {
        errors.push(`${url} #${attempt}: ${error.message}`);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    }
  }
  fail(`上游脚本拉取失败：\n  ${errors.join("\n  ")}`);
}

function validateUpstream(text, source) {  if (!text || text.length < 100_000) {
    fail(`上游脚本内容异常（长度 ${text ? text.length : 0}），拒绝构建：${source}`);
  }
  const mainCount = text.split(MAIN_SIGNATURE).length - 1;
  if (mainCount !== 1) {
    fail(
      `上游脚本结构变了：期望恰好 1 处 "${MAIN_SIGNATURE}"，实际 ${mainCount} 处。\n` +
        `  可能作者改了入口函数名/写法。\n` +
        `  处理办法：在 workflow 里把 V61_URL 钉到一个能用的旧 commit，或改 build.mjs 的 MAIN_SIGNATURE。`
    );
  }
  const versionMatch = text.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/);
  return {
    version: versionMatch ? versionMatch[1] : "unknown",
    sha256: sha256(text),
  };
}

// 极简 rule-provider 校验：不引入依赖，只校验本项目的两个 domain 型 yaml
async function validateRuleFiles(rulesBase) {
  const required = [
    { file: "my-direct.yaml", label: "DIRECT" },
    { file: "my-proxy.yaml", label: "强制代理组" },
  ];
  let total = 0;
  for (const item of required) {
    const full = path.join(ROOT, "rules", item.file);
    let text;
    try {
      text = await readFile(full, "utf8");
    } catch {
      fail(`缺少规则文件 rules/${item.file}（provider 会 404）`);
    }
    const lines = text.split(/\r?\n/);
    const payloadStart = lines.findIndex((line) => /^payload\s*:/.test(line.trim()));
    if (payloadStart === -1) fail(`rules/${item.file} 缺少 payload: 顶层字段`);
    const entries = [];
    for (const raw of lines.slice(payloadStart + 1)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^-\s*["']?([^"'\s]+)["']?\s*$/);
      if (!match) fail(`rules/${item.file} 有无法解析的行: ${line}`);
      const value = match[1];
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) fail(`rules/${item.file} 不能写完整 URL: ${value}`);
      if (!/^(\+\.|\.)?[A-Za-z0-9*][A-Za-z0-9.*_-]*$/.test(value)) fail(`rules/${item.file} 域名格式可疑: ${value}`);
      entries.push(value);
    }
    if (entries.length === 0) fail(`rules/${item.file} 的 payload 是空的`);
    const dup = entries.filter((v, i) => entries.indexOf(v) !== i);
    if (dup.length > 0) fail(`rules/${item.file} 有重复条目: ${[...new Set(dup)].join(", ")}`);
    log(`规则文件 rules/${item.file}: ${entries.length} 条 → ${item.label}`);
    total += entries.length;
  }
  log(`个人规则合计 ${total} 条，规则地址: ${rulesBase}`);
}

async function main() {
  const rulesBase = resolveRulesBase();
  if (!rulesBase) {
    fail(
      "缺少 RULES_BASE。\n" +
        "  本地构建示例：RULES_BASE=https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/rules node build.mjs\n" +
        "  GitHub Actions 中会自动根据 GITHUB_REPOSITORY 推导。"
    );
  }
  log(`rules base: ${rulesBase}`);
  await validateRuleFiles(rulesBase);

  const upstream = await loadUpstream();
  const meta = validateUpstream(upstream.text, upstream.source);
  log(`上游版本: ${meta.version}  sha256: ${meta.sha256.slice(0, 12)}…`);

  const patchSource = await readFile(path.join(ROOT, "patch", "patch.js"), "utf8");
  if (!patchSource.includes(PLACEHOLDER)) {
    fail(`patch/patch.js 里找不到占位符 ${PLACEHOLDER}，无法注入 rules 地址。`);
  }
  const patch = patchSource.replaceAll(PLACEHOLDER, rulesBase);

  const renamed = upstream.text.replace(MAIN_SIGNATURE, RENAMED_SIGNATURE);
  if (!renamed.includes(RENAMED_SIGNATURE)) {
    fail("上游 main 改名失败。");
  }

  const header = [
    "/*!",
    " * 自动生成文件，请勿直接编辑。",
    ` * 上游: ${upstream.source}`,
    ` * 上游版本: ${meta.version}`,
    ` * 上游 sha256: ${meta.sha256}`,
    ` * 个人规则地址: ${rulesBase}`,
    " * 构建脚本: flclash-merge/build.mjs",
    " */",
    "",
  ].join("\n");

  const merged = `${header}${renamed}\n\n${patch}\n`;
  if (merged.includes(PLACEHOLDER)) {
    fail("合并结果里仍残留占位符，拒绝输出。");
  }

  // 产物必须是确定性的：不含时间戳，这样上游/补丁/规则没变时字节完全一致，
  // workflow 的 git diff 就能跳过提交，避免每天产生一条噪音提交。
  const buildTime = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, merged, "utf8");
  await writeFile(
    INFO_FILE,
    JSON.stringify(
      {
        upstreamSource: upstream.source,
        upstreamVersion: meta.version,
        upstreamSha256: meta.sha256,
        rulesBase,
        mergedSha256: sha256(merged),
        bytes: Buffer.byteLength(merged, "utf8"),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  log(`构建时间: ${buildTime}（不写入产物，保证可重复构建）`);
  log(`已输出 ${path.relative(ROOT, OUT_FILE)} (${(merged.length / 1024).toFixed(0)} KB)`);
  log(`已输出 ${path.relative(ROOT, INFO_FILE)}`);

  if (!skipSmoke) {
    log("运行冒烟测试…");
    const result = spawnSync(process.execPath, [path.join(ROOT, "test", "smoke.mjs"), OUT_FILE], {
      stdio: "inherit",
      cwd: ROOT,
    });
    if (result.status !== 0) {
      fail("冒烟测试失败，产物不可用（dist/merged.js 已生成，但不要提交）。");
    }
  }

  log("完成 ✓");
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
