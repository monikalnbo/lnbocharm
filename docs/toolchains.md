# 工具链包管理与一键安装

CodeForge 客户端的"一键安装工具链"从 **GitHub Release** 拉取压缩包（服务器零带宽），
服务器仅托管一份轻量 `manifest.json` 清单。

## 数据流

```
客户端构建报 CF2003(缺工具链)
  → 一键安装按钮 → GET 服务器 /api/toolchains        （清单，几 KB）
                  → GET entry.url (GitHub Release)    （压缩包，直连）
                  → SHA256 校验 → 解压到 tools/<id>   → 自动重跑构建
```

## manifest 格式

`manifest.json` 为数组，每项：

| 字段 | 说明 |
|---|---|
| id | 唯一标识，如 `gcc-13.2-win-x64` |
| language | 关联语言（c/cpp/rust/java/csharp/python/typescript） |
| version | 工具链版本 |
| platform | linux / win32 / darwin |
| size | 字节数 |
| sha256 | 完整性校验值（必填，客户端安装时强校验） |
| url | 下载直链（GitHub Release 资产地址；留空则回退服务器本地分发） |

示例见 [`toolchains/manifest.example.json`](../toolchains/manifest.example.json)。

## 准备工具链包

在构建机上执行：

```bash
scripts/prepare-toolchains.sh            # 全平台
scripts/prepare-toolchains.sh --platform linux
```

脚本会下载各官方渠道的便携发行版、重命名归档到 `toolchains/`、生成带 SHA256 的
`manifest.json`（url 已指向本仓库 Release）。

## 发布到 GitHub

```bash
gh release create toolchains-v1 \
  --title "Toolchain Packs v1" \
  toolchains/*.tar.gz toolchains/manifest.json
```

然后把最终 `manifest.json` 放到服务器的 `CODEFORGE_TOOLCHAINS` 目录（默认
`<repo>/toolchains/`）。服务器对 `url` 型条目做 302 重定向——**零带宽消耗**。

## 客户端体验

构建时报 CF2003（缺工具链）→ 构建面板出现"一键安装 xxx"按钮 → 下载+校验+解压
→ 自动重跑构建。全程无需手动操作。
