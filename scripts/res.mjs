#!/usr/bin/env node
/**
 * res.mjs — 工具资源仓库统一 CLI（Node >= 18，零第三方依赖）
 *
 * 命令：
 *   init                              幂等创建仓库骨架
 *   scan [dir...]                     扫描待发布文件，识别 id/版本/平台
 *   publish <file> [options]          发布资源（命名/哈希/分流/清单/索引）
 *   replace <id> <version> <file>     同版本原地替换（rev+1）
 *   set <id> [options]                修改元信息
 *   list [filters]                    查询资源
 *   get <id> [options]                取用资源（镜像回退+续传+缓存+校验）
 *   index                             重建 index.json / latest.json / CATALOG.md
 *   doctor                            清单结构体检
 *   verify [--id X|--all]             实物与清单一致性、URL 可达性
 *   mirror [--test]                   镜像策略查看/测速
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REG = path.join(ROOT, 'registry');
const RES_DIR = path.join(REG, 'resources');
const CFG_PATH = path.join(REG, 'config.json');
const SCHEMA_PATH = path.join(REG, 'schema.json');
const IS_WIN = process.platform === 'win32';
const TTY = process.stdout.isTTY;

// ─────────────────────────── 输出 ───────────────────────────
const paint = (code, s) => (TTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const ok = (s) => console.log(paint(32, '✓ ') + s);
const warn = (s) => console.log(paint(33, '! ') + s);
const bad = (s) => console.log(paint(31, '✗ ') + s);
const plain = (s) => console.log(s);
function die(msg, code = 1) {
  console.error(paint(31, '✗ ') + msg);
  process.exit(code);
}
const w = (s) => {
  let n = 0;
  for (const ch of String(s)) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return n;
};
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(w(h), ...rows.map((r) => w(r[i] ?? ''))));
  const line = (cells) => cells.map((c, i) => String(c ?? '') + ' '.repeat(Math.max(0, widths[i] - w(c ?? '')))).join('  ');
  plain(line(headers));
  plain(widths.map((n) => '─'.repeat(n)).join('  '));
  for (const r of rows) plain(line(r));
}

// ─────────────────────────── 基础工具 ───────────────────────────
function readJSON(p, def = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
function human(size) {
  if (size == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(size);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}
const pad2 = (n) => String(n).padStart(2, '0');
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowISO() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}
function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      if (body.includes('=')) { const idx = body.indexOf('='); out[body.slice(0, idx)] = body.slice(idx + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[body] = next; i++; } else out[body] = true;
    } else out._.push(a);
  }
  return out;
}
let CURL = null;
try { execFileSync(IS_WIN ? 'curl.exe' : 'curl', ['--version'], { stdio: 'ignore' }); CURL = IS_WIN ? 'curl.exe' : 'curl'; } catch { CURL = null; }
// curl 附加参数：Windows 的 schannel 在吊销检查不可达时握手失败（CRYPT_E_NO_REVOCATION_CHECK），
// 默认加 --ssl-no-revoke；可用 registry/config.json 的 network.curl_args 覆盖（置空数组即关闭）。
let _curlArgsCache = null;
function extraCurlArgs() {
  if (_curlArgsCache) return _curlArgsCache;
  const cfg = readJSON(CFG_PATH, {});
  const a = cfg && cfg.network && cfg.network.curl_args;
  _curlArgsCache = Array.isArray(a) ? a : (IS_WIN ? ['--ssl-no-revoke'] : []);
  return _curlArgsCache;
}

// ─────────────────────────── 配置与清单 ───────────────────────────
function loadConfig() {
  const cfg = readJSON(CFG_PATH);
  if (!cfg) die(`缺少配置文件：${CFG_PATH}（先运行 node scripts/res.mjs init）`);
  return cfg;
}
function loadSchema() { return readJSON(SCHEMA_PATH, {}); }
function loadResources() {
  if (!fs.existsSync(RES_DIR)) return [];
  const out = [];
  for (const cat of fs.readdirSync(RES_DIR)) {
    const dir = path.join(RES_DIR, cat);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      const data = readJSON(p);
      if (!data) { warn(`清单解析失败，已跳过：${p}`); continue; }
      out.push({ ...data, __path: p, __categoryDir: cat });
    }
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}
function resourcePath(category, id) { return path.join(RES_DIR, category, `${id}.json`); }
function saveResource(r) {
  const target = resourcePath(r.category, r.id);
  if (r.__path && path.resolve(r.__path) !== path.resolve(target) && fs.existsSync(r.__path)) fs.rmSync(r.__path);
  const clean = { ...r };
  delete clean.__path; delete clean.__categoryDir;
  writeJSON(target, clean);
  r.__path = target;
  return target;
}
function findResource(id) {
  const list = loadResources();
  return list.find((r) => r.id === String(id).toLowerCase()) || null;
}
function latestVersion(r, channel) {
  const vs = channel ? r.versions.filter((v) => v.channel === channel) : r.versions;
  return vs.find((v) => v.latest) || vs[vs.length - 1] || null;
}

// ─────────────────────────── 命名规范 ───────────────────────────
function parseFilename(name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const segs = base.split('-');
  const platforms = ['windows', 'linux', 'macos', 'android', 'any'];
  const archs = ['x64', 'arm64', 'x86', 'any'];
  for (let i = 1; i < segs.length - 1; i++) {
    if (platforms.includes(segs[i].toLowerCase()) && archs.includes((segs[i + 1] || '').toLowerCase())) {
      const slug = segs.slice(0, i - 1).join('-');
      const version = segs[i - 1];
      const variant = segs.slice(i + 2).join('-') || null;
      if (!slug || !/^[v]?\d/.test(version)) return null;
      return {
        slug: slug.toLowerCase(),
        version: version.replace(/^v/, ''),
        platform: segs[i].toLowerCase(),
        arch: segs[i + 1].toLowerCase(),
        variant,
        ext: ext.toLowerCase(),
      };
    }
  }
  return null;
}
function buildFilename({ slug, version, platform, arch, variant, ext }) {
  const parts = [slug, version, platform, arch];
  if (variant) parts.push(variant);
  const e = ext.startsWith('.') ? ext : `.${ext}`;
  return parts.join('-') + e.toLowerCase();
}

// ─────────────────────────── 索引派生 ───────────────────────────
function buildIndex(cfg) {
  const list = loadResources();
  const gen = nowISO();
  const index = { generated_at: gen, repo: `${cfg.repo.owner}/${cfg.repo.name}`, count: list.length, resources: [] };
  const latest = { generated_at: gen, repo: `${cfg.repo.owner}/${cfg.repo.name}`, resources: {} };
  for (const r of list) {
    const lv = latestVersion(r);
    index.resources.push({
      id: r.id, name: r.name, category: r.category, subcategory: r.subcategory ?? null,
      description: r.description ?? '', status: r.status ?? 'active',
      tags: r.tags ?? [], keywords: r.keywords ?? [],
      latest_version: lv ? lv.version : null,
      versions: (r.versions ?? []).map((v) => ({
        version: v.version, channel: v.channel, released_at: v.released_at, latest: !!v.latest,
        storage: v.storage, release_tag: v.release_tag ?? null, rev: v.rev ?? 1,
        files: (v.files ?? []).map((f) => ({
          filename: f.filename, kind: f.kind, platform: f.platform, arch: f.arch,
          size: f.size, sha256: f.sha256, storage: v.storage, path: f.path ?? null, url: f.url,
        })),
      })),
      manifest: path.relative(ROOT, r.__path).split(path.sep).join('/'),
    });
    if (lv) {
      latest.resources[r.id] = {
        id: r.id, name: r.name, category: r.category, subcategory: r.subcategory ?? null,
        version: lv.version, channel: lv.channel, released_at: lv.released_at,
        storage: lv.storage, files: (lv.files ?? []).map((f) => ({
          filename: f.filename, kind: f.kind, platform: f.platform, arch: f.arch,
          size: f.size, sha256: f.sha256, url: f.url, mirrors: f.mirrors ?? [], path: f.path ?? null, storage: lv.storage,
        })),
      };
    }
  }
  writeJSON(path.join(REG, 'index.json'), index);
  writeJSON(path.join(REG, 'latest.json'), latest);

  // CATALOG.md
  const groups = new Map();
  for (const r of list) {
    const cat = r.category || 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(r);
  }
  const lines = [
    '# 资源总览',
    '',
    `> 由 \`node scripts/res.mjs index\` 自动生成，请勿手改。生成时间：${gen}　资源数：${list.length}`,
    '',
  ];
  for (const [cat, items] of [...groups.entries()].sort()) {
    lines.push(`## ${cat}（${items.length}）`, '');
    lines.push('| id | 名称 | 最新版本 | 平台 | 大小 | 承载 | 取用 |');
    lines.push('|----|------|----------|------|------|------|------|');
    for (const r of items) {
      const lv = latestVersion(r);
      const f = lv && lv.files && lv.files[0];
      lines.push(`| \`${r.id}\` | ${r.name ?? ''} | ${lv ? lv.version : '-'} | ${f ? `${f.platform}/${f.arch}` : '-'} | ${f ? human(f.size) : '-'} | ${lv ? lv.storage : '-'} | \`res get ${r.id}\` |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(REG, 'CATALOG.md'), lines.join('\n'), 'utf8');
  return { count: list.length };
}

// ─────────────────────────── 下载引擎 ───────────────────────────
function cacheDir() { return path.join(os.homedir(), '.tools-res', 'cache'); }
function cachedFile(sha) { return path.join(cacheDir(), sha.slice(0, 2), sha); }
function downloadCandidates(file, version, cfg) {
  const list = [];
  const push = (u) => { if (u && !list.includes(u)) list.push(u); };
  if (version.storage === 'git' && file.path) {
    const rawOnly = (cfg.mirrors.raw_prefixes || []).filter((p) => p.enabled && p.tpl.includes('{path}'));
    const direct = (cfg.mirrors.raw_prefixes || []).filter((p) => p.enabled && p.tpl.includes('{path}') === false);
    for (const p of rawOnly) push(fill(p.tpl, { branch: cfg.repo.branch, path: file.path, filename: file.filename }));
    for (const p of direct) push(fill(p.tpl, { url: file.url }));
    push(fill(cfg.repo.raw_url_tpl, { branch: cfg.repo.branch, path: file.path }));
  } else {
    const prefixes = (cfg.mirrors.release_prefixes || []).filter((p) => p.enabled && p.tpl.includes('{url}'));
    if (cfg.mirrors.policy === 'mirror-first') { for (const p of prefixes) push(fill(p.tpl, { url: file.url, filename: file.filename })); push(file.url); }
    else { push(file.url); for (const p of prefixes) push(fill(p.tpl, { url: file.url, filename: file.filename })); }
  }
  return list;
}
function curlDownload(url, dest, timeout) {
  const args = ['-fSL', '--retry', '1', '--connect-timeout', String(timeout), '--max-time', '1800', ...extraCurlArgs(), '-o', dest, url];
  if (fs.existsSync(dest)) { args.splice(0, 0, '-C', '-'); }
  const r = spawnSync(CURL, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error((r.stderr ? r.stderr.toString() : '').trim() || `curl 退出码 ${r.status}`);
}
async function fetchDownload(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}
async function downloadTo(file, version, destPath, cfg, opts = {}) {
  const cands = downloadCandidates(file, version, cfg);
  const errors = [];
  for (const url of cands) {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (CURL) curlDownload(url, destPath, cfg.mirrors.timeout_seconds ?? 5);
      else await fetchDownload(url, destPath);
      const sha = await sha256File(destPath);
      if (file.sha256 && sha !== file.sha256) { errors.push(`${url} → 哈希不匹配`); fs.rmSync(destPath, { force: true }); continue; }
      return { url, sha };
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
      if (fs.existsSync(destPath) && !opts.keepPartial) fs.rmSync(destPath, { force: true });
    }
  }
  throw new Error(`全部下载源失败：\n  ${errors.join('\n  ')}`);
}

// ─────────────────────────── GitHub Release 上传 ───────────────────────────
function githubToken() {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) if (process.env[k] && process.env[k].trim()) return process.env[k].trim();
  try {
    const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
    const m = /^password=(.+)$/m.exec(out);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* ignore */ }
  return null;
}
// 注意：本机 Node fetch 无法通过 GitHub 的 TLS 链校验（UNABLE_TO_VERIFY_LEAF_SIGNATURE，
// 实测 github.com / api.github.com / raw / objects 全部失败），而 curl.exe 走系统证书库可用。
// 因此所有网络请求统一走 curl。
function curlHead(url, timeout = 15) {
  if (!CURL) return { status: 0, error: '未找到 curl' };
  const nul = IS_WIN ? 'NUL' : '/dev/null';
  const r = spawnSync(CURL, ['-sS', '-I', '-L', '--max-time', String(timeout), ...extraCurlArgs(), '-o', nul, '-w', '%{http_code}', url], { encoding: 'utf8' });
  if (r.error) return { status: 0, error: r.error.message };
  const status = Number((r.stdout || '').trim()) || 0;
  return { status, error: status ? null : String(r.stderr || '').trim().slice(0, 120) };
}
function curlJson(url, { method = 'GET', headers = {}, body = null, timeout = 120 } = {}) {
  if (!CURL) throw new Error('未找到 curl，无法访问 GitHub API');
  const args = ['-sS', '--max-time', String(timeout), ...extraCurlArgs(), '-X', method];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('--data-binary', body);
  args.push('-w', '\n%{http_code}', url);
  const r = spawnSync(CURL, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.message);
  const out = r.stdout ?? '';
  const nl = out.lastIndexOf('\n');
  const status = Number((nl >= 0 ? out.slice(nl + 1) : out).trim()) || 0;
  const text = nl >= 0 ? out.slice(0, nl) : '';
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status, ok: status >= 200 && status < 300, data };
}
async function gh(apiPath, opts = {}) {
  const token = opts.token || githubToken();
  if (!token) die('未找到 GitHub Token：请设置环境变量 GITHUB_TOKEN，或确保 git 凭据管理器已保存 github.com 凭据');
  const url = apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tools-res-cli',
    ...(opts.headers || {}),
  };
  const res = curlJson(url, { method: opts.method || 'GET', headers, body: opts.body, timeout: opts.timeout || 120 });
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    throw new Error(`GitHub API ${res.status}：${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`);
  }
  return res;
}
async function ensureRelease(cfg, tag, title, notes) {
  const base = `/repos/${cfg.repo.owner}/${cfg.repo.name}`;
  const got = await gh(`${base}/releases/tags/${encodeURIComponent(tag)}`);
  if (got.ok && got.data && got.data.id) return got.data;
  const created = await gh(`${base}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: title || tag, body: notes || '', draft: false, prerelease: false }),
  });
  if (!created.ok || !created.data || !created.data.id) throw new Error(`创建 Release 失败（tag=${tag}）`);
  return created.data;
}
async function uploadAsset(cfg, release, filePath, filename) {
  const token = githubToken();
  if (!token) die('未找到 GitHub Token，无法上传资产');
  if (!CURL) die('需要 curl 才能上传 Release 资产（Node fetch 在本机无法通过 TLS 校验）');
  const url = `https://uploads.github.com/repos/${cfg.repo.owner}/${cfg.repo.name}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`;
  const args = [
    '-sS', '--max-time', '1800', ...extraCurlArgs(), '-X', 'POST',
    '-H', `Authorization: token ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '-H', 'User-Agent: tools-res-cli',
    '--data-binary', `@${filePath}`,
    '-w', '\n%{http_code}', url,
  ];
  const r = spawnSync(CURL, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.message);
  const out = r.stdout ?? '';
  const nl = out.lastIndexOf('\n');
  const status = Number((nl >= 0 ? out.slice(nl + 1) : out).trim()) || 0;
  const text = nl >= 0 ? out.slice(0, nl) : '';
  if (status < 200 || status >= 300) throw new Error(`上传资产失败 ${status}：${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { status, raw: text.slice(0, 200) }; }
}

// ─────────────────────────── 命令实现 ───────────────────────────
function cmdInit() {
  const dirs = [
    REG, RES_DIR, path.join(ROOT, 'assets'), path.join(ROOT, 'scripts'),
    path.join(ROOT, 'profiles'), path.join(ROOT, 'inbox'), path.join(ROOT, 'docs'),
    ...['installer', 'portable', 'cli', 'toolchain', 'plugin', 'asset', 'other'].map((c) => path.join(RES_DIR, c)),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  const keep = [path.join(ROOT, 'assets'), path.join(ROOT, 'inbox'), path.join(ROOT, 'profiles')];
  for (const d of keep) {
    const k = path.join(d, '.gitkeep');
    if (!fs.existsSync(k)) fs.writeFileSync(k, '', 'utf8');
  }
  ok('仓库骨架就绪');
}

async function cmdScan(args) {
  const cfg = loadConfig();
  const list = loadResources();
  const skipDirs = new Set(['.git', '.op', 'op', 'registry', 'scripts', 'docs', 'assets', 'profiles', 'node_modules', '.cache']);
  const roots = args._.length ? args._ : ['.', 'inbox'];
  const files = [];
  for (const r of roots) {
    const d = path.resolve(ROOT, r);
    if (!fs.existsSync(d)) continue;
    if (fs.statSync(d).isDirectory()) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (skipDirs.has(e.name)) continue; for (const f of fs.readdirSync(path.join(d, e.name))) if (fs.statSync(path.join(d, e.name, f)).isFile()) files.push(path.join(d, e.name, f)); }
        else if (e.isFile() && !/^(README|LICENSE|\.gitignore)/i.test(e.name)) files.push(path.join(d, e.name));
      }
    } else files.push(d);
  }
  const rows = [];
  const report = [];
  for (const f of [...new Set(files)]) {
    const name = path.basename(f);
    if (!/\.(exe|msi|msix|zip|7z|tar|gz|dmg|pkg|apk|vsix|jar|whl|nupkg|iso|dll|pdf|json|ps1|bat)$/i.test(name)) continue;
    const parsed = parseFilename(name);
    const size = fs.statSync(f).size;
    const storage = size <= cfg.storage.light_asset_max_bytes ? 'git' : 'release';
    let state = 'ready';
    if (!parsed) state = 'manual';
    else {
      const r = list.find((x) => x.id === parsed.slug);
      const v = r && (r.versions || []).find((x) => x.version === parsed.version);
      if (v && (v.files || []).some((x) => x.filename === name)) state = 'exists';
    }
    rows.push([state, path.relative(ROOT, f).split(path.sep).join('/'), human(size), parsed ? parsed.slug : '-', parsed ? parsed.version : '-', parsed ? `${parsed.platform}/${parsed.arch}` : '-', parsed ? parsed.variant || '-' : '-', storage]);
    report.push({ state, file: f, name, size, storage, parsed });
  }
  if (args.json) { plain(JSON.stringify(report, null, 2)); return; }
  if (!rows.length) { warn('未发现待发布文件（支持 exe/msi/zip/7z/dmg/pkg/apk/... 等）'); return; }
  table(['状态', '文件', '大小', 'id', '版本', '平台', '变体', '承载'], rows);
  plain('');
  plain(`ready=${report.filter((x) => x.state === 'ready').length}  exists=${report.filter((x) => x.state === 'exists').length}  manual=${report.filter((x) => x.state === 'manual').length}`);
  const manual = report.filter((x) => x.state === 'manual');
  if (manual.length) {
    warn('以下文件文件名不含「平台/架构」段，需人工指定参数后发布：');
    for (const m of manual) plain(`  node scripts/res.mjs publish "${path.relative(ROOT, m.file)}" --id <id> --category <category> --version <ver> --platform <p> --arch <a>`);
  }
}

