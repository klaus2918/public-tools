#!/usr/bin/env node
/**
 * res-publish.mjs — 一键发布资源（Node >= 18，零第三方依赖）
 *
 * 串联：res publish → doctor → verify → 安全扫描 → 校验 → git commit → push
 *       可选：prune（自动检测版本数超限）/ 实测下载
 *
 * 用法：
 *   node scripts/res-publish.mjs <文件> [选项]
 *
 * 示例：
 *   node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe
 *   node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe --no-push --no-prune
 *   node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe --dry-run
 *
 * 选项：
 *   --id <id>            资源 ID（默认从文件名解析）
 *   --version <ver>      版本号（默认从文件名解析）
 *   --platform <p>       平台（默认 windows）
 *   --arch <a>           架构（默认 x64）
 *   --variant <v>        变体（默认 setup）
 *   --category <cat>     分类（默认 installer）
 *   --desc <text>        描述（默认读取 inbox/.desc.txt）
 *   --no-push            只提交不推送
 *   --no-prune           不自动 prune
 *   --no-verify-download 不实测下载
 *   --dry-run            只打印命令不执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'scripts', 'res.mjs');
const PY = process.platform === 'win32' ? 'py -3' : 'python3';
const SCAN_SCRIPT = path.join(ROOT, '..', 'op-skills', 'skills', 'safe-git-write', 'scripts', 'scan-sensitive.py');

// ── 输出 ──────────────────────────────────────────────────────
const IS_TTY = process.stdout.isTTY;
const c = (code, s) => (IS_TTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const ok   = (s) => console.log(c(32, '✓ ') + s);
const warn = (s) => console.log(c(33, '! ') + s);
const bad  = (s) => console.log(c(31, '✗ ') + s);
const step = (n, s) => console.log(c(36, `\n[${n}] `) + s);
const dry  = (cmd) => (DRY_RUN ? `  [dry-run] ${cmd}` : null);

let DRY_RUN = false;

// ── 命令执行 ──────────────────────────────────────────────────
function run(cmd, opts = {}) {
  if (DRY_RUN && !opts.forceReal) {
    const argsStr = (opts.args || []).join(' ');
    console.log(dry(`${cmd} ${argsStr}`.trim()));
    return '';
  }
  try {
    return execFileSync(cmd, opts.args || [], {
      cwd: opts.cwd || ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout || 300_000,
      ...opts.extra,
    }).trim();
  } catch (e) {
    const out = (e.stdout || '').trim();
    const err = (e.stderr || '').trim();
    if (out) console.log(out);
    if (err) console.error(err);
    throw new Error(`命令失败（exit ${e.status}）：${cmd} ${(opts.args || []).join(' ')}`);
  }
}

function shell(cmd) {
  if (DRY_RUN) { console.log(dry(cmd)); return ''; }
  const r = execFileSync(process.platform === 'win32' ? 'powershell' : 'bash',
    process.platform === 'win32'
      ? ['-NoProfile', '-Command', `$OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`]
      : ['-c', cmd],
    { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
  return (r || '').trim();
}

function git(args) {
  return run('git', { args });
}

// ── 参数解析 ──────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run')     { DRY_RUN = true; continue; }
    if (a === '--no-push')     { args.noPush = true; continue; }
    if (a === '--no-prune')    { args.noPrune = true; continue; }
    if (a === '--no-verify-download') { args.noVerifyDownload = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const val = argv[++i];
      args[key] = val;
      continue;
    }
    positional.push(a);
  }
  args.file = positional[0] || null;
  return args;
}

// ── 文件名解析（复用 res.mjs 的格式）───────────────────────────
// 格式：{slug}-{version}-{platform}-{arch}[-{variant}].{ext}
// 退化：{name}-{version}.{ext}（仅解析 slug + version）
function parseFilename(basename) {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  const parts = stem.split('-');
  if (parts.length >= 4) {
    // 完整格式：slug-version-platform-arch[-variant]
    const [slug, version, platform, arch, ...rest] = parts;
    return { slug, version, platform, arch, variant: rest.join('-') || null, ext };
  }
  if (parts.length >= 2) {
    // 退化格式：name-version（去掉首字母大写，用剩余部分作为 slug）
    const version = parts[parts.length - 1];
    // slug = 所有非版本部分连起来，小写
    const slug = parts.slice(0, -1).join('-').toLowerCase();
    return { slug, version, platform: null, arch: null, variant: null, ext };
  }
  return null;
}

// ── 步骤函数 ──────────────────────────────────────────────────

/** 步骤1：识别文件与参数 */
function resolveFile(args) {
  step(1, '识别文件与参数');

  let filePath = args.file;
  // 未指定文件 → 扫描 inbox
  if (!filePath) {
    const inbox = path.join(ROOT, 'inbox');
    const files = fs.readdirSync(inbox)
      .filter(f => /\.(exe|msi|msix|dmg|zip|7z)$/i.test(f) && !f.startsWith('.'));
    if (files.length === 0) {
      bad('inbox/ 中没有可发布的文件');
      process.exit(1);
    }
    if (files.length > 1) {
      bad('inbox/ 中有多个文件，请指定：');
      files.forEach(f => console.log(`  ${f}`));
      process.exit(1);
    }
    filePath = path.join(inbox, files[0]);
  }

  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    bad(`文件不存在：${abs}`);
    process.exit(1);
  }

  const basename = path.basename(abs);
  const parsed = parseFilename(basename);
  const id = args.id || (parsed?.slug) || '';
  const version = args.version || (parsed?.version) || '';
  const platform = args.platform || (parsed?.platform) || 'windows';
  const arch = args.arch || (parsed?.arch) || 'x64';
  const variant = args.variant ?? (parsed?.variant) ?? 'setup';

  if (!id) { bad('无法识别 --id，请用 --id 指定'); process.exit(1); }
  if (!version) { bad('无法识别 --version，请用 --version 指定'); process.exit(1); }

  // 描述：优先 --desc，其次 inbox/.desc.txt，最后默认
  let desc = args.desc;
  if (!desc) {
    const descFile = path.join(ROOT, 'inbox', '.desc.txt');
    if (fs.existsSync(descFile)) {
      desc = fs.readFileSync(descFile, 'utf8').replace(/^\uFEFF/, '').trim();
    }
  }
  desc = desc || `${id} 资源`;

  const category = args.category || 'installer';

  console.log(`  文件：${basename}（${(fs.statSync(abs).size / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`  id=${id}  version=${version}  platform=${platform}  arch=${arch}  variant=${variant || '(none)'}`);
  console.log(`  category=${category}  desc=${desc.slice(0, 50)}${desc.length > 50 ? '…' : ''}`);

  return { abs, basename, id, version, platform, arch, variant, category, desc };
}

/** 步骤2：发布（res publish） */
function doPublish(info) {
  step(2, '发布资源（res publish）');
  const args = [
    'publish', `"${info.abs}"`,
    '--id', info.id,
    '--category', info.category,
    '--version', info.version,
    '--platform', info.platform,
    '--arch', info.arch,
    '--desc-file', 'inbox/.desc.txt',
  ];
  if (info.variant) args.push('--variant', info.variant);

  const out = run('node', { args: [RES, ...args] });
  console.log(out);
  return out;
}

/** 步骤3：校验（doctor + verify） */
function doVerify(info) {
  step(3, '结构体检 + 一致性校验');

  const doctor = run('node', { args: [RES, 'doctor'] });
  console.log(doctor);

  const verify = run('node', { args: [RES, 'verify', '--id', info.id] });
  console.log(verify);

  // 实测下载
  if (!info.noVerifyDownload) {
    warn('实测下载校验（耗时较长，--no-verify-download 可跳过）');
    const dlDir = path.join(ROOT, 'inbox', 'dl-test');
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    try {
      const get = run('node', { args: [RES, 'get', info.id, '--to', dlDir, '--verify'], timeout: 600_000 });
      console.log(get);
      ok('实测下载通过');
    } finally {
      if (fs.existsSync(dlDir)) fs.rmSync(dlDir, { recursive: true, force: true });
    }
  }
}

/** 步骤4：安全门禁（敏感扫描 + 文本校验） */
function doSecurityScan(stagedFiles) {
  step(4, '安全门禁');

  // 敏感信息扫描
  if (fs.existsSync(SCAN_SCRIPT)) {
    try {
      run(PY.split(' ')[0], {
        args: [...PY.split(' ').slice(1), '-X', 'utf8', SCAN_SCRIPT],
        timeout: 60_000,
      });
      ok('敏感信息扫描通过');
    } catch {
      bad('敏感信息扫描失败，请修复后再提交');
      process.exit(1);
    }
  } else {
    warn(`敏感扫描脚本不存在，跳过：${SCAN_SCRIPT}`);
  }

  // 文本文件 UTF-8/JSON 校验
  const jsonFiles = stagedFiles.filter(f => f.endsWith('.json'));
  for (const f of jsonFiles) {
    const full = path.join(ROOT, f);
    const content = fs.readFileSync(full, 'utf8');
    try { JSON.parse(content); } catch (e) {
      bad(`JSON 解析失败：${f} — ${e.message}`);
      process.exit(1);
    }
    if (content.includes('\uFFFD')) {
      bad(`发现 U+FFFD 乱码：${f}`);
      process.exit(1);
    }
  }
  ok(`文本校验通过（${jsonFiles.length} 个 JSON + ${stagedFiles.length - jsonFiles.length} 个其他）`);
}

/** 步骤5：提交（git add + commit） */
function doCommit(info) {
  step(5, 'Git 提交');

  git(['add', 'registry']);

  const status = git(['status', '--short']);
  if (!status) {
    warn('没有需要提交的变更');
    return null;
  }

  // 自动生成 commit message
  const date = new Date().toISOString().slice(0, 10);
  const msg = [
    `chore(${info.id}): 【新增】${info.version} 安装包并切换 latest @AI G`,
    '',
    `- Release tag ${info.id}-v${info.version}，资产 ${info.basename}`,
    `- 清单新增 ${info.version} 条目：${info.platform}/${info.arch}/${info.variant || '无变体'}、storage=release`,
    `- 同 channel 的 latest 由前版切至 ${info.version}`,
    `- 校验：res doctor 通过；res verify --id ${info.id} 通过`,
    `- 日期：${date}`,
  ].join('\n');

  // 写入临时 commit message 文件
  const msgFile = path.join(ROOT, 'inbox', '.commitmsg.txt');
  fs.writeFileSync(msgFile, msg, 'utf8');

  try {
    const commitOut = git(['commit', '-F', 'inbox/.commitmsg.txt']);
    console.log(commitOut);
    const hash = git(['log', '--oneline', '-1']).split(' ')[0];
    ok(`提交 ${hash}`);
    return hash;
  } finally {
    // 清理临时文件（可选）
  }
}

/** 步骤6：推送 */
function doPush() {
  step(6, '推送到远端');
  try {
    const out = git(['push', 'origin', 'main']);
    console.log(out);
    ok('推送成功');
    return true;
  } catch (e) {
    bad(`推送失败：${e.message}`);
    warn('网络可能中断，稍后可执行 git push origin main');
    return false;
  }
}

/** 步骤7：自动 prune（版本数超过 keep_releases） */
function doAutoPrune(info) {
  if (info.noPrune) return;

  step(7, '检查版本保留策略');

  // 读取 config 获取 keep_releases
  let keep = 3;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry', 'config.json'), 'utf8'));
    keep = cfg?.storage?.keep_releases ?? 3;
  } catch { /* 使用默认值 */ }

  // 读取清单统计版本数
  const resFile = path.join(ROOT, 'registry', 'resources', info.category, `${info.id}.json`);
  const res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
  const liveVersions = (res.versions || []).filter(v =>
    v.storage !== 'release-pruned' && v.files?.length > 0
  );

  if (liveVersions.length <= keep) {
    ok(`在保版本 ${liveVersions.length} 个，未超过 keep_releases=${keep}，无需 prune`);
    return;
  }

  warn(`在保版本 ${liveVersions.length} 个，超过 keep_releases=${keep}，执行 prune`);

  // 预览
  const preview = run('node', { args: [RES, 'prune', '--id', info.id] });
  console.log(preview);

  // 确认并执行
  run('node', { args: [RES, 'prune', '--id', info.id, '--apply'] });

  // 提交 prune 变更
  git(['add', 'registry']);
  const pruneStatus = git(['status', '--short']);
  if (pruneStatus) {
    const hash = git(['log', '--oneline', '-1']).split(' ')[0];
    const pruneMsg = [
      `chore(${info.id}): 【调整】淘汰旧 Release 资产（keep_releases=${keep}） @AI G`,
      '',
      `- res prune --id ${info.id} --apply`,
      `- 在保版本回到 ${keep} 个`,
    ].join('\n');
    fs.writeFileSync(path.join(ROOT, 'inbox', '.commitmsg.txt'), pruneMsg, 'utf8');
    git(['commit', '-F', 'inbox/.commitmsg.txt']);
    const pruneHash = git(['log', '--oneline', '-1']).split(' ')[0];
    ok(`Prune 提交 ${pruneHash}`);

    // 推送 prune 提交
    if (!info.noPush) {
      try { git(['push', 'origin', 'main']); ok('Prune 推送成功'); }
      catch { warn('Prune 推送失败，稍后手动推送'); }
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(c(1, '═══ res-publish 一键发布 ═══'));
  if (DRY_RUN) warn('DRY-RUN 模式：只打印命令，不执行');

  const info = resolveFile(args);
  Object.assign(info, { noPush: args.noPush, noPrune: args.noPrune, noVerifyDownload: args.noVerifyDownload });

  const startTime = Date.now();

  // 发布
  doPublish(info);

  // 校验
  doVerify(info);

  // 安全扫描（对暂存区的 registry 文件）
  const staged = ['registry/CATALOG.md', 'registry/index.json', 'registry/latest.json',
    `registry/resources/${info.category}/${info.id}.json`].filter(f => fs.existsSync(path.join(ROOT, f)));
  doSecurityScan(staged);

  // 提交
  doCommit(info);

  // 推送
  if (!info.noPush) doPush();

  // 自动 prune
  doAutoPrune(info);

  // 完成
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(c(1, '\n═══ 完成 ═══'));
  ok(`${info.id} ${info.version} 发布成功（${elapsed}s）`);
  console.log(`  Release：https://github.com/klaus2918/public-tools/releases/tag/${info.id}-v${info.version}`);
  console.log(`  清单：registry/resources/${info.category}/${info.id}.json`);
}

main().catch(e => {
  bad(e.message);
  process.exit(1);
});
