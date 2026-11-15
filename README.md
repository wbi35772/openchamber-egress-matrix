# Egress Matrix

OpenChamber 的独立本机出口层。装入扩展、点开面板，就能拿到一个（或一组）**稳定的本地混合代理端口**：HTTP CONNECT 与 SOCKS5 同端口，任何本机软件直接填 `127.0.0.1:PORT` 即可。

不依赖 sing-box、不需要下载 JSON 包、不需要手工改端口表。扩展自己监听、自己探测、自己写共享契约。

## 它解决什么

- **给本机软件用**：浏览器、curl、Postman、其他代理客户端，直接连 `http://127.0.0.1:25001` 或 `socks5://127.0.0.1:25001`。
- **给其他扩展用**：读 `~/.openchamber-egress-matrix/endpoints.json`，按租约 key 取端口，不用知道上游是 vless、trojan 还是 SOCKS。
- **多出口**：每个租约一个端口，默认网关跟随“主租约”。国家/账号需要隔离时，各走各的端口。

## 三种接入

| 来源 | 配置方式 | 上游协议 |
| --- | --- | --- |
| 手动节点 | 面板「节点池」粘贴一条节点 URI | `vless://`、`trojan://`（WebSocket + TLS）、`socks5://` |
| 订阅 | 面板「订阅」填 URL；支持明文或 base64 节点列表 | 同手动节点，整池导入 |
| proxygate | 面板「上游」填地址 + API Key，点「同步槽位」 | 槽位 SOCKS5 |

静态节点和订阅节点由扩展进程直接实现协议握手，不启动子进程，也不落地节点配置文件。

## 安装

1. 把本目录放进 OpenChamber 扩展目录（或保留在 projects 下由同步脚本复制）。
2. 打开 设置 → 扩展 → Egress Matrix，允许 `service`。
3. 重启 OpenChamber，面板出现后即可使用。

首次打开没有任何出口。添加一个节点、导入订阅，或填好 proxygate 后同步槽位；`默认网关` 会立刻出现在「总览」。

## 面板

按功能分成六个标签：

- **总览**：默认网关端口、出口 IP、最近探测、连接数，以及线路和契约文件速览。
- **出口线路**：全部租约；可复制代理地址、改端口、设为主出口、探测、删除，也能显式新建租约。
- **节点池**：手动添加单条节点 URI；列表显示来源（手动/订阅）、协议、探测和建租约。
- **订阅**：导入整池节点；可同步、批量建租约（可指定起始端口）、删除。同步只更新本订阅节点，不碰手动节点。
- **上游**：proxygate 地址、API Key、公开 SOCKS 主机、SOCKS 密码、默认国家；同步槽位、分配槽位、换出口 IP。
- **设置**：默认端口、端口池起点/大小、探测 URL、契约文件路径、手动协调/全量探测。

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
| GET/PUT | `/api/config` | 设置、节点、订阅、proxygate 配置 |
| GET | `/api/endpoints` | 实时监听 + 落盘契约 |
| POST | `/api/nodes` | 添加静态节点 `{name,uri}` |
| PATCH/DELETE | `/api/nodes/:id` | 改名/改 URI、删除（级联租约） |
| POST | `/api/nodes/:id/probe` | 临时链路探测 |
| GET/POST | `/api/subscriptions` | 订阅列表 / 导入 `{name,url,keyPrefix,autoLease}` |
| PATCH/DELETE | `/api/subscriptions/:id` | 修改 / 删除（级联本订阅节点与租约） |
| POST | `/api/subscriptions/:id/sync` | 重新拉取订阅 |
| POST | `/api/subscriptions/:id/leases` | 批量建租约 `{keyPrefix,startPort,country}` |
| GET/POST | `/api/leases` | 列表 / 新建静态租约（可带 `port` 钉端口） |
| POST | `/api/leases/batch` | 按订阅批量建租约 |
| PATCH/DELETE | `/api/leases/:id` | 改 key/端口/国家、设为主、删除 |
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
- 端口被占用时：默认网关自动顺延，租约端口在池内重新分配；显式钉住的端口若被占用，接口直接返回 `409 port_taken`。
- 订阅只接受明文或 base64 的节点列表；HTML 登录页、超过 2 MB 的响应会被拒绝。

## 测试

```bash
npm test
```

覆盖：节点 URI 解析、SOCKS5/HTTP CONNECT/absolute-form 转发、VLESS 握手与 WebSocket 帧、proxygate 槽位归一化与同步、订阅解码/解析/导入、endpoint 文件写入。
