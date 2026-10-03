# 蜜蜂授粉路线规划器（gbbeeroute）

面向果园托管服务队与蜂场技术员，把「果园地块 → 花期 → 蜂群投放点 → 转场路线」排成季内可执行的授粉安排，解决花期重叠时蜂群撞车、转场距离过远、投放点与地块不匹配的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21817>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbbeeroute
FRONTEND_PORT=21817
VITE_AMAP_KEY=            # 可选，留空即自动降级为本地 SVG 网格视图
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| UI 组件库 | Ant Design 5 |
| 地图 | 高德地图 JS API 2.0（可选，key 走 `VITE_AMAP_KEY`） |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、高德地图 Key 与降级策略

- 在 `.env` 里填写 `VITE_AMAP_KEY=<你的 key>` 后**重新构建**（`docker compose up -d --build`），地图将使用高德 JS API 渲染地块、投放点与转场折线；
- **未配置 key 或脚本加载失败时，`RouteMap` 自动降级为本地 SVG 网格视图**：按经纬度线性映射渲染地块、投放点与转场折线，支持点选拾取坐标；
- **构建与运行都不依赖该 key**：未配置 key 时不会注入任何外部脚本（避免无谓请求与报错），Docker 构建零网络依赖即可通过；
- 页面右上角始终显示当前数据源（高德地图 JS API / 本地 SVG 网格视图）。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21817
npm run build      # 类型检查 + 生产构建
```

可选：用内存版 IndexedDB 跑一遍容量/排队/验收/失效/迁移的端到端校验脚本（不写入 `package.json`）：

```bash
cd frontend
npm install --no-save fake-indexeddb
npx tsx scripts/verify.mts
```

## 五、目录结构

```
sologsb-1117/
├── docker-compose.yml          # 顶层 name: gbbeeroute，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # orchard（含验收结论）/ colony / droppoint / deployment / withdrawal / route
│       ├── stores/             # orchardStore / colonyStore / droppointStore / deploymentStore / withdrawalStore / routeStore
│       ├── components/common/  # RouteMap / FlowerWindowBar / StatusTag / CoordPicker
│       ├── hooks/              # useAmap / usePersistentStore
│       ├── pages/              # SchedulePage / OrchardsPage / ColoniesPage / DeployPage / RoutesPage / ExportPage
│       ├── router/index.tsx
│       └── utils/              # geo.ts / schedule.ts / export.ts / id.ts
```

## 六、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Orchard 果园地块 | 地块名、作物、面积、经纬度、盛花期起止、需蜂强度（箱/亩）、园主联系方式、可达性、历史授粉年份、**季末验收结论（待验收/达标/不达标，托管队按坐果给出）** | `orchards` |
| BeeColony 蜂群 | 群号、蜂种、群势（足框）、箱型、当前所在地块、状态（待投放/在园/转场中/回场）、最近检查日期、健康备注 | `colonies` |
| DropPoint 投放点 | 所属地块、坐标、编号、可容纳箱数、遮阴条件、水源距离、投放时间窗、撤场时间、责任人（地块与容量归托管队） | `dropPoints` |
| Deployment 投放安排 | 技术员把蜂群排到投放点的记录：群、投放点、状态（已投放/排队中）、入队序号；箱数不超容量，装不下 FIFO 排队 | `deployments` |
| WithdrawalPlan 撤场安排 | 按地块编排撤场时刻/车辆/备注，固化花期与容量依据快照；托管队改花期或容量后自动判定失效，需重算才能执行 | `withdrawals` |
| TransitRoute 转场路线 | 出发/到达投放点、预计里程与耗时、车辆类型、出发时刻、风险备注、实际记录 | `routes` |

- 数据库名 `gbbeeroute`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史投放点补齐「可容纳箱数」（默认 8 箱）；
- `version(3)` 升级迁移：① 旧地块没有验收结论，统一补「待验收」；② 旧投放点上的「安排群号」迁移为技术员投放安排（按容量落箱，装不下的转排队），群号不再挂在投放点上；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 职责划分（两边各管各的）

| 角色 | 页面 | 负责内容 |
| --- | --- | --- |
| 托管队 | 「地块与验收」 | 地块档案、投放点与容量、季末按坐果出验收结论（待验收/达标/不达标） |
| 技术员 | 「投放与撤场」 | 蜂群排到投放点（不超容量、装不下排队、可调整排队顺序、撤下自动补位）、撤场编排与执行 |

联动规则：

- 验收标记**不达标**：该地块已投放/排队的蜂群全部退回「待投放」池等待补投，撤场安排作废；
- 托管队**改盛花期或投放点容量**（含增删投放点）：对应地块的撤场安排标记「已失效·待重算」，执行被锁定，技术员重算后恢复；容量缩小时按排队顺序把多出的群退回排队；
- 验收达标且撤场安排有效时，技术员才能执行撤场，执行后地块上蜂群统一「回场」，可赶往下个果园。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/` | 季内授粉安排总表：花期条带 + 已投放/排队群体 + 验收结论，冲突（同一蜂群被排入花期重叠的不同地块）标红并汇总 |
| `/orchards` | 【托管队】果园地块管理：面积与需蜂强度自动算建议箱数、投放点与容量维护（含坐标拾取）、季末验收结论 |
| `/colonies` | 蜂群台账：按群势与状态筛选，批量改状态、批量记录检查备注，显示各群投放安排 |
| `/deploy` | 【技术员】投放与排队：待投放池 → 投放点（容量约束 + FIFO 排队 + 自动补位）；撤场安排：编排、失效重算、执行回场 |
| `/routes` | 转场路线规划：地图依次选点生成顺序与里程，拖动或上下移动调整顺序并实时重算，写回路线表 |
| `/export` | 导出授粉安排清单 / 撤场安排表 / 转场路线表（CSV）、全量 JSON 备份，并提供横向/纵向打印视图 |

## 八、计算约定

- 建议箱数 = ⌈面积(亩) × 需蜂强度(箱/亩)⌉，最少 1 箱；
- 投放点排群：按入队顺序 FIFO 占箱，已投放数 ≤ 容量；新排入装不下即「排队中」，撤下或扩容后队首自动补位；
- 撤场安排失效判定：固化的盛花期起止、投放点容量摘要（编号:容量 排序拼接）与当前数据不一致即失效，重算后可执行；
- 转场里程按 Haversine 球面距离累计，耗时按平均 32 km/h + 0.25 h 装卸估算；
- 花期重叠：两地块盛花期区间交集天数 ≥ 1 即视为重叠；同一群号在重叠期内被排入两个地块 → 冲突。