async function cmdPublish(args) {
  const cfg = loadConfig();
  const src = args._[0];
  if (!src) die('用法：res publish <文件> --id <id> --category <category> [--version] [--platform] [--arch] [--variant] [--kind] [--desc] [--force] [--no-upload]');
  // 中文参数在 PowerShell 5.1（GBK 代码页）下会编码错乱，可用 --desc-file / --notes-file 从 UTF-8 文件读入
  const readTextFile = (p) => {
    try { return fs.readFileSync(path.resolve(ROOT, p), 'utf8').replace(/^\uFEFF/, '').trim(); }
    catch (e) { die(`无法读取文件 ${p}：${e.message}`); }
  };
  if (typeof args['desc-file'] === 'string') args.desc = readTextFile(args['desc-file']);
  if (typeof args['notes-file'] === 'string') args.notes = readTextFile(args['notes-file']);
  const abs = path.resolve(ROOT, src);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) die(`文件不存在：${abs}`);
  const baseName = path.basename(abs);
  const parsed = parseFilename(baseName) || {};
  const id = String(args.id || parsed.slug || '').toLowerCase();
  if (!id) die(`无法从文件名识别 id（${baseName}），请用 --id 指定`);
  const exists = findResource(id);
  const category = args.category || args.cat || (exists && exists.category);
  if (!category) die(`缺少 --category（${baseName}），取值见 registry/schema.json 的 categories`);
  const version = String(args.version || parsed.version || '').replace(/^v/, '');
  if (!version) die(`缺少 --version（${baseName}）`);
  const platform = args.platform || parsed.platform || 'any';
  const arch = args.arch || parsed.arch || 'any';
  const variant = args.variant === undefined ? parsed.variant || null : (args.variant === 'none' ? null : args.variant);
  const ext = args.ext || path.extname(baseName);
  const filename = buildFilename({ slug: id, version, platform, arch, variant, ext });
  const size = fs.statSync(abs).size;
  const sha = await sha256File(abs);
  const storage = String(args.storage || (size <= cfg.storage.light_asset_max_bytes ? 'git' : 'release'));
  const kind = String(args.kind || (storage === 'release' && /\.(exe|msi|msix)$/i.test(ext) ? 'installer' : ext.replace('.', '') === 'zip' ? 'archive' : 'binary'));

  let r = exists;
  if (!r) {
    r = {
      id, name: args.name || id, category, subcategory: args.sub || args.subcategory || null,
      description: args.desc || args.description || '', keywords: args.keywords ? String(args.keywords).split(',') : [],
      homepage: args.homepage || null, license: null, status: 'active', owner: cfg.repo.owner,
      tags: args.tags ? String(args.tags).split(',') : [], notes: '', versions: [],
    };
  } else {
    if (args.desc) r.description = args.desc;
    if (args.name) r.name = args.name;
    if (args.sub) r.subcategory = args.sub;
    if (args.tags) r.tags = String(args.tags).split(',');
  }
  const channel = String(args.channel || 'stable');
  let v = (r.versions || []).find((x) => x.version === version);
  if (!v) {
    v = { version, channel, released_at: args.released || today(), latest: true, storage, files: [] };
    r.versions = r.versions || [];
    r.versions.push(v);
    for (const other of r.versions) if (other !== v && other.channel === channel) other.latest = false;
  }
  if (args.notes) r.notes = args.notes;
  const dup = (v.files || []).find((f) => f.filename === filename);
  if (dup && !args.force) die(`已存在同版本文件 ${id}@${version}/${filename}；如需覆盖请用 --force，内容修正建议改用 replace`);

  const file = { filename, orig_name: baseName, kind, platform, arch, size, sha256: sha, added_at: nowISO() };
  if (storage === 'git') {
    const rel = [cfg.storage.assets_dir, category, id, version, filename].join('/');
    const dest = path.join(ROOT, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    file.path = rel;
    file.url = fill(cfg.repo.raw_url_tpl, { branch: cfg.repo.branch, path: rel });
    file.mirrors = (cfg.mirrors.raw_prefixes || []).filter((p) => p.enabled && p.tpl.includes('{path}')).map((p) => fill(p.tpl, { branch: cfg.repo.branch, path: rel }));
    ok(`文件入库：${rel}（${human(size)}）`);
  } else {
    const tag = fill(cfg.storage.release_tag_tpl, { id, version });
    v.release_tag = tag;
    v.storage = 'release';
    file.url = fill(cfg.repo.release_url_tpl, { tag, filename });
    file.mirrors = (cfg.mirrors.release_prefixes || []).filter((p) => p.enabled && p.tpl.includes('{url}')).map((p) => fill(p.tpl, { url: file.url, filename }));
    if (args['no-upload']) warn('--no-upload：已登记清单但未上传资产，URL 暂不可用');
    else {
      const release = await ensureRelease(cfg, tag, `${r.name} ${version}`, `${id} ${version}（由 res.mjs 发布）`);
      await uploadAsset(cfg, release, abs, filename);
      ok(`Release 资产已上传：${tag}/${filename}（${human(size)}）`);
    }
  }
  if (dup) v.files = v.files.filter((f) => f.filename !== filename);
  v.files.push(file);
  v.latest = true;
  v.storage = storage;
  saveResource(r);
  buildIndex(cfg);
  ok(`清单已更新：registry/resources/${category}/${id}.json（storage=${storage}, sha256=${sha.slice(0, 16)}…）`);
  plain('');
  plain(`下一步：`);
  plain(`  git add registry assets && git commit -m "publish(${id}): ${version} ${filename}"`);
  plain(`  git push`);
}

