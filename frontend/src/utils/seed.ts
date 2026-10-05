/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：蒸发池 → 闸门串级 / 清池单 / 卤水日观测 → 离子组分分析 → 走水编排
 * 所有 id 固定，保证 /gates、/cleaning、/observations、/assays、/schedules 打开就有真实串级与数据。
 * 清池联动由纯函数 replanForCleaning 算出（与升级迁移同一条链路）：
 * 北-02 清池中 → 一笔 600 m³ 挪得进北-03（成功挪水），一笔 2000 m³ 挪不下（排队缺方）。
 */
import { db, ROW_REVISION } from './db';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { CleaningOrder } from '../types/cleaning';
import { autoVerdict, estimateEvapMm } from './brine';
import { latestLevels, replanForCleaning } from './cleaningPlan';

const SEED_TIME = '2026-09-01T00:30:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  pondA: 'pond-north-01',
  pondB: 'pond-north-02',
  pondC: 'pond-north-03',
  pondD: 'pond-south-04',
  pondE: 'pond-south-05',
} as const;

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T;
}

/** 生成观测记录，evapMm 由经验公式估算 */
function observation(
  id: string,
  pondId: string,
  date: string,
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): Observation {
  return wrap<Observation>({
    id,
    pondId,
    date,
    densityGcm3,
    tempC,
    levelCm,
    windLevel,
    evapMm: estimateEvapMm(densityGcm3, tempC, levelCm, windLevel),
  });
}

/** 生成化验记录，verdict 默认自动判定 */
function assay(
  id: string,
  pondId: string,
  date: string,
  liGpl: number,
  kGpl: number,
  mgGpl: number,
  naGpl: number,
  labName: string,
  manual?: { verdict: Assay['verdict']; verdictManual: true },
): Assay {
  return wrap<Assay>({
    id,
    pondId,
    date,
    liGpl,
    kGpl,
    mgGpl,
    naGpl,
    labName,
    verdict: manual?.verdict ?? autoVerdict(liGpl, kGpl),
    verdictManual: manual?.verdictManual ?? false,
  });
}

