# Egress Matrix

OpenChamber 生态的统一出口网络中枢。一个扩展，管理 **250 个固定槽位**（`slot-001`..`slot-250` → `127.0.0.1:24001`..`24250`），每个槽位是一个 HTTP CONNECT + SOCKS5 同端口的本地混合代理，背后绑定一条严格隔离的出口身份。

上层 `openchamber-instabox`、`openchamber-cloudflare` 不再各自管代理，而是向矩阵申请槽位、读本地总线、按双平面规则出网。

- 私有仓库：<https://github.com/wbi35772/openchamber-egress-matrix>
- 架构与运维文档：[docs/architecture.html](docs/architecture.html)（单文件，浏览器直接打开，无构建）

## 它解决什么

- **身份隔离**：一个账号 = 一个槽位 = 一个出口 IP / `/64`。`/64` 污点账本记录历史归属，换血后旧前缀永不跨槽复用。
- **双平面路由**：控制面（订阅、鉴权、后台 API）走静态出口，不可达就断，绝不溢出 WARP 或直连；数据面在 429/超时后切 WARP 池并标记 `WARP_OVERFLOW`。
- **蓝绿换血**：`ROTATING` → 广播 `PRE_ROTATION_FREEZE`（200ms 预算）→ 切换并校验新出口身份 → `POST_ROTATION_RESUME`，任何失败槽位保持关闭（`COOLDOWN`），不回退直连。
- **统一契约**：槽位、端口、枚举、状态文件、本地总线全部由 `core/contract.js` 单点定义，扩展之间不再各说各话。

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

> 运行中的 OpenChamber 只读扩展目录里的副本（Windows 默认 `%USERPROFILE%\.config\openchamber\extensions\egress-matrix`），不会跟随仓库热更新。改完本仓库后要把 `service/` 和 `ui/` 重新复制过去，再完全退出并重开 OpenChamber；否则会出现面板是新的、接口还是旧的。

首次打开没有任何出口。添加一个节点、导入订阅，或填好 proxygate 后同步槽位；`默认网关` 会立刻出现在「总览」。

## 面板

按功能分成七个标签：

- **总览**：默认网关、槽位计数、出口 IP、健康分布、总线状态，以及契约文件速览。
- **槽位**：全部矩阵槽位；卡片 / 列表 / 紧凑三种视图（选择会记住）；可探测、换血、隔离 / 解除，复制 HTTP/SOCKS 地址，查看 `/64`、ASN、`leaseId`；任意状态都能「移除」——删除租约并关闭监听，需二次确认。
- **节点池**：手动添加单条节点 URI；勾选、行序号与分页（20 / 50 / 100 / 全部）；批量探测、建租约、复制 URI、删除，可全选筛选结果；行内编辑名称与 URI；一键批量体检整池，记录出口 IP、国家、ASN 与延迟，并发可选 8 / 16 / 32 / 64；按来源、可用性、国家筛选排序。
- **订阅**：导入整池节点；可同步、批量建租约、删除。批量建租约默认只取体检通过的节点，可指定起始槽位（`slot-010` 或 `24010`）。同步只更新本订阅节点，不碰手动节点。
- **上游**：proxygate 地址、API Key、公开 SOCKS 主机、SOCKS 密码、默认国家；同步槽位、分配槽位、换出口 IP。
- **轮转**：换血事件流、冻结/恢复回调注册、旋转历史。
- **设置**：默认端口、控制面域名白名单、WARP 池（开关/端点/冷却）、探测 URL、契约文件路径。

## 契约

共享状态目录：`~/.openchamber/matrix-state/`（`OPENCHAMBER_MATRIX_STATE_DIR` 覆盖）。

| 文件 | 作用 |
| --- | --- |
| `egress-leases.json` | 权威槽位租约（严格契约字段） |
| `subnet-taint-ledger.json` | `/64` 与出口 IP 的历史归属，永不跨槽复用 |
| `callbacks.json` | 换血冻结/恢复回调端点 |
| `rotation-events.json` | 事件环（最近 500 条） |

契约字段：

| 字段 | 取值 |
| --- | --- |
| `matrixSlotId` | `slot-001`..`slot-250` |
| `egressPort` | `24000 + index`，即 24001..24250 |
| `routingPlane` | `STRICT_CONTROL` \| `ELASTIC_DATA` |
| `healthState` | `ACTIVE` \| `COOLDOWN` \| `QUARANTINED` \| `WARP_OVERFLOW` \| `ROTATING` |
| `egressFingerprint` | `{exitIp, ipv6Prefix64, asn, leaseId, updatedAt}` |

`endpoints.json`（v2）：

```json
{
  "version": 2,
  "updatedAt": "2026-11-15T00:00:00.000Z",
  "host": "127.0.0.1",
  "primary": "lease_id",
  "default": { "key": "default", "port": 25001, "proxy": "http://127.0.0.1:25001", "socks": "socks5://127.0.0.1:25001" },
  "byKey": { "default": { }, "acct/role-a": { } },
  "lanes": [ ],
  "slots": [
    {
      "matrixSlotId": "slot-001",
      "egressPort": 24001,
      "routingPlane": "STRICT_CONTROL",
      "healthState": "ACTIVE",
      "egressFingerprint": { "exitIp": "203.0.113.7", "ipv6Prefix64": "2001:db8:aa:0::/64", "asn": "AS64500", "leaseId": "lease_x", "updatedAt": 0 }
    }
  ]
}
```

