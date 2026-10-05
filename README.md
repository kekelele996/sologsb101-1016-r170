# 盐湖蒸发池卤水晒程编排台（sologsb101-1016）

面向盐湖提锂 / 提钾车间的晒程调度员：把盐田内每口蒸发池的卤水走向按串级关系编排，
逐日跟踪密度、温度与离子组分变化，估算蒸发量，编排走水与出卤时点。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22816**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbbrinepond` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | SolidJS 1.9 | 细粒度响应式，无虚拟 DOM |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22816） |
| 路由 | @solidjs/router 0.15 | `Router root={App}` 布局路由，全部路径支持深链刷新 |
| 状态管理 | Solid 原生能力 | `createStore`（pondStore / scheduleStore）+ `createSignal`（observationStore），**不使用 Pinia / Zustand** |
| UI | Tailwind CSS 3.4 | 全部界面手写 Tailwind，**不使用 Element Plus / Ant Design / Vue / React** |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbbrinepond`，`v1 → v2` 新增 `evapMm`；`v2 → v3` 接入清池班（清池单 + 走水挪水/排队留底），旧库按池当时状态回填 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1016/
├── README.md
├── docker-compose.yml          # name: gbbrinepond，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── index.tsx           # 入口：render + 初始化数据库
        ├── App.tsx             # 外壳：品牌栏 + 侧边导航 + 内容区（Router root 布局）
        ├── styles/main.css     # @tailwind 指令 + 全局样式
        ├── types/              # pond.ts gate.ts observation.ts assay.ts schedule.ts cleaning.ts
        ├── stores/             # pondStore.ts observationStore.ts scheduleStore.ts cleaningStore.ts
        ├── components/common/  # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx AppDialog.tsx
        ├── hooks/              # useEvaporation.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面
        ├── router/index.tsx    # AppRouter + ROUTES 常量 + NAV_ITEMS
        └── utils/              # brine.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/ponds` | `pages/PondList.tsx` | 蒸发池与池系台账：新建/编辑/级联删除、按池系与阶段筛选，卡片回显当期密度与最近观测日期 |
| `/gates` | `pages/GateConfig.tsx` | 串级走向与闸门配置：拓扑列表 + 开度就地编辑（滑块/数字），实时重算下游预计进水量 |
| `/observations` | `pages/ObservationEntry.tsx` | 卤水日观测录入台：单条 + 批量粘贴录入，同池同日覆盖写入，蒸发量按经验公式自动估算 |
| `/assays` | `pages/AssayEntry.tsx` | 离子组分分析：Li⁺/K⁺/Mg²⁺/Na⁺ 录入、自动达标判定（可人工覆盖）、SVG 组分曲线 |
| `/cleaning` | `pages/CleaningOrders.tsx` | 清池班清池单：进场/退场日期与清完水深，未退场该池算清池中；按池号对账退回/挪水/排队缺方 |
| `/schedules` | `pages/ScheduleBoard.tsx` | 走水与出卤编排：按日期排序、HTML5 拖拽调整先后顺序、逐条推进状态、出卤回写池阶段；显示清池挪水/排队留底 |
| `/export` | `pages/ExportView.tsx` | 晒程进度汇总、JSON 结构版本查看与导入导出、CSV 汇总、重置演示数据 |

