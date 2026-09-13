# 命名与分类规范

## 文件名格式

```
{slug}-{version}-{platform}-{arch}[-{variant}].{ext}
```

| 段 | 规则 | 示例 |
|----|------|------|
| `slug` | 小写字母/数字/连字符，与清单 `id` 完全一致 | `wenzflow`、`op-worker` |
| `version` | SemVer（`1.0.8`）或日期版（`20260913`），不含 `v` 前缀 | `1.0.8` |
| `platform` | `windows` / `linux` / `macos` / `android` / `any` | `windows` |
| `arch` | `x64` / `arm64` / `x86` / `any` | `x64` |
| `variant` | 可选，多个用连字符连接：`setup` / `portable` / `setup-unsigned` | `setup-unsigned` |
| `ext` | 小写扩展名 | `.exe` |

示例：`wenzflow-1.0.8-windows-x64-setup.exe`、`op-worker-0.2.0-windows-x64-setup-unsigned.exe`

## 解析规则（`res scan` / `res publish` 使用）

从右往左找「平台 + 架构」相邻段：

```
op-worker-0.2.0-windows-x64-setup-unsigned.exe
└─ slug ─┘ └ver┘ └plat─┘ └arch┘ └── variant ──┘
```

- 找不到平台/架构段 → 判定为 `manual`，需 `--platform/--arch/--version` 显式指定，**不做猜测**
- `res publish` 会按规范重命名，源文件名记入 `orig_name` 保留追溯
- 原始文件名与规范一致时不改名

## 硬性规则

1. **不覆盖同名文件**：内容变了就换版本号
2. **原地修正**用 `res replace`，写入 `rev+1` 与 `revised_at`，并记入 `registry/CHANGELOG.md`
3. 一个文件只属于一个资源（`id`）；同名不同平台/架构视为同版本的多个 file 条目

## 分类（`category`，固定枚举）

| 值 | 用途 | 典型扩展名 |
|----|------|-----------|
| `installer` | 安装包 | exe / msi / msix / dmg / pkg |
| `portable` | 便携版、免安装归档 | zip / 7z |
| `cli` | 命令行工具 | exe / bat / ps1 |
| `lib` | 库与依赖包 | dll / nupkg / whl / jar |
| `toolchain` | 构建工具链及外部依赖 | zip |
| `plugin` | 插件与扩展 | vsix / 插件包 |
| `asset` | 素材（图标 / 字体 / 模板图） | ico / png / ttf |
| `template` | 模板与脚手架 | zip |
| `dataset` | 数据与样本 | json / csv / zip |
| `config` | 配置预设 | json / yaml |
| `doc` | 文档资料 | pdf / md |
| `other` | 临时未分类（`doctor` 会告警） | — |

二级细分用自由的 `subcategory`（如 `installer/agent-client`），不设枚举。

## 承载判定

```
size <= config.storage.light_asset_max_bytes（默认 20 MB）→ storage=git（入 assets/，走 jsDelivr）
size >  阈值                                            → storage=release（GitHub Releases）
```

用于覆盖默认判定的参数：`res publish ... --storage git|release`。
