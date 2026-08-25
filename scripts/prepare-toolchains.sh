#!/usr/bin/env bash
# =============================================================================
# CodeForge 工具链包准备脚本（在构建机上执行，产物同步到 GitHub Release）
#
# 用法:
#   ./prepare-toolchains.sh [--platform linux|win|mac] [--out DIR]
#
# 产物: $OUT/<toolchain>-<version>-<platform>.tar.gz + toolchains/manifest.json
# 说明: 下载的压缩包均为各官方渠道的便携发行版，解压即用。
#       manifest 的 url 指向 GitHub Release（toolchains-v1 tag），
#       客户端一键安装直接从 GitHub 拉取，服务器零带宽。
# =============================================================================
set -euo pipefail

PLATFORM="all"
OUT="$(cd "$(dirname "$0")/.." && pwd)/toolchains"
GH_RELEASE_BASE="https://github.com/monikalnbo/lnbocharm/releases/download/toolchains-v1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUT"

download() { # url -> 文件
  echo "[dl] $1"
  curl -fSL --retry 3 -o "$2" "$1"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# ---------- 各工具链打包函数 ----------
pack_dir_as_tar() { # srcDir outName topEntry
  local src="$1" name="$2"
  tar -czf "$OUT/$name" -C "$(dirname "$src")" "$(basename "$src")"
}

build_gcc_linux() {
  local ver="13.2.0" name="gcc-${ver}-linux-x64.tar.gz"
  download "https://github.com/brechtsanders/winlibs_gcc/releases/download" /dev/null 2>/dev/null || true
  # Linux 直接使用发行版 portable 构建：这里以 x86_64 gcc 归档为例
  echo "[gcc/linux] 请将预下载的便携 gcc 放入 $OUT/src/gcc-linux 后重试，或使用系统 tar 打包 /usr/bin 相关文件"
  # 示例: pack_dir_as_tar "$HOME/portable/gcc-13.2" "$name"
}

build_node_ts() {
  local ver="20.17.0"
  for plt in linux-x64 win-x64 mac-x64 mac-arm64; do
    case $plt in
      linux-x64) fname="node-v${ver}-linux-x64.tar.gz";;
      win-x64)   fname="node-v${ver}-win-x64.zip";;
      mac-x64)   fname="node-v${ver}-darwin-x64.tar.gz";;
      mac-arm64) fname="node-v${ver}-darwin-arm64.tar.gz";;
    esac
    download "https://nodejs.org/dist/v${ver}/${fname}" "$OUT/$fname"
  done
  # tsc 随 npm 全局安装即可，无需单独包；此处仅归档 node
}

build_rust() {
  local ver="1.79.0"
  for triple in x86_64-unknown-linux-gnu x86_64-pc-windows-msvc aarch64-apple-darwin; do
    download "https://static.rust-lang.org/dist/rust-${triple}-${ver}.tar.gz" \
             "$OUT/rust-${ver}-${triple}.tar.gz" || true
  done
}

build_jdk() {
  local ver="21.0.4+7"
  download "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jdk_x64_linux_hotspot_21.0.4_7.tar.gz" \
           "$OUT/jdk-21-linux-x64.tar.gz"
}

build_dotnet() {
  download "https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.401/dotnet-sdk-8.0.401-linux-x64.tar.gz" \
           "$OUT/dotnet-sdk-8-linux-x64.tar.gz"
}

# ---------- 执行 ----------
case "$PLATFORM" in
  linux|all) build_node_ts ;;
  all) build_rust || true; build_jdk || true; build_dotnet || true ;;
esac

# ---------- 生成 manifest ----------
echo "[$OUT] 生成 manifest.json ..."
{
  echo "["
  first=1
  for f in "$OUT"/*.tar.gz "$OUT"/*.zip; do
    [[ -f "$f" ]] || continue
    [[ $first -eq 0 ]] && echo ","
    first=0
    base=$(basename "$f")
    size=$(stat -c%s "$f")
    sha=$(sha256_of "$f")
    cat <<EOF
  { "id": "${base%.tar.gz}", "version": "", "platform": "",
    "size": ${size}, "sha256": "${sha}",
    "url": "${GH_RELEASE_BASE}/${base}" }
EOF
  done
  echo "]"
} > "$OUT/manifest.json"

echo "完成 ✓"
echo "后续步骤:"
echo "  1. 校验并补全 manifest 中 language/version/platform 字段"
echo "  2. gh release create toolchains-v1 --title 'Toolchain Packs' \$OUT/*.tar.gz \$OUT/manifest.json"
echo "  3. 将最终 manifest.json 同步到服务器 CODEFORGE_TOOLCHAINS 目录"