`/` 重定向到 `/ponds`，未匹配路径统一回落到 `/ponds`。
**全部路由支持直接深链**：把 `http://localhost:22816/schedules` 或 `http://localhost:22816/assays` 直接粘贴到地址栏刷新即可打开；
筛选条件还会同步到 URL query，带筛选的链接可以直接分享。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbbrinepond`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 **`pondId+date` 复合索引**（`observations`、`assays`）；
  * `db.version(2)`：**新增 `evapMm` 字段**并写入真实升级迁移逻辑 ——
    `.upgrade()` 里对 `observations` 逐行检查，缺失或非法时按密度/温度/水位/风力用经验公式回填默认值；
    同时补齐 `revision` / `createdAt` / `updatedAt`、`assays.verdictManual`、`schedules.orderIndex`。
  * `db.version(3)`：**接入清池班** —— 新增 `cleaningOrders` 表；`schedules` 新增
    `homePondId`（原挂池留底）、`disposition`（本池/已挪池/排队待容）、`cleaningOrderId`、`shortfallM3`。
    `.upgrade()` 里旧数据没有清池单，**按池当时状态回填**：凡 `status = 清池中` 的池补一张生效清池单
    （`backfilled = true`，进场日期取升级当日，提示清池班补登），随后按清池单重排走水编排。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `ponds` | id | code, seriesName, stage, status, createdAt, updatedAt |
  | `gates` | id | fromPondId, toPondId, state, openingPct |
  | `observations` | id | pondId, date, **[pondId+date]**, densityGcm3, evapMm |
  | `assays` | id | pondId, date, **[pondId+date]**, verdict, verdictManual |
  | `schedules` | id | pondId, homePondId, planDate, state, orderIndex, disposition, cleaningOrderId |
  | `cleaningOrders` | id | pondId, state, entryDate, exitDate |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `ponds` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排** 三层互相引用：
  * 5 口蒸发池跨 2 个池系（北部一系 / 南部二系），覆盖钠盐 / 钾盐 / 锂盐三个阶段；
  * 4 条闸门串级（北-01→北-02→北-03、南-04→南-05、跨池系备用闸），1 条关闭用于验证开度联动；
  * 16 条卤水日观测（每池 2–4 条，密度随日期递增，`evapMm` 由经验公式生成）；
  * 6 条离子组分分析（覆盖达标 / 接近 / 未达标，其中 1 条为人工覆盖判定）；
  * 3 张清池单（北-02、南-05 各一张未退场，南-04 一张已退场历史单）；
  * 7 条走水编排（覆盖待排 / 已排 / 走水中 / 已出卤，并演示清池联动：北-02 清池中时走水中照走完、一笔 250 m³ 挪入北-03、一笔 2000 m³ 排队缺方）。
  * 固定 id 如 `pond-north-01`、`pond-south-04` 可直接用于验证与二次开发。
* **其他本地数据**：`localStorage` 仅保存「最近选中的池系」这一界面偏好，不存业务数据。
* 删除蒸发池会**级联清理**相关闸门（上下游任一为该池）、观测、化验、走水编排与清池单（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22816
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/brine.ts`）

* **密度—温度修正**：`density(25) = density(t) + 0.00035 × (t − 25)`，统一折算到 25 ℃ 便于横向比较。
* **蒸发量经验公式**：温度、风力越大蒸发越强，卤水密度越高蒸发越弱，水位低于 10 cm 时按比例折减：
  `evapMm = 5.5 × tempFactor × windFactor × brineFactor × levelFactor`。
* **密度增速**：`(末次密度 − 首次密度) / 天数`，并按当前增速外推预计密度。
* **达标判定阈值**：Li⁺ ≥ 1.0 g/L 且 K⁺ ≥ 20 g/L 为「达标」；任一项落在接近区间（Li⁺ ≥ 0.6、K⁺ ≥ 12）为「接近」，其余「未达标」。
  判定达标的池自动进入**出卤候选**；人工覆盖只改写判定标注，原始化验数值保持不变。
* **闸门过流估算**：`1.7 × 过流面积 × √水头 × 开度`，用于开度调整后的下游进水量即时反馈；开度变化会同步推导闸门状态（关闭 / 半开 / 全开）。
* **出卤回写**：走水状态推进到「已出卤」时，蒸发池阶段自动推进（钠盐→钾盐→锂盐），并把最新一次观测的密度回写为实际密度。

### 清池班联动（v3）

* **清池单**（`types/cleaning.ts`）：清池班在蒸发池上开单，记录进场日期、退场日期（未退场留空）、清完剩余水深与班组长；状态为清池中 / 已退场 / 已作废。同一口池同时只允许一张「清池中」单。
* **池状态由单据驱动**：有未退场清池单的池自动置为「清池中」，退场 / 作废后恢复「在用」（停用池不由单据驱动）。
* **走水处置**（纯函数 `utils/cleaningPlan.ts`，运行时与 v2→v3 升级共用同一套逻辑）：
  * 挂在清池池上、尚未走水（待排 / 已排）的编排一律**退回待排**；
  * **正在走水的照走完**，不中断；已出卤历史不动；
  * 其余按走水先后**挪到同池系别的「在用」池**：受纳空余容量 = 有效体积 − 最近观测存量，优先装入装得下且空余最紧的一口（best-fit），**不跨池系受纳**；
  * 同池系在用池都受纳不下的**按受纳容量排队**（`disposition = 排队待容`），并写明**缺多少方**（`shortfallM3 = 计划量 − 同池系剩余受纳容量合计`）；排队单在编排页禁止推进。
* **调度室留底**：`schedules.homePondId` 始终记录原挂池，挪水只改 `pondId`；编排页与清池班页**两边按池号对账**。
* **改期 / 作废后按池重排**：清池单任何保存（含改期）、退场、作废都在**同一 Dexie 事务**内同步池状态并重排；已挪走但未走水的编排归位原池、清掉缺方。清池班页也提供「按池重排对账」手动入口。
* **旧数据回填**：v2 旧库没有清池单，升级 v3 时按 `ponds.status = 清池中` 逐池补一张生效清池单（标记「升级回填」），并立即按单重排；v2 JSON 存档导入同样兼容（缺 `cleaningOrders` 时按空数组处理并重排）。
