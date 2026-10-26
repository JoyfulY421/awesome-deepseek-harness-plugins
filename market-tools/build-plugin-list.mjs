#!/usr/bin/env node
/**
 * 从 1024Store 的 catalog/plugins/*.json 生成 DSH 官方插件市场生成器的输入列表。
 *
 * 背景：catalog 每个条目只包含仓库地址（repository），不包含 npm 包名和版本号，
 * 因此这里把“去重后的 https Git 仓库 URL”逐行写入 market/plugins.txt。
 * 官方生成器（@deepseek-ai/dsh-plugin-market-generator）会逐个克隆这些仓库，
 * 自动发现其中声明了 dsh.bundle 的包，并读取发布标签/默认分支生成版本。
 *
 * 去重：同一仓库的多个 monorepo 条目（owner/repo/sub/dir）都指向同一个根仓库，
 * 生成器会扫描该仓库里的 bundle，因此这里只保留一个根 URL。
 *
 * 位置：放在独立的 market-tools/ 目录，避免与上游仓库自带的 scripts/ 冲突。
 * 用法：在仓库根目录执行  node market-tools/build-plugin-list.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const catalogDir = join(repoRoot, 'catalog', 'plugins');
const siteDir = join(repoRoot, 'market'); // 最终站点目录：只放 index.json 和 icons/
const outFile = join(here, 'plugins.txt'); // 生成器输入列表，放在 market-tools/，不随站点发布

const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 规范化仓库 URL：去掉末尾的 / 和 .git，便于去重。 */
function normalizeRepo(url) {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

const files = readdirSync(catalogDir).filter((name) => name.endsWith('.json')).sort();
const repos = new Set();
const skipped = [];
let entryCount = 0;
let subDirCount = 0;

for (const file of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(catalogDir, file), 'utf8'));
  } catch {
    skipped.push(`${file}: 无法解析 JSON`);
    continue;
  }

  if (typeof data.repository !== 'string' || !REPO_RE.test(data.repository)) {
    skipped.push(`${file}: repository 字段缺失或不是合法的 GitHub 仓库 URL`);
    continue;
  }

  // id 形如 owner/repo 或 owner/repo/sub/dir（后者是 monorepo 子目录插件）。
  if (typeof data.id === 'string' && data.id.split('/').length > 2) subDirCount += 1;

  entryCount += 1;
  repos.add(normalizeRepo(data.repository));
}

const lines = [...repos].sort();
mkdirSync(siteDir, { recursive: true });

const header = [
  '# 由 market-tools/build-plugin-list.mjs 自动生成，请勿手改。',
  `# catalog 插件条目: ${entryCount}`,
  `# 去重后 Git 仓库: ${lines.length}`,
  `# 其中 monorepo 子目录条目: ${subDirCount}（生成器扫描根仓库时自动发现；examples/ 下的包可能被官方生成器跳过）`,
  '# 每行一个 https Git 仓库 URL，供 DSH 官方插件市场生成器读取。',
  '',
].join('\n');

writeFileSync(outFile, header + lines.join('\n') + '\n', 'utf8');

console.log(`catalog 条目: ${entryCount}`);
console.log(`去重后仓库: ${lines.length}`);
console.log(`monorepo 子目录条目: ${subDirCount}`);
console.log(`跳过: ${skipped.length}`);
if (skipped.length > 0) console.log(skipped.map((line) => `  - ${line}`).join('\n'));
console.log(`已写入: ${outFile}`);