async function cmdList(args) {
  const list = loadResources();
  let rows = [];
  for (const r of list) {
    if (args.category && r.category !== args.category) continue;
    if (args.id && r.id !== args.id) continue;
    if (args.tag && !(r.tags || []).includes(args.tag)) continue;
    if (args.keyword) {
      const hay = `${r.id} ${r.name} ${r.description} ${(r.tags || []).join(' ')} ${(r.keywords || []).join(' ')}`.toLowerCase();
      if (!hay.includes(String(args.keyword).toLowerCase())) continue;
    }
    if (args.status && (r.status || 'active') !== args.status) continue;
    const lv = latestVersion(r, args.channel);
    const f = lv && (lv.files || []).find((x) => (!args.platform || x.platform === args.platform) && (!args.arch || x.arch === args.arch)) || (lv && lv.files[0]);
    if ((args.platform || args.arch) && !f) continue;
    rows.push([r.id, r.category, lv ? lv.version : '-', f ? `${f.platform}/${f.arch}` : '-', f ? human(f.size) : '-', lv ? lv.storage : '-', (r.status || 'active'), r.name || '']);
  }
  if (args.json) { plain(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { warn('没有匹配的资源'); return; }
  table(['id', '分类', '最新版本', '平台', '大小', '承载', '状态', '名称'], rows);
  plain('');
  plain(`共 ${rows.length} 项。取用：node scripts/res.mjs get <id>`);
}

async function cmdGet(args) {
  const cfg = loadConfig();
  const id = args._[0] || args.id;
  if (!id) die('用法：res get <id> [--version x.y.z|latest] [--platform windows] [--arch x64] [--to <dir>] [--verify] [--allow-yanked]');
  const r = findResource(id);
  if (!r) die(`未找到资源：${id}（可运行 res list 查看）`);
  if (r.status === 'yanked' && !args['allow-yanked']) die(`${id} 已被 yanked（标记不可用），如确需下载加 --allow-yanked`);
  const lv = latestVersion(r, args.channel);
  const want = !args.version || args.version === 'latest' ? (lv ? lv.version : null) : String(args.version);
  const v = (r.versions || []).find((x) => x.version === want);
  if (!v) die(`未找到版本 ${want}（可用：${(r.versions || []).map((x) => x.version).join(', ')}）`);
  let files = (v.files || []).slice();
  if (args.platform) files = files.filter((f) => f.platform === args.platform);
  if (args.arch) files = files.filter((f) => f.arch === args.arch);
  if (args.kind) files = files.filter((f) => f.kind === args.kind);
  if (!files.length) die('没有匹配的文件（检查 --platform/--arch/--kind）');
  const outDir = path.resolve(ROOT, args.to || '.');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(outDir, f.filename);
    // 1) 内容寻址缓存命中
    const hit = f.sha256 ? cachedFile(f.sha256) : null;
    if (hit && fs.existsSync(hit)) {
      fs.copyFileSync(hit, dest);
      ok(`缓存命中：${f.filename} → ${dest}`);
      continue;
    }
    try {
      const { url } = await downloadTo(f, v, dest, cfg);
      if (f.sha256) {
        const cp = cachedFile(f.sha256);
        fs.mkdirSync(path.dirname(cp), { recursive: true });
        if (!fs.existsSync(cp)) fs.copyFileSync(dest, cp);
      }
      ok(`${f.filename}（${human(f.size)}）→ ${dest}`);
      plain(`  源：${url}`);
    } catch (e) {
      bad(`${f.filename} 下载失败：${e.message}`);
      process.exitCode = 3;
    }
  }
}

async function cmdIndex() {
  const cfg = loadConfig();
  const { count } = buildIndex(cfg);
  ok(`索引已重建：registry/index.json、registry/latest.json、registry/CATALOG.md（${count} 个资源）`);
}

function cmdDoctor() {
  const cfg = loadConfig();
  const schema = loadSchema();
  const list = loadResources();
  const cats = new Set(schema.categories || []);
  const problems = [];
  const warnings = [];
  const seen = new Set();
  for (const r of list) {
    const tag = `${r.id}`;
    if (seen.has(r.id)) problems.push(`id 重复：${r.id}`);
    seen.add(r.id);
    if (!new RegExp(schema.id_pattern || '^[a-z0-9-]+$').test(r.id)) problems.push(`id 不合规：${r.id}`);
    if (!cats.has(r.category)) problems.push(`${tag}：category 非法（${r.category}）`);
    if (r.category === 'other') warnings.push(`${tag}：category=other 属临时分类`);
    if (r.__categoryDir && r.__categoryDir !== r.category) problems.push(`${tag}：清单目录(${r.__categoryDir}) 与 category(${r.category}) 不一致`);
    for (const v of r.versions || []) {
      const latests = (r.versions || []).filter((x) => x.channel === v.channel && x.latest);
      if (latests.length > 1) problems.push(`${tag}@${v.version}：channel=${v.channel} 存在多个 latest`);
      if (!v.storage) problems.push(`${tag}@${v.version}：缺少 storage`);
      if (v.storage === 'release' && !v.release_tag) problems.push(`${tag}@${v.version}：storage=release 但缺少 release_tag`);
      for (const f of v.files || []) {
        if (!f.sha256 || f.sha256.length !== 64) problems.push(`${tag}@${v.version}/${f.filename}：sha256 缺失或长度异常`);
        if (v.storage === 'git') {
          if (!f.path) problems.push(`${tag}@${v.version}/${f.filename}：storage=git 但缺少 path`);
          else if (!fs.existsSync(path.join(ROOT, ...f.path.split('/')))) problems.push(`${tag}@${v.version}/${f.filename}：本地文件缺失（${f.path}）`);
          if (f.size > cfg.storage.light_asset_max_bytes) warnings.push(`${tag}@${v.version}/${f.filename}：体积 ${human(f.size)} 超过入 Git 阈值`);
        }
      }
    }
  }
  // assets 孤儿文件
  const assetsRoot = path.join(ROOT, cfg.storage.assets_dir);
  const registered = new Set();
  for (const r of list) for (const v of r.versions || []) for (const f of v.files || []) if (f.path) registered.add(f.path);
  if (fs.existsSync(assetsRoot)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const rel = path.relative(ROOT, p).split(path.sep).join('/');
          if (e.name === '.gitkeep') continue;
          if (!registered.has(rel)) warnings.push(`assets 孤儿文件（未登记清单）：${rel}`);
        }
      }
    };
    walk(assetsRoot);
  }
  plain(`资源数：${list.length}　分类数：${new Set(list.map((r) => r.category)).size}`);
  if (warnings.length) { plain(''); for (const m of warnings) warn(m); }
  if (problems.length) { plain(''); for (const m of problems) bad(m); plain(''); die(`doctor 发现 ${problems.length} 个问题`, 2); }
  ok('doctor 通过：清单结构一致');
}

