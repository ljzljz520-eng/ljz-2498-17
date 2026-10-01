# Catalpa 可靠自动保存（操作队列 + 条件提交 + 三方合并）

在原「Catalpa 编辑 + 实时预览」基础上，实现了一套**操作级（operation-based）自动保存**系统，
强调在离线、超时、多端分叉、格式升级、配额不足等情况下**不丢编辑、不误判失败、不盲目重建整稿**。

## 一、三种保存状态（页面上实时可见）

| 状态 | 含义 | 颜色 |
| --- | --- | --- |
| **仅本地保存 `local` | 编辑已写入浏览器 IndexedDB 的操作队列，尚未被服务器确认 | 橙 |
| **服务器已接收 `received`** | 服务器已接受该操作并分配了版本号，但尚未折叠进命名保存点 | 青 |
| **命名保存点 `saved`** | 已在服务器形成命名 checkpoint（可靠存档锚点） | 绿 |

编辑器左侧**行号槽道（gutter）**逐行标出每种状态，顶部状态条用段落范围精确指出
**“尚未可靠保存的范围”**（范围按最不可靠状态汇总，绝不把“已接收”误报为“已存点”）。

## 二、核心设计

- **稳定的节点身份**：文档被解析为有序节点（标题/段落/列表/引用/代码块/分割线）。
  编辑通过 LCS 对齐 + 同类型就近配对，转成 `insert / update / delete` 操作；
  就地改文字是 **update（保留 nodeId）**，移动/交换才是 delete+insert。
- **操作身份不可变**：每个操作有 `opId` 与语义 `fingerprint`。
  - **重试保留身份**：同一 `opId` 重发是幂等的，服务器返回同一版本号，不产生重复。
  - **相同编号不同内容 → 冲突**：同 `opId` 但 `fingerprint` 不同，服务器返回 `409 OP_ID_CONFLICT`，绝不覆盖。
- **版本条件提交**：`POST /api/docs/:id/sync` 携带 `baseVersion`。
  - 基线最新：直接追加，得到单调递增版本号。
  - 基线过期：
    - **节点操作合并模式（默认）**：服务器做**祖先/本机/云端三方合并**，无冲突改动自动合入；结构冲突返回三方快照与冲突清单。
    - **文档级乐观锁模式**：任何过期基线都被拒绝（`409 STALE_BASELINE`），要求整篇人工确认。
- **合并不只比较最后时间**：基于**共同祖先**比较两条分支（同 git merge），不是 last-write-wins。
  - 同节点双方改不同 → `update_update`；
  - 一方删除、另一方修改 → `delete_update`（结构冲突）；
  - 双方都删 / 仅一方删 / 各自改不同节点 → 自动干净合并。
- **超时 ≠ 失败**：网络错误/超时只代表**结果未知**。客户端随后查询服务器操作日志，
  用 `opId` 核对哪些已落地：已落地的采纳回执，未落地的以**原身份**重发。
  即使「提交成功但回执丢失」也不会重建整稿。
- **恢复动作可撤销**：冲突 rebase 会把旧操作标记 `superseded` 但**保留**，直到新操作被确认；
  恢复面板可一键撤销 rebase，回到本机分支。
- **浏览器配额不足**：先删**可重建缓存**（预览 HTML、派生快照），重试写入；
  **唯一的未上传编辑永远不参与淘汰**；连必要数据都放不下时显式报错而非静默丢数据。
- **格式升级**：队列带 `formatVersion`（v1 无 kind/fingerprint → v2 → v3），重开时纯函数迁移并可测试。
- **多标签页共享队列**：IndexedDB 为共享持久层，BroadcastChannel（及 storage 事件回退）广播变更；
  Web Locks 选举一个 leader 标签页负责网络同步，其余从动标签页只读共享队列。

## 三、目录结构

