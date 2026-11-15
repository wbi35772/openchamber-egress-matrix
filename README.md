# Egress Matrix

OpenChamber 的独立本机出口层。装入扩展、点开面板，就能拿到一个（或一组）**稳定的本地混合代理端口**：HTTP CONNECT 与 SOCKS5 同端口，任何本机软件直接填 `127.0.0.1:PORT` 即可。

不依赖 sing-box、不需要下载 JSON 包、不需要手工改端口表。扩展自己监听、自己探测、自己写共享契约。

## 它解决什么

- **给本机软件用**：浏览器、curl、Postman、其他代理客户端，直接连 `http://127.0.0.1:25001` 或 `socks5://127.0.0.1:25001`。
- **给其他扩展用**：读 `~/.openchamber-egress-matrix/endpoints.json`，按租约 key 取端口，不用知道上游是 vless、trojan 还是 SOCKS。
- **多出口**：每个租约一个端口，默认网关跟随“主租约”。国家/账号需要隔离时，各走各的端口。

## 两种上游

| 来源 | 配置方式 | 上游协议 |
| --- | --- | --- |
| 静态节点 | 面板粘贴节点 URI | `vless://`、`trojan://`（WebSocket + TLS）、`socks5://` |
| proxygate | 面板填地址 + API Key，点“同步槽位” | 槽位 SOCKS5 |

静态节点由扩展进程直接实现协议握手，不启动子进程，也不落地节点配置文件。

## 安装

1. 把本目录放进 OpenChamber 扩展目录（或保留在 projects 下由同步脚本复制）。
2. 打开 设置 → 扩展 → Egress Matrix，允许 `service`。
3. 重启 OpenChamber，面板出现后即可使用。

首次打开没有任何出口。添加一个节点，或填好 proxygate 后同步槽位；`默认网关` 会立刻出现在面板顶部。

## 面板

- **默认网关**：`127.0.0.1:25001`（端口可在“本机监听”里改），显示当前出口 IP、最近探测、连接数。
- **租约出口**：每条租约的 key、端口、国家、出口 IP、探测/设为主/删除。
- **静态节点**：名称 + URI，可单独测试（会临时起一个监听并走完整链路取 IP）。
- **proxygate**：地址、API Key、公开 SOCKS 主机、SOCKS 密码、国家；同步后槽位变成租约。
- **本机监听**：默认端口、端口池起点/大小、探测 URL。
- **共享契约**：`endpoints.json` 与 `proxies.txt` 的路径，可一键复制。

## 给其他程序 / 扩展的契约

数据目录：`~/.openchamber-egress-matrix`（可用 `EGRESS_MATRIX_DATA_DIR` 覆盖）。

`endpoints.json`：

```json
{
  "version": 1,
  "updatedAt": "2026-11-15T00:00:00.000Z",
  "host": "127.0.0.1",
  "primary": "lease_id",
  "default": { "key": "default", "port": 25001, "proxy": "http://127.0.0.1:25001", "socks": "socks5://127.0.0.1:25001", "exitIp": "", "ok": true },
  "byKey": { "default": { }, "node/instabox-8443": { } },
  "lanes": [ ]
}
```

`proxies.txt`：每行 `国家\tHTTP 地址\tSOCKS 地址`，方便直接粘贴。

其他扩展的最小接法：读 `byKey['<租约 key>'].port`，把原本的上游代理指向 `127.0.0.1:<port>`；没有该 key 就失败，不要回退直连。

## 本地服务 API

所有请求走宿主注入的 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 引擎、监听、出口 IP、文件位置 |
| GET/PUT | `/api/config` | 设置、节点、proxygate 配置 |
| GET | `/api/endpoints` | 实时监听 + 落盘契约 |
| POST | `/api/nodes` | 添加静态节点 `{name,uri}` |
| PATCH/DELETE | `/api/nodes/:id` | 改名/改 URI、删除（级联租约） |
| POST | `/api/nodes/:id/probe` | 临时链路探测 |
| GET/POST | `/api/leases` | 列表 / 新建静态租约 |
| PATCH/DELETE | `/api/leases/:id` | 设为主、删除 |
| POST | `/api/leases/:id/probe` | 走真实监听探测 |
| POST | `/api/proxygate/sync` | 拉槽位并同步租约 |
| POST | `/api/proxygate/allocate` | 申请新槽位 |
| POST | `/api/proxygate/rotate` | 轮换槽位 `{slotId}` |
| POST | `/api/reconcile` | 重算监听 |
| POST | `/api/probe` | 全量探测 |

## 边界

- 只支持 TCP；不处理 UDP ASSOCIATE。
- 上游只支持 VLESS/Trojan over WebSocket（含 TLS）与 SOCKS5；REALITY、gRPC、H2、SS 暂不支持。
- 本地监听只绑 `127.0.0.1`，不对局域网开放。
- proxygate 槽位需要可公网访问的 SOCKS 主机；面板不会替你穿透内网。
- 端口被占用时：默认网关自动顺延，租约端口在池内重新分配。

## 测试

```bash
npm test
```

覆盖：节点 URI 解析、SOCKS5/HTTP CONNECT/absolute-form 转发、VLESS 握手与 WebSocket 帧、proxygate 槽位归一化与同步、endpoint 文件写入。