async function cmdVerify(args) {
  const cfg = loadConfig();
  const list = args.all || !args.id ? loadResources() : [findResource(args.id)].filter(Boolean);
  if (!list.length) die('没有可校验的资源');
  let bad_ = 0;
  for (const r of list) {
    for (const v of r.versions || []) {
      for (const f of v.files || []) {
        const issues = [];
        if (f.sha256) {
          const local = f.path ? path.join(ROOT, ...f.path.split('/')) : null;
          const p = local && fs.existsSync(local) ? local : (fs.existsSync(cachedFile(f.sha256)) ? cachedFile(f.sha256) : null);
          if (p) {
            const sha = await sha256File(p);
            if (sha !== f.sha256) issues.push(`本地哈希不一致（${path.basename(p)}）`);
          }
        }
        if (args.url || args.all) {
          if (!f.url) issues.push('缺少 url');
          else {
            const h = curlHead(f.url, 20);
            if (!h.status || h.status >= 400) issues.push(`URL ${h.status || 'ERR'}：${f.url}${h.error ? `（${h.error.slice(0, 60)}）` : ''}`);
          }
        }
        if (issues.length) { bad_++; for (const i of issues) bad(`${r.id}@${v.version}/${f.filename}：${i}`); }
      }
    }
  }
  if (bad_) process.exitCode = 2;
  else ok('verify 通过：清单与实物一致');
}

