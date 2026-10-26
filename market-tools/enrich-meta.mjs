#!/usr/bin/env node
/**
 * enrich-meta.mjs
 *
 * 在官方生成器、npm-resolve 之后运行，为 format:1 索引补充“发现页”需要的
 * 分类 / 标签 / 排序数据：
 *
 *   - metadata.category：直接采用 1024Store 目录（catalog/categories.json 与
 *     catalog/plugins/*.json 里的 category），仓库未命中时按关键词兜底。
 *   - metadata.labels：
 *       npm / git（安装来源）
 *       stars-50/100/500/1000/5000/10000（GitHub Star 档位）
 *       updated-week / updated-month（近 7 / 30 天活跃）
 *       以及一批按名称/关键词识别的特性标签（主题、记忆、MCP、费用、浏览器……）
 *   - metadata.sortKeys：
 *       stars              GitHub Star 数
 *       repositoryUpdated  仓库最近活跃时间（pushed_at，Unix 秒）
 *       published          最新版本发布时间（Unix 秒）
 *       npmDownloads       npm 最近 30 天下载量（git 来源记 0）
 *
 * 同时在索引顶层 metadata 声明所有用到的 categories / labels / sortKeys。
 * format:1 校验器要求：插件引用的每个 id 都必须在顶层声明，标签不能重复，
 * sortKey 必须是有限数值。
 *
 * 用法：
 *   node enrich-meta.mjs <index.json> [catalogDir]
 *
 * 环境变量：
 *   GITHUB_TOKEN / GH_TOKEN  可显著提高 GitHub API 限额（CI 里 actions 自带 GITHUB_TOKEN）
 *   SKIP_GITHUB=1            不请求 GitHub（离线测试，stars/活跃度留空或用发布时间兜底）
 *   REPO_META_CACHE          缓存文件路径（默认 market-tools/.plugin-market-cache/repo-meta.json）
 *   ENRICH_CONCURRENCY       并发（默认 8）
 *
 * 只读外部、就地重写 index.json；任何外部数据缺失都不会中断，缺省降级。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INDEX_PATH = process.argv[2];
const CATALOG_DIR = process.argv[3] || 'catalog';
if (!INDEX_PATH) {
  console.error('用法: node enrich-meta.mjs <index.json> [catalogDir]');
  process.exit(2);
}

const CACHE_PATH =
  process.env.REPO_META_CACHE ||
  join('market-tools', '.plugin-market-cache', 'repo-meta.json');
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || 8) || 8;
const DL_CONCURRENCY = Number(process.env.NPM_DL_CONCURRENCY || 2) || 2; // npm 下载量接口低并发，避免 429
const DL_FETCH_CAP = Number(process.env.NPM_DL_FETCH_CAP || 120) || 120; // 单次运行最多更新多少个包（首次冷启动分天摊开）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const SKIP_GITHUB = process.env.SKIP_GITHUB === '1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;     // GitHub 仓库元信息每天刷新
const DL_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // npm 下载量仅用于排序，7 天内视为新鲜
const GITHUB = 'https://api.github.com';
const NPM_DL = 'https://api.npmjs.org/downloads/point/last-month';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function readJsonNoBom(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unixNow = () => Math.floor(Date.now() / 1000);

// 稳定字符串哈希（FNV-1a），用于把下载量更新稳定地分摊到不同日期，不依赖运行顺序
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// npm 下载量接口的全局“节流阀”：一旦遇到 429/5xx，所有后续请求都在此基础上额外冷却
const dlThrottle = { pauseUntil: 0, hits: 0 };
async function dlGate() {
  const wait = dlThrottle.pauseUntil - Date.now();
  if (wait > 0) await sleep(wait);
}
function dlBackoff(status) {
  dlThrottle.hits++;
  // 第 1 次限流冷却 2.5s，之后每次 +1.5s，上限 12s（整体减速，而不是长时间死等）
  const ms = Math.min(12000, 2500 + (dlThrottle.hits - 1) * 1500);
  dlThrottle.pauseUntil = Math.max(dlThrottle.pauseUntil, Date.now() + ms);
  return status;
}

async function fetchJson(url, { headers = {}, timeoutMs = 30000, retries = 3, maxRateLimitWaitMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dsh-market-enrich', ...headers },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) return { __notFound: true };
      if (res.status === 403 || res.status === 429) {
        // 限流：读 reset 时间，最多等 maxRateLimitWaitMs 后重试
        const wait = Math.min(
          maxRateLimitWaitMs,
          Math.max(2000, Number(res.headers.get('retry-after') || 0) * 1000 ||
            attempt * 8000 + 4000),
        );
        lastErr = new Error(`rate limited ${res.status}`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------------------
// 仓库地址规范化：解析 owner/repo 与子目录
// ---------------------------------------------------------------------------
function parseRepo(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    let parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    // 去掉末尾 .git
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/, '');
    let subdir;
    const ti = parts.findIndex((p) => p === 'tree' || p === 'blob');
    if (ti >= 0) {
      subdir = parts.slice(ti + 2).join('/').toLowerCase(); // tree/<branch>/<subdir>
      parts = parts.slice(0, ti);
    }
    if (parts.length < 2) return null;
    const owner = parts[0].toLowerCase();
    const repo = parts[1].toLowerCase();
    return { root: `${owner}/${repo}`, subdir: subdir || undefined };
  } catch {
    return null;
  }
}

function pluginRepo(plugin) {
  const v = plugin.versions?.[0] || {};
  const url = plugin.repository?.url || (v.source?.type === 'git' ? v.source.url : null);
  const parsed = parseRepo(url);
  if (!parsed) return null;
  const dir =
    plugin.repository?.directory ||
    (v.source?.type === 'git' ? v.source.path : undefined) ||
    undefined;
  return { root: parsed.root, subdir: dir || parsed.subdir };
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------
const CATEGORY_FALLBACK_RULES = [
  ['theme', /theme|主题|皮肤|外观|skin/i],
  ['memory', /memory|记忆|长期记忆/i],
  ['skill', /\bskill[s]?\b|技能/i],
  ['workflow', /workflow|工作流|自动化|automation/i],
  ['notify', /notify|notification|webhook|通知|集成|telegram|discord|slack|飞书|feishu|lark/i],
  ['model', /\bmodel provider|provider|模型接入|账号接入|多模型|llm provider|api.?key/i],
  ['session', /\bchat|session|message|对话|会话|消息/i],
  ['fun', /\bfun\b|game|游戏|娱乐|桌宠|pet/i],
  ['ui', /\bui\b|interface|界面|卡片|card|dashboard|皮肤/i],
  ['dev', /developer|runtime|\bcli\b|开发|运行时|debug|脚手架|scaffold/i],
];

function heuristicCategory(blob) {
  for (const [id, re] of CATEGORY_FALLBACK_RULES) if (re.test(blob)) return id;
  return 'tools';
}

function loadCategories(catalogDir) {
  const path = join(catalogDir, 'categories.json');
  const ordered = [];
  const labels = {};
  if (existsSync(path)) {
    const json = readJsonNoBom(path);
    const list = (json.categories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const c of list) {
      ordered.push(c.id);
      labels[c.id] = { title: { en: c.label?.en || c.id, zh: c.label?.zh || c.id } };
    }
  }
  return { ordered, labels };
}

function buildCategoryMap(catalogDir) {
  const pluginsDir = join(catalogDir, 'plugins');
  const rootMap = {}; // root -> { cats: Map id->count, sub: Map subdir->id }
  let files = [];
  try {
    files = readdirSync(pluginsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { rootMap, count: 0 };
  }
  for (const f of files) {
    let entry;
    try {
      entry = readJsonNoBom(join(pluginsDir, f));
    } catch {
      continue;
    }
    if (!entry.category) continue;
    // 子目录优先从 id 解析：id 形如 owner/repo[/subdir]；repository 通常只有根 URL。
    const idParts = String(entry.id || '').split('/').filter(Boolean);
    let root = null;
    let subdir;
    if (idParts.length >= 2) {
      root = `${idParts[0].toLowerCase()}/${idParts[1].toLowerCase()}`;
      if (idParts.length > 2) subdir = idParts.slice(2).join('/').toLowerCase();
    }
    // 再用 repository URL 校验/补充根仓库
    const parsed = parseRepo(entry.repository);
    if (!root && parsed) root = parsed.root;
    if (!subdir && parsed?.subdir) subdir = parsed.subdir;
    if (!root) continue;
    const cat = String(entry.category);
    const rec = (rootMap[root] ||= { cats: new Map(), sub: new Map() });
    rec.cats.set(cat, (rec.cats.get(cat) || 0) + 1);
    if (subdir) rec.sub.set(subdir, cat);
  }
  return { rootMap, count: files.length };
}

function resolveCategory(plugin, repo, rootMap, catLabels) {
  const blob = [
    plugin.name,
    typeof plugin.title === 'object' ? `${plugin.title.en || ''} ${plugin.title.zh || ''}` : plugin.title,
    typeof plugin.description === 'object'
      ? `${plugin.description.en || ''} ${plugin.description.zh || ''}`
      : plugin.description,
    ...(plugin.metadata?.keywords || []),
  ].filter(Boolean).join(' ').toLowerCase();

  const rootRec = repo ? rootMap[repo.root] : null;
  if (rootRec) {
    if (repo.subdir && rootRec.sub.has(repo.subdir)) return rootRec.sub.get(repo.subdir);
    if (rootRec.cats.size === 1) return [...rootRec.cats.keys()][0];
    // 多个子目录分类不同：取出现最多的
    let best, bestN = -1;
    for (const [id, n] of rootRec.cats) if (n > bestN) { best = id; bestN = n; }
    return best;
  }
  // 目录未命中：关键词兜底，兜底分类必须在 categories.json 中存在
  const guess = heuristicCategory(blob);
  return catLabels[guess] ? guess : 'tools';
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------
const LABEL_TITLES = {
  npm: { zh: 'npm 包', en: 'npm package' },
  git: { zh: 'Git 源码包', en: 'Git bundle' },
  'updated-week': { zh: '近 7 天更新', en: 'Updated in last 7 days' },
  'updated-month': { zh: '近 30 天更新', en: 'Updated in last 30 days' },
  'stars-50': { zh: '50+ Star', en: '50+ stars' },
  'stars-100': { zh: '100+ Star', en: '100+ stars' },
  'stars-500': { zh: '500+ Star', en: '500+ stars' },
  'stars-1000': { zh: '1k+ Star', en: '1k+ stars' },
  'stars-5000': { zh: '5k+ Star', en: '5k+ stars' },
  'stars-10000': { zh: '10k+ Star', en: '10k+ stars' },
  theme: { zh: '主题美化', en: 'Themes' },
  memory: { zh: '长期记忆', en: 'Long-term memory' },
  skills: { zh: '技能管理', en: 'Skills' },
  mcp: { zh: 'MCP 管理', en: 'MCP' },
  'cost-tracking': { zh: '费用统计', en: 'Cost tracking' },
  'usage-tracking': { zh: '用量统计', en: 'Usage tracking' },
  search: { zh: '联网搜索', en: 'Web search' },
  'browser-automation': { zh: '浏览器操作', en: 'Browser automation' },
  'web-extraction': { zh: '网页抓取', en: 'Web extraction' },
  provider: { zh: '模型接入', en: 'Model providers' },
  vision: { zh: '图像理解', en: 'Image understanding' },
  'image-generation': { zh: '图片生成', en: 'Image generation' },
  translation: { zh: '内容翻译', en: 'Translation' },
  'voice-input': { zh: '语音输入', en: 'Voice input' },
  'read-aloud': { zh: '语音朗读', en: 'Read aloud' },
  ocr: { zh: '文字识别', en: 'OCR' },
  workflows: { zh: '工作流编排', en: 'Workflow orchestration' },
  teams: { zh: '多 Agent 协作', en: 'Agent teams' },
  pets: { zh: '桌宠陪伴', en: 'Companion pets' },
  'interactive-cards': { zh: '对话卡片', en: 'Interactive cards' },
  backup: { zh: '备份恢复', en: 'Backup & restore' },
  'file-management': { zh: '文件管理', en: 'File management' },
  'chat-migration': { zh: '记录迁移', en: 'Chat migration' },
  'security-research': { zh: '安全研究', en: 'Security research' },
  'code-review': { zh: '代码审查', en: 'Code review' },
  'diff-review': { zh: '修改对比', en: 'Change diffs' },
  'document-export': { zh: '文档导出', en: 'Document export' },
  'document-preview': { zh: '文档预览', en: 'Document preview' },
  research: { zh: '论文研究', en: 'Academic research' },
  invoices: { zh: '发票整理', en: 'Invoices' },
  mobile: { zh: '手机使用', en: 'Mobile access' },
  remote: { zh: '远程访问', en: 'Remote access' },
  approvals: { zh: '权限审批', en: 'Approvals' },
  taskboard: { zh: '任务看板', en: 'Task board' },
  context: { zh: '上下文管理', en: 'Context management' },
  presets: { zh: '预设管理', en: 'Agent presets' },
  messaging: { zh: '聊天软件', en: 'Messaging apps' },
};

const CATEGORY_TO_LABEL = {
  theme: 'theme',
  memory: 'memory',
  skill: 'skills',
  workflow: 'workflows',
  model: 'provider',
};

const FEATURE_RULES = [
  ['theme', /theme|主题|皮肤|外观|skin/i],
  ['memory', /memory|记忆|长期记忆/i],
  ['skills', /\bskill[s]?\b|技能/i],
  ['mcp', /\bmcp\b|model context protocol/i],
  ['cost-tracking', /cost|费用|计费|定价|price|pricing|消耗/i],
  ['usage-tracking', /usage tracking|用量统计|token usage|用量/i],
  ['search', /web search|联网|搜索|检索|\bsearch\b/i],
  ['browser-automation', /browser|浏览器|puppeteer|playwright|selenium/i],
  ['web-extraction', /crawl|scrape|爬虫|网页抓取|web extraction/i],
  ['provider', /model provider|模型接入|账号接入|多模型|provider/i],
  ['vision', /vision|图像理解|视觉理解|图片理解/i],
  ['image-generation', /image gen|图片生成|图像生成|绘图|生图|text-to-image|\bt2i\b/i],
  ['translation', /translat|翻译/i],
  ['voice-input', /voice input|语音输入|speech.to.text|\bstt\b|whisper|语音转文字/i],
  ['read-aloud', /read.?aloud|朗读|tts\b|text.to.speech|语音播报/i],
  ['ocr', /\bocr\b/],
  ['workflows', /workflow|工作流|automation|自动化/i],
  ['teams', /multi.?agent|多\s*agent|agent team|orchestrat/i],
  ['pets', /\bpet\b|桌宠|桌面宠物|虚拟宠物/i],
  ['interactive-cards', /interactive card|对话卡片|卡片交互|\bcard\b/i],
  ['backup', /backup|备份|数据恢复/i],
  ['file-management', /file manage|文件管理|文件浏览|explorer|文件操作/i],
  ['chat-migration', /chat migration|记录迁移|对话迁移|迁移.*(记录|对话)/i],
  ['security-research', /security research|安全研究|渗透|pentest|red.?team|vulnerability/i],
  ['code-review', /code review|代码审查|代码评审|pr review/i],
  ['diff-review', /\bdiff\b|修改对比|变更对比/i],
  ['document-export', /document export|文档导出|export.*(pdf|doc|markdown)|导出文档/i],
  ['document-preview', /document preview|文档预览|预览文档/i],
  ['research', /\bpaper\b|论文|学术研究|literature/i],
  ['invoices', /invoice|发票/i],
  ['mobile', /\bmobile\b|手机|android|\bios\b/i],
  ['remote', /\bremote\b|远程访问|远程控制|远程桌面/i],
  ['approvals', /approval|审批|human.?in.?loop|权限.*确认/i],
  ['taskboard', /taskboard|kanban|看板/i],
  ['context', /context manage|上下文管理|上下文压缩|context window|上下文窗口/i],
  ['presets', /\bpreset\b|预设/i],
  ['messaging', /messaging|whatsapp|wechat|微信|telegram|discord|slack|飞书|feishu|lark/i],
];

const STAR_BUCKETS = [10000, 5000, 1000, 500, 100, 50];
const LABEL_ORDER = [
  'npm', 'git',
  'stars-10000', 'stars-5000', 'stars-1000', 'stars-500', 'stars-100', 'stars-50',
  'updated-week', 'updated-month',
];

// ---------------------------------------------------------------------------
// 缓存（GitHub 仓库元数据 + npm 下载量）
// ---------------------------------------------------------------------------
function loadCache() {
  try {
    if (existsSync(CACHE_PATH)) return readJsonNoBom(CACHE_PATH);
  } catch { /* 忽略损坏缓存 */ }
  return { repos: {}, npm: {} };
}
function saveCache(cache) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn(`  缓存保存失败（不影响结果）: ${err.message}`);
  }
}

