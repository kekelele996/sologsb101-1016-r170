/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：接入清池班 —— 新增 cleaningOrders 表；旧数据没有清池单，按池当时状态
 *   （status = 清池中）回填生效清池单；走水编排补齐 homePondId / disposition /
 *   cleaningOrderId / shortfallM3，并按清池单把未走水的编排退回待排、挪水或排队。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { CleaningOrder } from '../types/cleaning';
import { estimateEvapMm } from './brine';
import { latestLevels, replanForCleaning, type ActiveCleaningOrder, type ReplanResult } from './cleaningPlan';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  cleaningOrders!: Table<CleaningOrder, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
      gates: 'id, fromPondId, toPondId, state, openingPct',
      observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
      assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v3：接入清池班（清池单 + 走水挪水 / 排队留底字段） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules:
          'id, pondId, homePondId, planDate, state, orderIndex, disposition, cleaningOrderId',
        cleaningOrders: 'id, pondId, state, entryDate, exitDate',
      })
      .upgrade(async (tx) => {
        // 迁移 0：全部表（含新表）行结构修订号对齐到 v3
        const tableNames = ['ponds', 'gates', 'observations', 'assays', 'schedules', 'cleaningOrders'];
        for (const name of tableNames) {
          await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
          });
        }

        const pondRows = (await tx.table('ponds').toArray()) as Pond[];
        const scheduleRows = (await tx.table('schedules').toArray()) as Array<Record<string, unknown>>;
        const observationRows = (await tx.table('observations').toArray()) as Observation[];

        // 迁移 1：旧数据没有清池单 —— 按池当时状态回填：凡是「清池中」的池补一张生效清池单
        const stamp = nowIso();
        const backfilled: CleaningOrder[] = pondRows
          .filter((pond) => pond.status === '清池中')
          .map((pond) => ({
            id: `clean-backfill-${pond.id}`,
            pondId: pond.id,
            entryDate: today(),
            exitDate: '',
            residualDepthCm: 0,
            crewLeader: '',
            note: '旧系统无清池单，升级时按该池当时状态（清池中）回填，进场日期与清完水深请清池班补登。',
            state: '清池中' as const,
            backfilled: true,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }));
        if (backfilled.length > 0) await tx.table('cleaningOrders').bulkPut(backfilled);

        // 迁移 2：走水编排补齐挪水留底字段，homePondId 默认取当前池
        const normalized: Schedule[] = scheduleRows.map((row) =>
          normalizeSchedule(row as Partial<Schedule> & Pick<Schedule, 'id' | 'pondId'>),
        );

        // 迁移 3：按回填的清池单重排 —— 未走水的退回待排、挪到同池系在用池、挪不下排队写明缺方
        const activeOrders: ActiveCleaningOrder[] = backfilled.map((order) => ({ id: order.id, pondId: order.pondId }));
        const result = replanForCleaning(pondRows, activeOrders, normalized, latestLevels(observationRows));
        const merged = mergeReplan(normalized, result);
        await tx.table('schedules').clear();
        await tx.table('schedules').bulkPut(merged);
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/** 补齐单条走水编排的挪水留底字段（升级迁移与旧版存档导入共用） */
export function normalizeSchedule(row: Partial<Schedule> & Pick<Schedule, 'id' | 'pondId'>): Schedule {
  const state = row.state ?? '待排';
  return {
    id: row.id,
    pondId: row.pondId,
    homePondId: typeof row.homePondId === 'string' && row.homePondId !== '' ? row.homePondId : row.pondId,
    planDate: row.planDate ?? today(),
    targetDensity: typeof row.targetDensity === 'number' ? row.targetDensity : 1.1,
    volumeM3: typeof row.volumeM3 === 'number' ? row.volumeM3 : 0,
    operator: row.operator ?? '',
    state,
    orderIndex: typeof row.orderIndex === 'number' ? row.orderIndex : 1,
    disposition: row.disposition ?? '本池',
    cleaningOrderId: row.cleaningOrderId ?? '',
    shortfallM3: typeof row.shortfallM3 === 'number' ? row.shortfallM3 : 0,
    createdAt: row.createdAt ?? nowIso(),
    updatedAt: row.updatedAt ?? nowIso(),
    revision: ROW_REVISION,
  };
}

/** 把重排结果合并回编排行（就地返回新数组） */
function mergeReplan(schedules: Schedule[], result: ReplanResult): Schedule[] {
  const byId = new Map(result.changes.map((change) => [change.id, change]));
  return schedules.map((schedule) => {
    const change = byId.get(schedule.id);
    if (change === undefined) return schedule;
    return {
      ...schedule,
      pondId: change.pondId,
      homePondId: change.homePondId,
      state: change.state,
      disposition: change.disposition,
      cleaningOrderId: change.cleaningOrderId,
      shortfallM3: change.shortfallM3,
    };
  });
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与清池单 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.cleaningOrders],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.schedules.where('homePondId').equals(id).delete();
      await db.cleaningOrders.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 * 注意：被清池挪走的编排 pondId 指向受纳池，出卤回写的是受纳池阶段（水在受纳池出的卤）。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: Schedule['state'], actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 清池班：清池单 ------------------------------ */

export async function listCleaningOrders(): Promise<CleaningOrder[]> {
  const rows = await db.cleaningOrders.toArray();
  return rows.sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt));
}

export class CleaningConflictError extends Error {}

