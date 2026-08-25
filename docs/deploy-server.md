# 服务器部署指南

CodeForge 服务器 = 后端 API + 加速器中继 + 工具链清单分发。
推荐 Docker Compose 一键部署，也可裸 Node 运行。

## 1. Docker Compose 部署（推荐）

```bash
git clone https://github.com/monikalnbo/lnbocharm.git && cd lnbocharm
docker compose up -d
```

服务监听 `8787` 端口。工具链容器池（gcc/rust/java/dotnet/python/node）
随 compose 一并启动，供 Docker 构建模式使用。

## 2. 环境变量

| 变量 | 作用 | 不设置时 |
| --- | --- | --- |
| `CODEFORGE_TOKEN` | /ws 握手与数据面鉴权令牌；**设置后明文 REST 自动封锁** | 允许匿名 |
| `CODEFORGE_E2E` | 设为 `1` 强制端到端加密（ECDH+AES-GCM） | 允许明文 WS |
| `CODEFORGE_RELAY_TOKEN` | 加速器隧道令牌 | 允许匿名 |
| `CODEFORGE_RELAY_FPS` | **设备指纹白名单**（逗号分隔）；未列入即拒绝 | 不限设备 |
| `CODEFORGE_TOOLCHAINS` | 工具链清单与压缩包目录 | `<repo>/toolchains/` |
| `PORT` | 监听端口 | 8787 |

生产环境建议全部启用：

```yaml
environment:
  CODEFORGE_TOKEN: "换成强随机串"
  CODEFORGE_E2E: "1"
  CODEFORGE_RELAY_TOKEN: "换成另一个强随机串"
```

## 3. 设备指纹授权工作流

1. 新桌面设备连接加速器 → 服务器拒绝并在日志打印其指纹：
   `[relay] ⛔ 拒绝未知设备指纹: "abc123…" — 将其加入白名单以放行`
2. 将指纹追加到白名单（二选一）：
   - 环境变量 `CODEFORGE_RELAY_FPS=abc123…,def456…`
   - 文件 `~/.codeforge/relay-fps.json` → `{"fps": ["abc123…"]}`
3. 该设备永久放行。

## 4. TLS（必须）

对外入口务必套 TLS，否则客户端 E2E 之外仍有元数据暴露面：

```nginx
server {
    listen 443 ssl;
    server_name codeforge.example.com;
    ssl_certificate     /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WS 升级
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;                    # 终端/构建长连接
    }
}
```

客户端连接地址相应改为 `https://codeforge.example.com`。

## 5. 工具链包分发

服务器**零带宽**方案：工具链压缩包托管在 GitHub Release，
`manifest.json` 的 `url` 直接指向 Release 资产，服务器仅下发几 KB 清单。
准备流程见 [toolchains.md](toolchains.md)。

```bash
# 同步最终 manifest 到服务器
rsync toolchains/manifest.json server:/opt/codeforge/toolchains/
```

## 6. 安全清单（上线前核对）

- [ ] `CODEFORGE_TOKEN` 与 `CODEFORGE_RELAY_TOKEN` 均为强随机值
- [ ] `CODEFORGE_E2E=1` 已开启
- [ ] 设备指纹白名单已配置且为空集默认拒绝
- [ ] TLS 证书有效，HTTP 80 仅做跳转
- [ ] 防火墙仅暴露 443（8787 不要直接对公网开放）
- [ ] 服务器时钟准确（GCM nonce 与 token 时序依赖系统时间）

## 7. 客户端配置

桌面端：设置面板 → 连接 → 填入服务器地址与 WS 访问令牌 → 重启应用。
加速器隧道与工具链下载地址会自动从服务器地址派生。
