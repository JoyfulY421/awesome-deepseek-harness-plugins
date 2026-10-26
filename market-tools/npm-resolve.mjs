#!/usr/bin/env node
// =============================================================================
// npm-resolve.mjs
// 官方生成器输出的索引一律是 git 来源（DSH 安装时要 git clone GitHub 仓库）。
// 在国内网络下，git clone github.com 经常超时/被重置；而已发布到 npm 的插件，
// 其 npm 安装源只是下载一个很小的、打包好的 tarball（约几百 KB），稳定快速。
//
// 本脚本在官方生成器跑完后执行：遍历 index.json 里的每个插件，
//   - 若该插件已发布到 npm 且最新版声明了 dsh.bundle（确实是 DSH 插件），
//     就把它的 versions 改写为 npm 来源（与 Bruce 索引完全相同的 source 结构）；
//   - 未发布 / 无 dsh.bundle / 查询失败的，保留原来的 git 来源，绝不报错中断。
//
// 用法: node market-tools/npm-resolve.mjs [index.json 路径]
// 环境变量:
//   NPM_REGISTRY      npm registry（默认 https://registry.npmjs.org/）
//   NPM_CONCURRENCY   并发数（默认 8）
//   NPM_TIMEOUT_MS    单个请求超时毫秒（默认 30000）
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';

const INDEX = process.argv[2] || 'market/index.json';
const REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
const CONCURRENCY = Number(process.env.NPM_CONCURRENCY || 8);
const TIMEOUT = Number(process.env.NPM_TIMEOUT_MS || 30000);

const stats = { npm: 0, git: 0, notFound: 0, noBundle: 0, failed: 0 };
const failedNames = [];

async function fetchNpm(name) {
  // scoped 包名形如 @scope/pkg，直接作为 registry 路径段即合法；
  // 非 scoped 包名形如 dsh-cost-meter。
  const url = REGISTRY + name;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-market-npm-resolver', accept: 'application/json' },
    });
    if (res.status === 404) return { notfound: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function resolveToNpm(meta, originalPlugin) {
  const latest = meta['dist-tags']?.latest;
  if (!latest || !meta.versions?.[latest]) return { ok: false, reason: 'no-latest' };
  const v = meta.versions[latest];
  // 只接受真正声明 dsh.bundle 的包，避免把依赖包误当插件。
  if (!v.dsh || typeof v.dsh !== 'object' || !v.dsh.bundle) {
    return { ok: false, reason: 'no-bundle' };
  }
  const iso = meta.time?.[latest];
  const publishTimestamp = iso ? Math.floor(Date.parse(iso) / 1000) : undefined;
  const newVersion = {
    version: latest,
    ...(publishTimestamp ? { publishTimestamp } : {}),
    source: { type: 'npm', registry: REGISTRY },
    // 只透传 DSH 兼容性声明（与官方/Bruce 索引一致）；不透传 engines.node，
    // 避免桌面端按内置 Node 版本误判。
    ...(v.engines?.dsh ? { engines: { dsh: v.engines.dsh } } : {}),
  };
  // 只保留 npm 最新版（与 Bruce 索引一致，保证一键安装走 npm 直装）。
  originalPlugin.versions = [newVersion];
  return { ok: true, latest };
}

async function processOne(plugin) {
  const name = plugin.name;
  const meta = await fetchNpm(name);
  if (meta.notfound) {
    stats.notFound++;
    stats.git++;
    return;
  }
  if (meta.error) {
    stats.failed++;
    stats.git++;
    failedNames.push(`${name}(${meta.error})`);
    return; // 查询失败：保留 git 来源
  }
  const r = resolveToNpm(meta, plugin);
  if (r.ok) {
    stats.npm++;
  } else if (r.reason === 'no-bundle') {
    stats.noBundle++;
    stats.git++;
  } else {
    stats.git++;
  }
}

// 简易并发池
async function runPool(items, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await worker(items[i]);
      } catch (e) {
        stats.failed++;
        stats.git++;
        failedNames.push(`${items[i].name}(ex:${e?.message || e})`);
      }
    }
  });
  await Promise.all(runners);
}

const raw = (await readFile(INDEX, 'utf8')).replace(/^\uFEFF/, '');
const index = JSON.parse(raw);
if (!Array.isArray(index.plugins)) throw new Error('索引格式异常：缺少 plugins 数组');
const total = index.plugins.length;

await runPool(index.plugins, processOne);

await writeFile(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log(`npm 解析完成：共 ${total} 个插件`);
console.log(`  已改写为 npm 来源（直装）：${stats.npm}`);
console.log(`  保留 git 来源：${stats.git}（其中 npm 未发布 ${stats.notFound}，最新版无 dsh.bundle ${stats.noBundle}，查询失败 ${stats.failed}）`);
if (failedNames.length) {
  console.log(`  查询失败明细（已保留 git，下次运行自动重试）：`);
  for (const n of failedNames.slice(0, 40)) console.log(`    - ${n}`);
  if (failedNames.length > 40) console.log(`    …另有 ${failedNames.length - 40} 个`);
}
