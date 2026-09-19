# 发布 / 更新 / 取用流程

> 所有操作统一入口：`node scripts/res.mjs <命令>`（仓库根目录执行）

## 零、一键发布（推荐）

```powershell
# 最简用法：文件放 inbox/ 后直接执行（自动识别文件名参数）
node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe

# 指定参数（文件名不规范时）
node scripts/res-publish.mjs inbox/MyTool.exe --id mytool --version 1.0.0 --platform windows --arch x64

# dry-run 预览（不执行任何操作）
node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe --dry-run

# 只发布不推送
node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe --no-push

# 跳过实测下载（加速）
node scripts/res-publish.mjs inbox/WenzFlow-1.0.15.exe --no-verify-download
```

**一键发布自动完成**：
1. 识别文件参数（从文件名解析或手动指定）
2. 上传 Release + 写清单 + 重建索引
3. 结构体检（doctor）+ 一致性校验（verify）
4. 安全门禁（敏感信息扫描 + 文本校验）
5. Git 提交（自动生成规范 commit message）
6. 推送到远端
7. 版本保留策略检查（超 `keep_releases` 自动 prune + 提交）

**常用参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--id` | 资源 ID | 从文件名解析 |
| `--version` | 版本号 | 从文件名解析 |
| `--platform` | 平台 | windows |
| `--arch` | 架构 | x64 |
| `--variant` | 变体 | setup |
| `--category` | 分类 | installer |
| `--desc` | 描述 | 读取 `inbox/.desc.txt` |
| `--no-push` | 只提交不推送 | false |
| `--no-prune` | 不自动 prune | false |
| `--no-verify-download` | 不实测下载 | false |
| `--dry-run` | 只打印命令不执行 | false |

**文件名规范**：`{slug}-{version}-{platform}-{arch}[-{variant}].{ext}`
- 完整格式：`wenzflow-1.0.15-windows-x64-setup.exe`（自动识别所有参数）
- 退化格式：`WenzFlow-1.0.15.exe`（识别 slug + version，其余用默认值）

**幂等保护**：同 `id + version` 已存在时 `publish` 默认拒绝，需显式 `--force`。

## 一、发布新资源（手动步骤）

```powershell
# 1) 文件放 inbox\（或任意路径）
# 2) 先扫描，确认识别结果
node scripts/res.mjs scan

# 3) 发布（文件名规范时多数参数可省略）
node scripts/res.mjs publish inbox\wenzflow-1.0.8-windows-x64-setup.exe `
     --id wenzflow --category installer --desc "WenzFlow 桌面客户端" --tags editor,windows
```

自动完成：
1. 文件名规范化（必要时重命名，原名记入 `orig_name`）
2. 计算 `size` + `sha256`
3. 判定承载：`git`（复制进 `assets/<category>/<id>/<version>/`）或 `release`（建 tag `{id}-v{version}` 并上传资产）
4. 写入/更新 `registry/resources/<category>/<id>.json`（新版本自动把同 channel 的 `latest` 切过来）
5. 重建 `index.json` / `latest.json` / `CATALOG.md`
6. 打印下一步 git 命令

常用参数：`--version`、`--platform`、`--arch`、`--variant`、`--kind`、`--channel beta`、`--sub`、`--force`（覆盖同版本同名）、`--no-upload`（只登记不传）。

## 二、更新与替换

| 场景 | 命令 |
|------|------|
| 发新版本 | `res publish <新文件> --id wenzflow`（自动切换 latest） |
| 同版本内容修正 | `res replace wenzflow 1.0.8 inbox\fixed.exe`（rev+1，记 CHANGELOG） |
| 改元信息 | `res set wenzflow --status deprecated --notes "改用 2.x"` |
| 弃用 / 停用 | `--status deprecated`（可取用但提示）／`--status yanked`（默认拒取，需 `--allow-yanked`） |
| 版本保留（淘汰旧版） | `res prune --id wenzflow`（dry-run 预览）→ `res prune --id wenzflow --apply`（按 `keep_releases` 保留最近 N 版，更老的 Release 资产删除，清单条目保留为 `release-pruned`，URL 留档；`res get` 取被淘汰版本会明确拒绝） |

**幂等保护**：同 `id + version + filename` 已存在时 `publish` 默认拒绝，需显式 `--force`。

## 三、取用（下载）

```powershell
node scripts/res.mjs list --category installer            # 查询
node scripts/res.mjs get wenzflow                          # 取 latest（默认当前目录）
node scripts/res.mjs get wenzflow --version 1.0.8 --to .\bin --verify
node scripts/res.mjs get wenzflow --platform windows --arch x64
```

下载链路：

```
内容寻址缓存命中（%USERPROFILE%\.tools-res\cache\<sha256>）
   └─ 未命中 → 候选源按策略依次尝试（direct-first：直连 → 镜像；mirror-first：反过来）
        └─ curl 断点续传（-C -）→ 校验 SHA256 → 失败自动换下一个源
```

## 四、索引与校验

```powershell
node scripts/res.mjs index          # 重建 index.json / latest.json / CATALOG.md
node scripts/res.mjs doctor         # 清单结构体检（id 唯一/命名/latest 唯一/孤儿文件/超阈值）
node scripts/res.mjs verify --all   # 清单 vs 实物哈希 + URL 可达性
```

## 五、提交与推送

```powershell
git add registry assets
git commit -m "publish(wenzflow): 【新增】1.0.8 安装包 @AI G"
git push
```

> 清单是纯文本小文件，可放心频繁提交；二进制只在 `assets/` 且受 20 MB 阈值约束，仓库不会膨胀。

## 六、典型场景速查

| 场景 | 做法 |
|------|------|
| 只在本地新增一个工具 | 丢 `inbox\` → `res scan` → `res publish ...` |
| 换了新机器的工具包 | `res get wenzflow --to D:\mysoft` |
| 想批量装一套 | 写 `profiles/xxx.json` 列出 id 列表，逐个 `res get` |
| 发现清单与文件不一致 | `res verify --all` 定位 → `res replace` 修正 |
| 加速失效 | `res mirror --test` 测速 → 编辑 `registry/config.json` 的镜像开关 |
