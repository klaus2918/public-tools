# tools · 工具资源仓库

统一存放可分发资源的仓库：**清单是唯一事实源，文件是清单的履约物，索引全部由脚本派生。**

- 轻资产（单文件 < 20 MB）直接入库 `assets/`，走 jsDelivr CDN 取用
- 重资产（≥ 20 MB 或安装包）发布到 GitHub Releases，清单记录 URL + SHA256
- 一个资源一份清单分片，任何机器只需一次 HTTPS 就能查到"最新版在哪"

---

## 目录结构

```
tools/
├─ registry/
│  ├─ schema.json        字段规范与枚举（校验依据）
│  ├─ config.json        阈值、镜像、命名规则（唯一可手改的配置）
│  ├─ resources/<category>/<id>.json   清单分片（一资源一文件）
│  ├─ index.json         派生：全量机读索引
│  ├─ latest.json        派生：仅最新版（客户端秒查）
│  └─ CATALOG.md         派生：人读总览
├─ assets/<category>/<id>/<version>/   轻资产实体文件
├─ scripts/res.mjs       唯一 CLI（Node ≥ 18，零第三方依赖）
├─ profiles/             资源组合（一次取一套）
├─ inbox/                待发布暂存（不入库）
└─ docs/                 命名规范 / 流程 / 镜像说明
```

---

## 快速开始

### 取用（下载）

```powershell
node scripts/res.mjs list                       # 看看有什么
node scripts/res.mjs list --category installer   # 按分类过滤
node scripts/res.mjs get wenzflow --verify       # 取最新版并校验 SHA256
node scripts/res.mjs get wenzflow --version 1.0.8 --to .\bin
```

下载链路：本地缓存命中 → 直连 → 镜像回退（`direct-first`）；断点续传；结束校验 SHA256。

### 一键发布（推荐）

```powershell
# 文件放 inbox\ 后一条命令走完全流程：发布 → 体检/校验 → 安全门禁 → 提交 → 推送 → 按需 prune
node scripts/res-publish.mjs inbox\WenzFlow-1.0.15.exe

# 文件名不规范时补参数；--dry-run 只预览不执行
node scripts/res-publish.mjs inbox\op-skills-pack-1.0.5.zip --id op-skills-pack `
     --version 1.0.5 --platform any --arch any --category toolchain --dry-run
```

> 详细参数与承载方式（Release / assets）见 `docs/workflow.md`「一键发布」章节。

### 发布（上传新资源）

```powershell
# 文件放 inbox\ 或直接给路径
node scripts/res.mjs scan                                     # 先看识别结果
node scripts/res.mjs publish inbox\WenzFlow-1.0.8-windows-x64-setup.exe `
     --id wenzflow --category installer --desc "WenzFlow 桌面客户端"
```

自动完成：文件名规范化 → 计算 size/SHA256 → 判定承载（Git / Release）→ 写清单 → 重建索引 → 自检。

### 更新与替换

```powershell
node scripts/res.mjs publish <新版文件> --id wenzflow     # 新版本，latest 自动切换
node scripts/res.mjs replace wenzflow 1.0.8 <修正文件>     # 同版本原地修正（rev+1）
node scripts/res.mjs set wenzflow --status deprecated      # 元信息维护
node scripts/res.mjs prune --id wenzflow                   # 版本保留：预览待淘汰的旧 Release
node scripts/res.mjs prune --id wenzflow --apply           # 确认后删除（清单条目留档）
```

---

## 分类（`category`，固定枚举）

| 值 | 用途 |
|----|------|
| `installer` | 安装包（exe / msi / msix / dmg） |
| `portable` | 便携版、免安装归档 |
| `cli` | 命令行工具 |
| `lib` | 库与依赖包 |
| `toolchain` | 构建工具链及外部依赖 |
| `plugin` | 插件与扩展 |
| `asset` | 素材（图标 / 字体） |
| `template` | 模板与脚手架 |
| `dataset` | 数据与样本 |
| `config` | 配置预设 |
| `doc` | 文档资料 |
| `other` | 临时未分类（`doctor` 会告警） |