async function cmdSet(args) {
  const cfg = loadConfig();
  const id = args._[0] || args.id;
  if (!id) die('用法：res set <id> [--status active|deprecated|yanked] [--desc 文本] [--name 名称] [--tags a,b] [--notes 文本]');
  const r = findResource(id);
  if (!r) die(`未找到资源：${id}`);
  for (const k of ['status', 'desc', 'description', 'name', 'sub', 'subcategory', 'homepage', 'license']) {
    if (args[k] === undefined) continue;
    const key = k === 'desc' ? 'description' : k === 'sub' ? 'subcategory' : k;
    r[key] = args[k];
  }
  if (args.tags) r.tags = String(args.tags).split(',');
  if (args.keywords) r.keywords = String(args.keywords).split(',');
  if (args.notes) r.notes = args.notes;
  saveResource(r);
  buildIndex(cfg);
  ok(`已更新：${id}`);
}

async function cmdReplace(args) {
  const cfg = loadConfig();
  const [id, version, file] = args._;
  if (!id || !version || !file) die('用法：res replace <id> <version> <新文件>');
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) die(`文件不存在：${abs}`);
  const r = findResource(id);
  if (!r) die(`未找到资源：${id}`);
  const v = (r.versions || []).find((x) => x.version === version);
  if (!v) die(`未找到版本 ${version}`);
  const f = (v.files || []).find((x) => x.kind === (args.kind || (v.files[0] || {}).kind)) || (v.files || [])[0];
  if (!f) die('该版本没有文件条目');
  const size = fs.statSync(abs).size;
  const sha = await sha256File(abs);
  if (v.storage === 'git' && f.path) {
    fs.copyFileSync(abs, path.join(ROOT, ...f.path.split('/')));
  } else if (v.storage === 'release') {
    const release = await ensureRelease(cfg, v.release_tag, `${r.name} ${version}`, `replaced at ${nowISO()}`);
    await uploadAsset(cfg, release, abs, f.filename);
  }
  f.size = size;
  f.sha256 = sha;
  f.revised_at = nowISO();
  v.rev = (v.rev || 1) + 1;
  saveResource(r);
  buildIndex(cfg);
  const log = path.join(REG, 'CHANGELOG.md');
  const line = `- ${today()} replace \`${id}@${version}\`/${f.filename} → sha256 \`${sha.slice(0, 16)}…\`（rev ${v.rev}）\n`;
  fs.appendFileSync(log, fs.existsSync(log) ? line : `# 变更日志\n\n${line}`, 'utf8');
  ok(`已替换并留痕（rev ${v.rev}）：${id}@${version}/${f.filename}`);
}