/**
 * 清池联动核心：同步池状态 + 按生效清池单重排走水编排。
 * - 有生效清池单的池 → 清池中；单据退场 / 作废后该池恢复在用（停用池不动）。
 * - 未走水的编排退回待排、挪到同池系别的在用池；挪不下排队并写明缺方。
 * 在一个 Dexie 事务内完成，保证调度室看到的池状态与编排去向始终一致。
 */
async function syncCleaningInTx(): Promise<ReplanResult> {
  const [ponds, orders, schedules, observations] = await Promise.all([
    db.ponds.toArray(),
    db.cleaningOrders.toArray(),
    db.schedules.toArray(),
    db.observations.toArray(),
  ]);
  const activeOrders: ActiveCleaningOrder[] = orders
    .filter((order) => order.state === '清池中')
    .map((order) => ({ id: order.id, pondId: order.pondId }));
  const activePondIds = new Set(activeOrders.map((order) => order.pondId));

  for (const pond of ponds) {
    if (activePondIds.has(pond.id) && pond.status !== '清池中') {
      await db.ponds.update(pond.id, { status: '清池中', updatedAt: nowIso() });
    } else if (!activePondIds.has(pond.id) && pond.status === '清池中') {
      // 清池单退场 / 作废后恢复在用；停用池不由清池单驱动，保持原样
      await db.ponds.update(pond.id, { status: '在用', updatedAt: nowIso() });
    }
  }

  const result = replanForCleaning(ponds, activeOrders, schedules, latestLevels(observations));
  for (const change of result.changes) {
    await db.schedules.update(change.id, {
      pondId: change.pondId,
      homePondId: change.homePondId,
      state: change.state,
      disposition: change.disposition,
      cleaningOrderId: change.cleaningOrderId,
      shortfallM3: change.shortfallM3,
      updatedAt: nowIso(),
    });
  }
  return result;
}

/**
 * 保存清池单（新建 / 改期 / 改正水深都走这里），随后按池重排。
 * 同一口池只允许一张未退场的清池单。
 */
export async function saveCleaningOrder(row: CleaningOrder): Promise<ReplanResult> {
  return db.transaction('rw', db.ponds, db.cleaningOrders, db.schedules, db.observations, async () => {
    const others = await db.cleaningOrders.where('pondId').equals(row.pondId).toArray();
    const conflict = others.some((order) => order.state === '清池中' && order.id !== row.id);
    if (conflict) {
      throw new CleaningConflictError('这口池已有未退场的清池单，请先办理退场或作废后再开新单。');
    }
    await db.cleaningOrders.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    return syncCleaningInTx();
  });
}

/** 作废清池单：按池重排，之前退回 / 挪走 / 排队的编排归位原池重新安排 */
export async function voidCleaningOrder(orderId: string): Promise<ReplanResult | null> {
  return db.transaction('rw', db.ponds, db.cleaningOrders, db.schedules, db.observations, async () => {
    const order = await db.cleaningOrders.get(orderId);
    if (!order) return null;
    if (order.state !== '清池中') {
      await db.cleaningOrders.update(orderId, { state: '已作废', updatedAt: nowIso() });
      return null;
    }
    await db.cleaningOrders.update(orderId, { state: '已作废', updatedAt: nowIso() });
    return syncCleaningInTx();
  });
}

/** 退场登记：写退场日期与清完水深，池子恢复在用，编排归位重排 */
export async function completeCleaningOrder(
  orderId: string,
  exitDate: string,
  residualDepthCm: number,
): Promise<ReplanResult | null> {
  return db.transaction('rw', db.ponds, db.cleaningOrders, db.schedules, db.observations, async () => {
    const order = await db.cleaningOrders.get(orderId);
    if (!order) return null;
    await db.cleaningOrders.update(orderId, {
      state: '已退场',
      exitDate,
      residualDepthCm,
      updatedAt: nowIso(),
    });
    return syncCleaningInTx();
  });
}

export async function removeCleaningOrder(orderId: string): Promise<ReplanResult> {
  return db.transaction('rw', db.ponds, db.cleaningOrders, db.schedules, db.observations, async () => {
    await db.cleaningOrders.delete(orderId);
    return syncCleaningInTx();
  });
}

/**
 * 只重排走水编排：走水计划新建 / 改派 / 删除，或池台账状态手工调整后调用，
 * 让任何新挂到清池池上的编排也立刻退回 / 挪水 / 排队。
 */
export async function runCleaningReplan(): Promise<ReplanResult> {
  return db.transaction('rw', db.ponds, db.cleaningOrders, db.schedules, db.observations, async () => {
    return syncCleaningInTx();
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  assays: Assay[]
  schedules: Schedule[]
  cleaningOrders: CleaningOrder[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, cleaningOrders] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.cleaningOrders.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    cleaningOrders,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.cleaningOrders],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.cleaningOrders.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 兼容 v2 旧存档：补齐挪水留底字段，并按清池单重排后落库
      const schedules = (snapshot.schedules ?? []).map((row) => normalizeSchedule(row));
      const orders = snapshot.cleaningOrders ?? [];
      const activeOrders: ActiveCleaningOrder[] = orders
        .filter((order) => order.state === '清池中')
        .map((order) => ({ id: order.id, pondId: order.pondId }));
      const replanned = mergeReplan(
        schedules,
        replanForCleaning(snapshot.ponds, activeOrders, schedules, latestLevels(snapshot.observations ?? [])),
      );
      await db.schedules.bulkPut(replanned.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.cleaningOrders.bulkPut(orders.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.cleaningOrders],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.cleaningOrders.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, cleaningOrders] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.cleaningOrders.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, cleaningOrders };
}