二级细分用自由的 `subcategory` 字段（如 `installer/agent-client`）。

---

## 命名规范

```
{slug}-{version}-{platform}-{arch}[-{variant}].{ext}
例：wenzflow-1.0.8-windows-x64-setup.exe
```

`slug` 小写连字符；`platform` ∈ windows/linux/macos/android/any；`arch` ∈ x64/arm64/x86/any。
内容变更必须换版本号，**不覆盖同名文件**；紧急修正走 `replace`（留 `rev` 痕迹）。

---

## 配置与加速

`registry/config.json` 可调：

| 键 | 说明 |
|----|------|
| `storage.light_asset_max_bytes` | 入 Git 的体积阈值（默认 20 MB） |
| `storage.keep_releases` | 每资源保留的 Release 版本数（默认 3），由 `res prune` 执行：超出的旧资产删除，清单条目保留并标记 `release-pruned`（URL 留档可查） |
| `mirrors.policy` | `direct-first`（默认，直连优先失败回退）或 `mirror-first` |
| `mirrors.release_prefixes` / `raw_prefixes` | 加速前缀模板，可增删/置 `enabled:false` |

**镜像风险须知**：第三方代理是流量终点，能改内容也能看到请求头。因此
① 二进制下载一律校验 SHA256；② 上传、Release 创建、`git push` 永不经过镜像；
③ 镜像域名写在本配置里，随时可清空。

```powershell
node scripts/res.mjs mirror --test      # 实测各镜像耗时并排序
```

### 仓库可见性与取用链路

CLI 按 `config.json → repo.private` 自动切换，两种模式无需重新上传即可互转（发布时始终记录 `asset_id`）：

| 模式 | Release 资产 | Git 轻资产 | 镜像加速 | 匿名可下载 |
|------|--------------|-----------|---------|-----------|
| **公开**（当前） | `github.com/{o}/{r}/releases/download/{tag}/{file}`，匿名可用 | jsDelivr CDN → raw | ✅ | ✅ |
| 私有 | API `/repos/{o}/{r}/releases/assets/{asset_id}`（`Accept: application/octet-stream`） | API `/contents/{path}?ref={branch}`（`Accept: application/vnd.github.raw`） | ❌ 镜像无法携带认证 | ❌ |

实测（2026-09-13 本机）：

- 私有模式：`releases/download` 链接**带 token 也返回 404**，必须走 API 资产端点（206，可续传）
- 公开模式：同一文件匿名下载 55.31 MB 用时 **47 秒（≈1.2 MB/s）**，`verify` 全绿，jsDelivr 清单返回 200
- 凭据来源（仅私有模式需要）：`GITHUB_TOKEN` 环境变量 → 否则 `git credential fill` 读取，**不落盘、不入库**
- 历史数据缺 `asset_id` 时用 `node scripts/res.mjs fix-assets` 回填

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `init` | 幂等创建仓库骨架 |
| `scan [dir]` | 扫描待发布文件，输出识别结果与待人工指定清单 |
| `publish <file>` | 发布资源（自动命名/哈希/分流/清单/索引） |
| `replace <id> <version> <file>` | 同版本原地替换（rev+1） |
| `set <id>` | 修改元信息（status/notes/tags/description） |
| `list` | 过滤查询（category/platform/arch/tag/status/keyword） |
| `get <id>` | 取用资源（镜像回退、续传、缓存、校验） |
| `index` | 重建 index.json / latest.json / CATALOG.md |
| `doctor` | 清单结构体检 |
| `verify [--id X] [--all]` | 实物与清单一致性、URL 可达性 |
| `prune [--id X] [--keep N] [--apply]` | 版本保留：淘汰超出 `keep_releases` 的旧 Release 资产（默认 dry-run，清单条目留档为 `release-pruned`） |
| `mirror` | 镜像测速与策略切换 |

> 发布到 Releases 需要 GitHub Token：优先读环境变量 `GITHUB_TOKEN`，否则尝试从 git 凭据管理器（`git credential fill`）获取。Token 不落盘、不入库。