```text
server/
  http.js          # 零依赖 HTTP 层 + 故障注入（timeout/delay/offline）
  engine.js        # 条件提交、幂等/冲突检测、服务端三方合并、checkpoint
  file-repo.js     # JSON 文件仓储（原子写；开发/测试/无 PG 时使用）
  pg-repo.js       # PostgreSQL 仓储（docs / doc_ops / doc_checkpoints 三表）
src/
  core/
    blocks.js      # Catalpa 解析/序列化、稳定 nodeId、LCS diffToOps
    ops.js         # 操作模型、语义 fingerprint、applyOps
    merge.js       # 三方合并 + 结构冲突 + 人工裁决
    ranges.js      # 三态推导、逐行状态、未可靠保存范围
    queue.js       # 持久操作队列（本地/已接收/存点、rebase、配额策略）
    sync.js        # 客户端同步引擎（未知结果核对、rebase、可撤销恢复）
    storage.js     # IndexedDB / localStorage / 内存(可设配额) KV
    bus.js         # BroadcastChannel 跨标签页总线
    leader.js      # Web Locks 选主
    migration.js   # 队列格式 v1→v3 迁移
    api.js         # fetch 客户端（区分 2xx 与结果未知）
    hash.js        # 稳定指纹哈希
  components/
    StatusBar.vue  ConflictDialog.vue  RecoveryPanel.vue
  App.vue          # 编辑器 + gutter + 状态/冲突/恢复/故障注入编排
test/              # node:test 单元与端到端（40 个用例）
```

## 四、HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/docs/:id` | 当前版本、节点、操作日志、最新 checkpoint |
| `POST` | `/api/docs/:id` | 建库（可带初始节点） |
| `POST` | `/api/docs/:id/sync` | **条件提交** `{ops, baseVersion, mode}`；返回 `{version, acks, snapshot}` |
| `GET` | `/api/docs/:id/ops` | 已接收操作（回执丢失后据此核对） |
| `POST` | `/api/docs/:id/checkpoints` | 建立命名保存点 |
| `GET` | `/api/docs/:id/checkpoints` | 列出保存点 |

冲突响应 `409`：`OP_ID_CONFLICT`（同号异内容）或 `STALE_BASELINE`
（携带 `ancestor / cloud / remoteOps / conflicts` 三分支信息）。

故障注入请求头 `X-Fault: timeout | delay | offline`（仅用于验收演示/测试）：
`timeout` 会在**提交已落库之后**销毁 socket，用于验证“回执丢失也不重建”。

## 五、本地运行

```bash
pnpm install
pnpm dev:all     # 同时启动同步服务器(:3001) 与 Vite(:3000, /api 代理到 3001)
# 或分开：
pnpm server      # :3001
pnpm dev         # :3000
```

使用 PostgreSQL：设置 `DATABASE_URL=postgres://user:pass@host/db`，
服务端自动建表并切换仓储；连不上时自动回退文件仓储（`.data/`）。
`docker compose up --build` 会同时启动 Postgres、同步服务与前端。

## 六、测试

```bash
pnpm test        # node --test test/（40 个：合并/引擎/队列/迁移/块diff/HTTP故障/端到端）
```

覆盖的关键验收点：

1. **离线重开**：仅本地落库后，用同一存储重建队列，编辑与 `local` 状态完整恢复。
2. **提交成功但回执丢失**：`X-Fault: timeout` 提交后断链，`/ops` 核对到已落地，重试同 `opId` 取回回执且无重复、无重建。
3. **两标签页共享队列**：一个标签页写入，另一个经广播即时看到；双设备顺序编辑最终收敛。
4. **格式升级**：写入 v1 队列后重开，纯函数迁移到当前版本（补 kind/fingerprint/baseVersion）且不改动输入。
5. **服务器拒绝过期基线**：`STALE_BASELINE` 409 带祖先/云端；文档级乐观锁模式下任意过期都拒绝、不覆盖云端。
6. **配额不足**：超限写入先清可重建缓存成功，未上传编辑保留；极端情况显式报错而非丢数据。
7. **结构冲突人工处理**：删除/修改、同节点双改弹出三方对照，人工选择本机/云端/自定义，rebase 可撤销。
8. **范围准确**：逐行状态与“未可靠保存范围”根据节点三态、checkpoint 与基线精确推导。