async function cmdMirror(args) {
  const cfg = loadConfig();
  if (!args.test) {
    plain(`policy = ${cfg.mirrors.policy}　timeout = ${cfg.mirrors.timeout_seconds}s`);
    plain('');
    table(['类型', 'id', '启用', '模板'], [
      ...(cfg.mirrors.release_prefixes || []).map((p) => ['release', p.id, p.enabled ? 'yes' : 'no', p.tpl]),
      ...(cfg.mirrors.raw_prefixes || []).map((p) => ['raw', p.id, p.enabled ? 'yes' : 'no', p.tpl]),
    ]);
    return;
  }
  const probe = 'https://github.com/klaus2918/tools/releases/latest';
  const seen = new Set();
  const cands = [];
  const pushCand = (id, tpl, enabled = true) => {
    if (!enabled || !tpl) return;
    const url = fill(tpl, { url: probe });
    if (seen.has(url)) return;
    seen.add(url);
    cands.push({ id, url });
  };
  pushCand('direct', '{url}');
  for (const p of cfg.mirrors.release_prefixes || []) pushCand(p.id, p.tpl, p.enabled);
  const rows = [];
  for (const c of cands) {
    const t0 = Date.now();
    const h = curlHead(c.url, Math.max(10, cfg.mirrors.timeout_seconds || 5));
    const ms = Date.now() - t0;
    rows.push({
      id: c.id,
      ms,
      label: h.status ? `${ms} ms（HTTP ${h.status}）` : `失败（${ms} ms）：${(h.error || '').slice(0, 40)}`,
      url: c.url,
    });
  }
  rows.sort((a, b) => a.ms - b.ms);
  table(['镜像', '耗时', '地址'], rows.map((r) => [r.id, r.label, r.url]));
}

