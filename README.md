# 蜜蜂授粉路线规划器（gbbeeroute）

面向果园托管服务队与蜂场技术员，把「果园地块 → 花期 → 验收结论 → 蜂群投放点排队 → 达标撤场转场」排成季内可执行的授粉安排。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 〇、职责边界（两班各管各的）

| 责任方 | 管什么 | 不管什么 |
| --- | --- | --- |
| **托管队** | 地块信息、盛花期、投放点容量与场地信息、季末按坐果出具**验收结论**（待验收 / 达标 / 不达标） | 不直接排蜂、不安排撤场 |
| **技术员** | 蜂群台账、往投放点**排蜂群**（在点不超容量、装不下进 FIFO 排队队列）、补位/移出、**撤场安排**与转场路线 | 不改地块花期与容量 |

联动规则：

1. **排蜂**：往投放点投一群，在点箱数 < 容量即入点（蜂群「在园」）；已满则自动进入该点排队队列（蜂群「排队中」）。移出在点群后，排队队首自动补位，也可手动「队首补位」。
2. **验收不达标**：托管队把地块结论改为「不达标」时，该地块所有在点群与排队群自动退回「待投放」用于补投，地块需补投后重新验收；不达标 / 待验收地块**不能撤场**，避免撤早了补投来不及。
3. **撤场失效重算**：托管队改动任何地块花期、投放点容量，或增删地块 / 投放点后，技术员已生成的撤场安排立即标记「失效」（输入指纹不一致），侧边栏与各页红字提示，需在「排蜂与撤场」页一键重算。重算只串接**验收达标且有在点蜂群**的投放点，按撤场时间排序生成转场路线。
4. **旧数据升级**：数据库升到 v3，历史地块没有验收结论的一律补「待验收」，历史投放点补空排队队列。


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
│       ├── types/              # orchard.ts（含验收结论）/ colony.ts / droppoint.ts（含排队队列）/ route.ts / index.ts
│       ├── stores/             # orchardStore / colonyStore / droppointStore / routeStore / withdrawPlanStore（Zustand）
│       ├── services/           # placement.ts（排蜂/排队/补位/退回/撤场）/ withdrawPlan.ts（输入指纹与失效判定）
│       ├── components/common/  # RouteMap / FlowerWindowBar / StatusTag / CoordPicker
│       ├── hooks/              # useAmap / usePersistentStore（Dexie v3 + 升级迁移）
│       ├── pages/              # SchedulePage / OrchardsPage / ColoniesPage / WithdrawPage / RoutesPage / ExportPage
│       ├── router/index.tsx
│       └── utils/              # geo.ts / export.ts / id.ts
```

## 六、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Orchard 果园地块 | 地块名、作物、面积、经纬度、盛花期起止、需蜂强度（箱/亩）、园主联系方式、可达性、历史授粉年份、**验收结论（待验收/达标/不达标）与坐果备注** | `orchards` |
| BeeColony 蜂群 | 群号、蜂种、群势（足框）、箱型、当前所在地块、状态（**待投放/排队中**/在园/转场中/回场）、最近检查日期、健康备注 | `colonies` |
| DropPoint 投放点 | 所属地块、坐标、编号、可容纳箱数、遮阴条件、水源距离、投放时间窗、撤场时间、责任人、**在点群号 colonyCodes 与排队群号 waitingColonyCodes（FIFO）** | `dropPoints` |
| TransitRoute 转场路线 | 出发/到达投放点、预计里程与耗时、车辆类型、出发时刻、风险备注、实际记录（撤场安排即由此表表达） | `routes` |

- 数据库名 `gbbeeroute`，`meta` 表保存 `schemaVersion`、撤场安排输入指纹 `withdrawInputSignature` 与生成时刻；
- `version(2)` 升级迁移会为历史投放点补齐「可容纳箱数」（默认 8 箱）；
- `version(3)` 升级迁移会为历史地块补齐验收结论「待验收」、为历史投放点补齐空排队队列；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/` | 季内授粉安排总表：花期条带 + 已投放/排队群体 + 验收结论，冲突标红；撤场安排失效时置顶红字提示 |
| `/orchards` | **托管队**：地块与花期维护、面积自动算建议箱数、投放点容量与场地维护、按坐果出具验收结论（选「不达标」自动退回在点群补投） |
| `/colonies` | **技术员**蜂群台账：按群势与状态（含排队中）筛选，批量改状态、批量记录检查备注 |
| `/withdraw` | **技术员**排蜂与撤场：往投放点排蜂（超容量自动排队）、队首补位、验收达标后整园撤场；撤场安排有效性横幅与一键重算 |
| `/routes` | 转场路线微调：地图依次选点生成顺序与里程，手动微调技术员的撤场转场顺序并写回路线表 |
| `/export` | 导出授粉安排清单（含验收结论、在点/排队群号）/ 转场路线表（CSV）、全量 JSON 备份，并提供横向/纵向打印视图 |

## 八、计算约定

- 建议箱数 = ⌈面积(亩) × 需蜂强度(箱/亩)⌉，最少 1 箱；
- 转场里程按 Haversine 球面距离累计，耗时按平均 32 km/h + 0.25 h 装卸估算；
- 花期重叠：两地块盛花期区间交集天数 ≥ 1 即视为重叠；同一群号在重叠期内被排入两个地块 → 冲突；
- 容量不变量：投放点在点群数 ≤ 容量。容量调小时超出群从在点队尾转入排队队首（蜂群置「排队中」），调大时排队队首自动补位（蜂群置「在园」）；
- 撤场安排有效性：对「地块花期 + 投放点容量」取 FNV-1a 指纹存入 `meta`；花期/容量或实体集合变动后指纹不一致即判失效，只有重新生成才恢复有效。