其他扩展的最小接法：读 `byKey['<租约 key>'].port` / `slots[].egressPort`，把原本的上游代理指向 `127.0.0.1:<port>`；没有该槽位就失败，不要回退直连。

## 本地总线

`http://127.0.0.1:19880/api/v1/egress`（`OPENCHAMBER_MATRIX_BUS_PORT` 覆盖），只绑回环，供本地扩展直接查询与注册回调。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 槽位、WARP、回调、事件快照 |
| GET | `/leases` | 契约租约列表 |
| GET | `/events?limit=N` | 最近换血事件 |
| GET | `/callbacks` | 已注册回调 |
| POST | `/callbacks` | 注册冻结/恢复回调 `{clientId,url,events}` |
| POST | `/probe` | 探测 `{matrixSlotId}` 或 `{port}` |
| POST | `/slots/:id/probe` | 深探测单槽位并写回指纹 |
| POST | `/slots/:id/rotate` | 蓝绿换血 |
| POST | `/slots/:id/quarantine` | 隔离槽位 |
| POST | `/slots/:id/release` | 释放槽位 |

## 服务 API

宿主服务端口上的请求走注入的 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 引擎、监听、出口、文件位置 |
| GET/PUT | `/api/config` | 设置、节点、订阅、proxygate、`controlDomains`、`warp` |
| GET | `/api/endpoints` | 实时监听 + 落盘契约（v2） |
| GET | `/api/events` | 换血事件 |
| POST/GET | `/api/nodes` | 添加/列出静态节点 |
| PATCH/DELETE | `/api/nodes/:id` | 改名/改 URI、删除（级联租约） |
| POST | `/api/nodes/:id/probe` | 临时链路探测（出口 IP、国家、ASN、延迟） |
| POST | `/api/nodes/probe-all` | 批量体检，可带 `subscriptionId`、`limit`、`ttl`、`concurrency`（默认 16，上限 64） |
| GET | `/api/nodes/probe-status` | 体检进度与通过/失败计数 |
| GET/POST | `/api/subscriptions` | 订阅列表 / 导入 |
| PATCH/DELETE | `/api/subscriptions/:id` | 修改 / 删除 |
| POST | `/api/subscriptions/:id/sync` | 重新拉取订阅 |
| POST | `/api/subscriptions/:id/leases` | 批量建租约 |
| GET/POST | `/api/leases` | 列表 / 新建静态租约 |
| POST | `/api/leases/batch` | 按订阅批量建租约（默认只取体检通过，可带 `startPort`） |
| PATCH/DELETE | `/api/leases/:id` | 改 key/端口/国家、设为主、删除 |
| POST | `/api/leases/:id/probe` | 走真实监听探测 |
| POST | `/api/proxygate/sync` | 拉槽位并同步租约 |
| POST | `/api/proxygate/allocate` | 申请新槽位 |
| POST | `/api/proxygate/rotate` | 轮换槽位 `{slotId}` |
| POST | `/api/reconcile` | 重算监听 |
| POST | `/api/probe` | 全量探测 |
| POST | `/api/v1/egress/slots/:id/probe` | 槽位端到端探测 |
| POST | `/api/v1/egress/slots/:id/rotate` | 蓝绿换血 |
| POST | `/api/v1/egress/slots/:id/quarantine` | 隔离槽位 |
| POST | `/api/v1/egress/slots/:id/release` | 解除隔离（QUARANTINED → ACTIVE） |
| POST | `/api/v1/egress/slots/:id/remove` | 删除租约并移除槽位 |

## 双平面

- 控制面命中 `controlDomains` 白名单，或请求携带 `X-OC-Routing-Plane: STRICT_CONTROL`：只走静态出口。上游不可达 → 请求失败，**不**切 WARP、**不**直连。普通 HTTP 转发前该头会被剥离。
- 数据面 `ELASTIC_DATA`：静态出口优先；连接失败、超时或收到 429 后切 WARP 池，槽位标记 `WARP_OVERFLOW`。
- 防滥用前置：RFC1918 / 元数据 / 回环目标硬拦截并隔离；22/23/445/3389 高频探测触发 `QUARANTINED`。

## 测试

```bash
npm test
```

56 个用例，覆盖契约字段与端口映射、文件锁并发、租约/回调/事件存储、`/64` 污点冲突、防滥用判定、WARP 池健康、换血状态机与身份校验、双平面请求头解析与透传、节点 URI、VLESS/Trojan 握手、订阅解码、proxygate 同步、批量租约筛选。

## 边界

- 只支持 TCP；不处理 UDP ASSOCIATE。
- 上游只支持 VLESS/Trojan over WebSocket（含 TLS）与 SOCKS5；REALITY、gRPC、H2、SS 暂不支持。
- 本地监听只绑 `127.0.0.1`，不对局域网开放。
- 槽位端口被外部进程占用时自动顺延到下一个空闲索引，不会把租约打进 `COOLDOWN`。
- proxygate 槽位需要可公网访问的 SOCKS 主机；面板不会替你穿透内网。
- 订阅只接受明文或 base64 的节点列表；HTML 登录页、超过 2 MB 的响应会被拒绝。