// ─────────────────────────── 入口 ───────────────────────────
const USAGE = `工具资源仓库 CLI

  node scripts/res.mjs <命令> [参数]

  init                              幂等创建仓库骨架
  scan [dir...] [--json]            扫描待发布文件
  publish <file> --id --category …  发布资源
  replace <id> <version> <file>     同版本原地替换（rev+1）
  set <id> [--status …]             修改元信息
  list [--category] [--platform] …  查询资源
  get <id> [--version] [--to dir]   取用资源
  index                             重建派生索引
  doctor                            清单结构体检
  verify [--id X|--all] [--url]     一致性/可达性校验
  mirror [--test]                   镜像查看与测速`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const args = parseArgs(argv);
  if (!cmd || cmd === 'help' || args.help) { plain(USAGE); return; }
  switch (cmd) {
    case 'init': return cmdInit();
    case 'scan': return cmdScan(args);
    case 'publish': return cmdPublish(args);
    case 'list': return cmdList(args);
    case 'get': return cmdGet(args);
    case 'index': return cmdIndex();
    case 'doctor': return cmdDoctor();
    case 'verify': return cmdVerify(args);
    case 'set': return cmdSet(args);
    case 'replace': return cmdReplace(args);
    case 'mirror': return cmdMirror(args);
    default: plain(USAGE); die(`未知命令：${cmd}`, 1);
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