/** 生成走水编排（播种初始行：原挂池 = 当前池，尚未被清池挪水） */
function schedule(
  id: string,
  pondId: string,
  planDate: string,
  targetDensity: number,
  volumeM3: number,
  operator: string,
  state: Schedule['state'],
  orderIndex: number,
): Schedule {
  return wrap<Schedule>({
    id,
    pondId,
    homePondId: pondId,
    planDate,
    targetDensity,
    volumeM3,
    operator,
    state,
    orderIndex,
    disposition: '本池',
    cleaningOrderId: '',
    shortfallM3: 0,
  });
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.ponds.count();
  if (exists > 0) return;

  // ---------------- 蒸发池（5 口，跨 2 个池系、3 个阶段） ----------------
  // 南-05 清池中（由清池单驱动，播种末尾重排时同步状态）；北-02 同样清池中。
  const ponds: Pond[] = [
    wrap<Pond>({ id: SEED_IDS.pondA, code: '北-01', seriesName: '北部一系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondB, code: '北-02', seriesName: '北部一系', areaM2: 9000, depthCm: 40, stage: '钾盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondC, code: '北-03', seriesName: '北部一系', areaM2: 6800, depthCm: 35, stage: '锂盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondD, code: '南-04', seriesName: '南部二系', areaM2: 15000, depthCm: 50, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondE, code: '南-05', seriesName: '南部二系', areaM2: 7200, depthCm: 38, stage: '钾盐', status: '在用' }),
  ];

  // ---------------- 闸门串级（上游 → 下游，形成完整走向链） ----------------
  const gates: Gate[] = [
    wrap<Gate>({ id: 'gate-a-b', fromPondId: SEED_IDS.pondA, toPondId: SEED_IDS.pondB, openingPct: 65, widthCm: 120, state: '半开', note: '北部一系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-c', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondC, openingPct: 40, widthCm: 100, state: '半开', note: '进入锂盐阶段前的控流闸' }),
    wrap<Gate>({ id: 'gate-d-e', fromPondId: SEED_IDS.pondD, toPondId: SEED_IDS.pondE, openingPct: 80, widthCm: 140, state: '半开', note: '南部二系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-e', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondE, openingPct: 0, widthCm: 90, state: '关闭', note: '跨池系调水备用闸，当前关闭' }),
  ];

  // ---------------- 卤水日观测（每池 2–4 条，密度随日期递增） ----------------
  const observations: Observation[] = [
    observation('obs-a1', SEED_IDS.pondA, '2026-08-20', 1.045, 28, 45, 2),
    observation('obs-a2', SEED_IDS.pondA, '2026-08-30', 1.062, 30, 43, 3),
    observation('obs-a3', SEED_IDS.pondA, '2026-09-10', 1.086, 29, 41, 2),
    observation('obs-a4', SEED_IDS.pondA, '2026-09-22', 1.108, 26, 39, 3),
    observation('obs-b1', SEED_IDS.pondB, '2026-08-22', 1.112, 27, 40, 2),
    observation('obs-b2', SEED_IDS.pondB, '2026-09-02', 1.14, 29, 38, 3),
    observation('obs-b3', SEED_IDS.pondB, '2026-09-14', 1.168, 28, 36, 2),
    observation('obs-c1', SEED_IDS.pondC, '2026-08-25', 1.195, 26, 35, 1),
    observation('obs-c2', SEED_IDS.pondC, '2026-09-05', 1.222, 27, 33, 2),
    observation('obs-c3', SEED_IDS.pondC, '2026-09-18', 1.248, 25, 31, 2),
    observation('obs-d1', SEED_IDS.pondD, '2026-08-21', 1.038, 30, 50, 4),
    observation('obs-d2', SEED_IDS.pondD, '2026-09-01', 1.055, 31, 48, 3),
    observation('obs-d3', SEED_IDS.pondD, '2026-09-12', 1.074, 29, 46, 2),
    observation('obs-d4', SEED_IDS.pondD, '2026-09-24', 1.092, 27, 44, 3),
    observation('obs-e1', SEED_IDS.pondE, '2026-08-24', 1.12, 28, 38, 2),
    observation('obs-e2', SEED_IDS.pondE, '2026-09-04', 1.146, 29, 36, 2),
  ];

  // ---------------- 离子组分分析（含达标 / 接近 / 未达标三种判定） ----------------
  const assays: Assay[] = [
    assay('assay-a1', SEED_IDS.pondA, '2026-09-22', 0.12, 6.4, 42.5, 88.2, '盐湖中心化验室'),
    assay('assay-b1', SEED_IDS.pondB, '2026-09-14', 0.72, 15.5, 21.8, 58.4, '盐湖中心化验室'),
    assay('assay-c1', SEED_IDS.pondC, '2026-09-05', 1.05, 18.2, 9.6, 26.1, '盐湖中心化验室'),
    assay('assay-c2', SEED_IDS.pondC, '2026-09-18', 1.32, 22.6, 8.4, 24.3, '盐湖中心化验室'),
    assay('assay-d1', SEED_IDS.pondD, '2026-09-24', 0.08, 4.2, 48.9, 96.5, '南部化验站'),
    assay('assay-e1', SEED_IDS.pondE, '2026-09-04', 0.48, 13.6, 24.2, 61.7, '南部化验站', {
      verdict: '接近',
      verdictManual: true,
    }),
  ];

  // ---------------- 清池班：清池单（两张生效 + 一张已退场历史单） ----------------
  const cleaningOrders: CleaningOrder[] = [
    // 北-02 正在清池：清完剩 8 cm，尚未退场 —— 驱动北部一系的退回 / 挪水 / 排队
    wrap<CleaningOrder>({
      id: 'clean-b-active',
      pondId: SEED_IDS.pondB,
      entryDate: '2026-10-01',
      exitDate: '',
      residualDepthCm: 8,
      crewLeader: '赵清',
      note: '钾盐结晶板结，安排机械清底',
      state: '清池中',
      backfilled: false,
    }),
    // 南-05 正在清池
    wrap<CleaningOrder>({
      id: 'clean-e-active',
      pondId: SEED_IDS.pondE,
      entryDate: '2026-09-25',
      exitDate: '',
      residualDepthCm: 6,
      crewLeader: '孙茂',
      note: '清池后转锂盐阶段晒程',
      state: '清池中',
      backfilled: false,
    }),
    // 历史已退场单：南-04 上个月清过一轮
    wrap<CleaningOrder>({
      id: 'clean-d-done',
      pondId: SEED_IDS.pondD,
      entryDate: '2026-08-03',
      exitDate: '2026-08-09',
      residualDepthCm: 10,
      crewLeader: '赵清',
      note: '例行清淤',
      state: '已退场',
      backfilled: false,
    }),
  ];

  // ---------------- 走水编排（覆盖四种状态，orderIndex 决定先后） ----------------
  // 注意：北-02 清池期间 —— schedule-b1 走水中照走完；schedule-b2 退回待排并成功挪到北-03
  // （250 m³ 只装得进北-03 空余 272 m³，北-01 余 720 但 best-fit 选更紧的一口）；
  // schedule-b3 退回待排但 2000 m³ 同池系两口都受纳不下，排队待容并写明缺方。
  const rawSchedules: Schedule[] = [
    schedule('schedule-a1', SEED_IDS.pondA, '2026-10-02', 1.115, 1200, '韩江', '已排', 1),
    schedule('schedule-d1', SEED_IDS.pondD, '2026-10-04', 1.098, 1600, '王锐', '已排', 2),
    schedule('schedule-b1', SEED_IDS.pondB, '2026-10-06', 1.175, 900, '韩江', '走水中', 3),
    schedule('schedule-b2', SEED_IDS.pondB, '2026-10-08', 1.178, 250, '韩江', '已排', 4),
    schedule('schedule-b3', SEED_IDS.pondB, '2026-10-10', 1.18, 2000, '李文', '待排', 5),
    schedule('schedule-c1', SEED_IDS.pondC, '2026-10-12', 1.255, 600, '李文', '待排', 6),
    schedule('schedule-e1', SEED_IDS.pondE, '2026-09-28', 1.15, 700, '王锐', '已出卤', 7),
  ];

  // 与运行时 / 升级迁移同一条重排链路算出挪水 / 排队结果
  const activeOrders = cleaningOrders
    .filter((order) => order.state === '清池中')
    .map((order) => ({ id: order.id, pondId: order.pondId }));
  const replanResult = replanForCleaning(ponds, activeOrders, rawSchedules, latestLevels(observations));
  const changeById = new Map(replanResult.changes.map((change) => [change.id, change]));
  const schedules = rawSchedules.map((row) => {
    const change = changeById.get(row.id);
    return change === undefined ? row : { ...row, ...change };
  });
  // 清池单驱动池状态：北-02、南-05 清池中
  const activePondIds = new Set(activeOrders.map((order) => order.pondId));
  ponds.forEach((pond) => {
    if (activePondIds.has(pond.id)) pond.status = '清池中';
  });

  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.cleaningOrders],
    async () => {
      await db.ponds.bulkPut(ponds);
      await db.gates.bulkPut(gates);
      await db.observations.bulkPut(observations);
      await db.assays.bulkPut(assays);
      await db.schedules.bulkPut(schedules);
      await db.cleaningOrders.bulkPut(cleaningOrders);
    },
  );
}
