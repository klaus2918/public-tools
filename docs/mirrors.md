# 镜像与加速说明

## 策略

`registry/config.json → mirrors.policy`：

| 值 | 含义 |
|----|------|
| `direct-first`（默认） | 先试权威地址（GitHub 直连），失败/超时再依次试镜像前缀 |
| `mirror-first` | 先试镜像，再回退直连（国内网络下更省时间，但经过第三方） |

`mirrors.timeout_seconds`（默认 5）控制单源超时，快速失败换源。

## 三类链路

| 资源类型 | 主链路 | 加速链路 |
|----------|--------|----------|
| 清单（`registry/*.json`） | `raw.githubusercontent.com` | jsDelivr CDN（`cdn.jsdelivr.net/gh/klaus2918/tools@main/...`） |
| 轻资产（`assets/`，< 20 MB） | raw | jsDelivr（国内节点友好） |
| 重资产（Release 资产） | `github.com/.../releases/download/...` | `gh-proxy` / `ghfast` 等前缀 |

**清单可零克隆获取**：`https://cdn.jsdelivr.net/gh/klaus2918/tools@main/registry/latest.json` 一条 GET 即可拿到全部最新资源坐标。

## 风险与对策

| 风险 | 对策（已内建） |
|------|----------------|
| 代理篡改内容 | 下载后强制 SHA256 校验，不匹配即换源重试 |
| 凭据泄露 | 上传、Release 创建、`git push` 永不经过镜像；镜像只用于公开资源匿名 GET |
| 代理不稳/限速 | 短超时快速失败、多源顺序回退、可一键关闭 |
| 公共代理不支持 Range | 续传失败自动回退直连重下 |
| 中间缓存返回旧版 | 文件名含版本号 + SHA256 判定，旧内容直接拒 |
| 隐私暴露（IP/UA/下载内容） | 域名写在配置文件里，可随时清空；不需要时 `enabled:false` |

更稳的替代方案：自建 Cloudflare Worker 反代，或把大资源同步一份到 Gitee/GitCode，在清单 `files[].mirrors` 里追加该地址。

## 配置示例

```jsonc
"mirrors": {
  "policy": "direct-first",
  "timeout_seconds": 5,
  "release_prefixes": [
    { "id": "direct",  "tpl": "{url}",                          "enabled": true  },
    { "id": "gh-proxy","tpl": "https://gh-proxy.com/{url}",     "enabled": true  },
    { "id": "ghfast",  "tpl": "https://ghfast.top/{url}",       "enabled": false }
  ],
  "raw_prefixes": [
    { "id": "jsdelivr", "tpl": "https://cdn.jsdelivr.net/gh/klaus2918/tools@{branch}/{path}", "enabled": true },
    { "id": "raw",      "tpl": "https://raw.githubusercontent.com/klaus2918/tools/{branch}/{path}", "enabled": true }
  ]
}
```

模板变量：`{url}`（文件权威地址）、`{branch}`、`{path}`（仓库内相对路径）、`{filename}`。

## 测速与切换

```powershell
node scripts/res.mjs mirror            # 查看当前策略与镜像开关
node scripts/res.mjs mirror --test     # 实测各 release 镜像耗时并排序
```

测速结果仅供参考（受网络波动影响），按结果调整 `enabled` 开关即可，无需改代码。

## 本地缓存

- 位置：`%USERPROFILE%\.tools-res\cache\<sha256[0:2]>\<sha256>`（内容寻址）
- 命中即直接复制到目标目录，不再走网络
- 同一文件重复取用（多项目/多机器同盘）零成本
- 清理：直接删除该目录；不会影响仓库与清单