async function fetchRepoMeta(root, cache) {
  const cached = cache.repos[root];
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  if (SKIP_GITHUB) {
    return { stars: 0, updatedAt: null, missing: false, fetchedAt: Date.now() };
  }
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const data = await fetchJson(`${GITHUB}/repos/${root}`, { headers });
    if (data.__notFound) {
      return (cache.repos[root] = { stars: 0, updatedAt: null, missing: true, fetchedAt: Date.now() });
    }
    return (cache.repos[root] = {
      stars: Number(data.stargazers_count || 0),
      updatedAt: data.pushed_at ? Math.floor(Date.parse(data.pushed_at) / 1000) : null,
      missing: false,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    // 失败不写缓存，下次运行再试；本次若有旧值则沿用，否则返回空值
    if (cached) {
      console.warn(`  GitHub 仓库信息获取失败，沿用旧值 ${root}: ${err.message}`);
      return cached;
    }
    console.warn(`  GitHub 仓库信息获取失败 ${root}: ${err.message}`);
    return { stars: 0, updatedAt: null, missing: false };
  }
}

// 取单个包的下载量：失败（含 429）不长时间死等，直接返回“旧值或 0”，且不覆盖缓存；
// 下一次运行（或该包轮转日）再尝试。下载量只用于排序，短期用旧值不会有明显差异。
async function fetchNpmDownloads(name, cache) {
  const key = `npm:${name}`;
  const stale = cache.npm[key]; // 可能是已过期的旧值
  const url = `${NPM_DL}/${encodeURIComponent(name)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await dlGate();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dsh-market-enrich' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 403 || res.status === 503 || res.status === 502) {
        dlBackoff(res.status);
        continue; // 受全局节流后再试一次，仍失败就放弃
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const downloads = Number(data.downloads || 0);
      cache.npm[key] = { downloads, fetchedAt: Date.now() };
      return downloads;
    } catch (err) {
      // 网络错误等也触发轻微减速，再试一次
      if (err?.name === 'AbortError') dlBackoff('timeout');
      await sleep(1000 * (attempt + 1));
    }
  }
  // 两次都失败：沿用旧值，没有旧值就记 0；不写缓存，便于下次补取
  if (stale && Number.isFinite(stale.downloads)) {
    console.warn(`  npm 下载量获取失败，沿用 ${Math.round((Date.now() - stale.fetchedAt) / 86400000)} 天前旧值: ${name}`);
    return stale.downloads;
  }
  console.warn(`  npm 下载量获取失败，本次记 0（下次补）: ${name}`);
  return 0;
}

// 决定本次运行需要更新哪些包的下载量：
//   - 7 天内有新值：跳过，直接用缓存
//   - 无任何缓存（新包）：优先更新，但受 DL_FETCH_CAP 上限保护，冷启动分天摊开
//   - 有旧值但已过期：按包名哈希轮转，只在“属于今天”的那批更新（约 1/7），其余沿用旧值
function planNpmDownloads(names, cache) {
  const now = Date.now();
  const todaySlot = new Date().getUTCDay(); // 0..6（CI 用 UTC 时间，稳定）
  const fresh = [];      // 7 天内有值，直接用
  const missing = [];    // 完全没缓存
  const staleDue = [];   // 有旧值、已过期，且按哈希轮到今天更新
  const staleHold = [];  // 有旧值、已过期，但今天轮不到 -> 沿用旧值
  for (const name of names) {
    const e = cache.npm[`npm:${name}`];
    if (!e) {
      missing.push(name);
    } else if (e.fetchedAt && now - e.fetchedAt < DL_TTL_MS) {
      fresh.push(name);
    } else if (hashStr(name) % 7 === todaySlot) {
      staleDue.push(name);
    } else {
      staleHold.push(name);
    }
  }
  const order = (a, b) => hashStr(a) - hashStr(b);
  missing.sort(order);
  staleDue.sort(order);
  const pickMissing = missing.slice(0, DL_FETCH_CAP);
  const pickStale = staleDue.slice(0, Math.max(0, DL_FETCH_CAP - pickMissing.length));
  const fetchList = [...pickMissing, ...pickStale];
  return {
    fetchList,
    freshCount: fresh.length,
    useStaleCount: staleHold.length + (staleDue.length - pickStale.length),
    deferredMissing: missing.length - pickMissing.length,
  };
}


// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function isFiniteInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

async function main() {
  const index = readJsonNoBom(INDEX_PATH);
  const plugins = Array.isArray(index.plugins) ? index.plugins : [];

  const { ordered: catOrder, labels: catLabels } = loadCategories(CATALOG_DIR);
  const { rootMap, count: catalogCount } = buildCategoryMap(CATALOG_DIR);
  console.log(`catalog 条目: ${catalogCount}，已声明分类: ${catOrder.length}`);

  const cache = loadCache();

  // 收集所有需要查询的根仓库 / npm 包
  const repoOfPlugin = plugins.map((p) => ({ p, repo: pluginRepo(p) }));
  const roots = [...new Set(repoOfPlugin.map((x) => x.repo?.root).filter(Boolean))];
  const npmNames = [...new Set(
    plugins
      .filter((p) => p.versions?.[0]?.source?.type === 'npm')
      .map((p) => p.name),
  )];

  console.log(`插件 ${plugins.length}，需查 GitHub 仓库 ${roots.length}，npm 包 ${npmNames.length}`);

  // 1) GitHub 仓库元数据（stars / 活跃时间）
  await mapPool(roots, CONCURRENCY, async (root) => {
    await fetchRepoMeta(root, cache);
  });
  saveCache(cache);

  // 2) npm 下载量：限流友好——7 天缓存 + 分天轮转 + 单次上限 + 失败用旧值/0
  const plan = planNpmDownloads(npmNames, cache);
  console.log(
    `npm 下载量：本次更新 ${plan.fetchList.length} 个，7 天内缓存 ${plan.freshCount} 个，` +
    `沿用旧值 ${plan.useStaleCount} 个` +
    (plan.deferredMissing > 0 ? `，超额延后 ${plan.deferredMissing} 个（分天补）` : ''),
  );
  await mapPool(plan.fetchList, DL_CONCURRENCY, async (name) => {
    await fetchNpmDownloads(name, cache);
  });
  saveCache(cache);
  if (dlThrottle.hits > 0) {
    console.warn(`  本次 npm 下载量接口共触发 ${dlThrottle.hits} 次限流减速（已按旧值/0 处理，不影响构建）`);
  }

  // 3) 逐插件写入 metadata，并统计用到的标签
  const usedLabels = new Set();
  let matchedCategory = 0;
  let fallbackCategory = 0;
  const repoMeta = {};
  for (const root of roots) repoMeta[root] = cache.repos[root];

  for (const { p, repo } of repoOfPlugin) {
    const src = p.versions?.[0]?.source || {};
    const published = p.versions?.[0]?.publishTimestamp;
    const meta = repo && repoMeta[repo.root];
    const stars = isFiniteInt(meta?.stars) ? meta.stars : 0;
    const repoUpdated =
      isFiniteInt(meta?.updatedAt) ? meta.updatedAt
      : isFiniteInt(published) ? published
      : null;

    // 分类
    let category = null;
    if (repo) {
      const rootRec = rootMap[repo.root];
      if (rootRec) {
        category = resolveCategory(p, repo, rootMap, catLabels);
        if (catLabels[category]) matchedCategory++;
      }
    }
    if (!category || !catLabels[category]) {
      const blob = [
        p.name,
        typeof p.title === 'object' ? `${p.title.en || ''} ${p.title.zh || ''}` : p.title,
        typeof p.description === 'object'
          ? `${p.description.en || ''} ${p.description.zh || ''}` : p.description,
        ...(p.metadata?.keywords || []),
      ].filter(Boolean).join(' ').toLowerCase();
      const guess = heuristicCategory(blob);
      category = catLabels[guess] ? guess : (catLabels.tools ? 'tools' : catOrder[0]);
      fallbackCategory++;
    }

    // 标签
    const labels = [];
    labels.push(src.type === 'npm' ? 'npm' : 'git');
    for (const n of STAR_BUCKETS) if (stars >= n) { labels.push(`stars-${n}`); break; }
    if (repoUpdated) {
      const age = unixNow() - repoUpdated;
      if (age <= 7 * 86400) labels.push('updated-week');
      else if (age <= 30 * 86400) labels.push('updated-month');
    }
    // 分类天然带出的特性标签
    if (CATEGORY_TO_LABEL[category]) labels.push(CATEGORY_TO_LABEL[category]);
    // 关键词特性标签
    const blob = [
      p.name,
      typeof p.title === 'object' ? `${p.title.en || ''} ${p.title.zh || ''}` : p.title,
      typeof p.description === 'object'
        ? `${p.description.en || ''} ${p.description.zh || ''}` : p.description,
      ...(p.metadata?.keywords || []),
    ].filter(Boolean).join(' ').toLowerCase();
    for (const [label, re] of FEATURE_RULES) if (re.test(blob)) labels.push(label);

    // 去重（校验器要求标签不能重复）
    const uniqLabels = [...new Set(labels)];
    for (const l of uniqLabels) usedLabels.add(l);

    // npm 下载量
    const npmDownloads =
      src.type === 'npm' ? (cache.npm[`npm:${p.name}`]?.downloads || 0) : 0;

    // 排序键（全部有限数值）
    const sortKeys = {
      stars,
      ...(repoUpdated ? { repositoryUpdated: repoUpdated } : {}),
      ...(isFiniteInt(published) ? { published } : {}),
      npmDownloads,
    };

    p.metadata = {
      ...(p.metadata?.keywords?.length ? { keywords: p.metadata.keywords } : {}),
      category,
      labels: uniqLabels,
      sortKeys,
    };
  }

  // 4) 组装顶层 metadata
  // 分类：以 categories.json 顺序为准；若出现 categories.json 之外的分类，补 id 占位
  const categories = {};
  for (const id of catOrder) categories[id] = catLabels[id];
  for (const p of plugins) {
    const id = p.metadata?.category;
    if (id && !categories[id]) categories[id] = { title: { en: id, zh: id } };
  }

  // 标签：按固定顺序声明，特性标签按字典序
  const labelsDecl = {};
  const orderedLabels = [
    ...LABEL_ORDER.filter((id) => usedLabels.has(id)),
    ...[...usedLabels].filter((id) => !LABEL_ORDER.includes(id)).sort(),
  ];
  for (const id of orderedLabels) {
    const t = LABEL_TITLES[id];
    labelsDecl[id] = { title: { zh: t?.zh || id, en: t?.en || id } };
  }

  // 排序键：只声明实际用到的
  const sortKeysDecl = {};
  const sortKeyDefs = [
    ['stars', { zh: 'GitHub Star 数', en: 'GitHub stars' }],
    ['repositoryUpdated', { zh: '最近活跃', en: 'Recently updated' }],
    ['published', { zh: '最新发布', en: 'Latest release' }],
    ['npmDownloads', { zh: '安装次数（近 30 天）', en: 'Monthly installs' }],
  ];
  const usedSortKeys = new Set();
  for (const p of plugins) for (const k of Object.keys(p.metadata?.sortKeys || {})) usedSortKeys.add(k);
  for (const [id, t] of sortKeyDefs) {
    if (usedSortKeys.has(id)) sortKeysDecl[id] = { title: { zh: t.zh, en: t.en }, order: 'desc' };
  }

  index.metadata = { categories, labels: labelsDecl, sortKeys: sortKeysDecl };

  // 5) 自检（对齐 format:1 校验规则）
  const errors = [];
  const catIds = new Set(Object.keys(categories));
  const labIds = new Set(Object.keys(labelsDecl));
  const skIds = new Set(Object.keys(sortKeysDecl));
  plugins.forEach((p, i) => {
    const at = `plugins[${i}](${p.name})`;
    if (p.metadata.category && !catIds.has(p.metadata.category))
      errors.push(`${at}: 未声明分类 ${p.metadata.category}`);
    for (const l of p.metadata.labels) if (!labIds.has(l)) errors.push(`${at}: 未声明标签 ${l}`);
    if (new Set(p.metadata.labels).size !== p.metadata.labels.length)
      errors.push(`${at}: 标签重复`);
    for (const [k, v] of Object.entries(p.metadata.sortKeys)) {
      if (!skIds.has(k)) errors.push(`${at}: 未声明排序键 ${k}`);
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${at}: 排序键 ${k} 非数值`);
    }
  });
  if (errors.length) {
    console.error('自检发现 format:1 问题：\n' + errors.slice(0, 20).join('\n'));
    process.exit(1);
  }

  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf8');

  // 统计输出
  const catCount = {};
  for (const p of plugins) {
    const c = p.metadata.category;
    catCount[c] = (catCount[c] || 0) + 1;
  }
  const srcCount = {};
  for (const p of plugins) {
    const t = p.versions[0].source.type;
    srcCount[t] = (srcCount[t] || 0) + 1;
  }
  console.log('分类/排序增强完成：');
  console.log(`  插件: ${plugins.length}（catalog 命中分类 ${matchedCategory}，关键词兜底 ${fallbackCategory}）`);
  console.log(`  来源: ${JSON.stringify(srcCount)}`);
  console.log(`  分类: ${Object.keys(categories).length} 个，标签: ${Object.keys(labelsDecl).length} 个，排序键: ${Object.keys(sortKeysDecl).length} 个`);
  console.log(`  分类分布: ${JSON.stringify(catCount)}`);
  console.log(`  标签: ${[...orderedLabels].join(', ')}`);
}

main().catch((err) => {
  console.error('enrich-meta 失败：', err);
  process.exit(1);
});
