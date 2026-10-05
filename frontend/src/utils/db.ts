/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：接入清池班——新增 cleaningOrders 表；旧数据按池子当时「清池中」状态回填清池单
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { CleaningOrder } from '../types/cleaning';
import { estimateEvapMm } from './brine';
import { reallocateForOrder } from './cleaningPlanner';
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
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：接入清池班 ----------
    // 新增 cleaningOrders 清池单表；schedules 新增挪动/排队字段。
    // 旧数据没有清池单：按池子当时的状态回填——status=清池中 的池补一张「清池中」单据。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, cleaningOrderId, queued',
        cleaningOrders: 'id, pondId, enterDate, exitDate, state',
      })
      .upgrade(async (tx) => {
        // 迁移 5：走水编排补齐清池联动字段（不动旧计划的池与状态）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.originPondId !== 'string') row.originPondId = undefined;
          if (typeof row.cleaningOrderId !== 'string') row.cleaningOrderId = undefined;
          if (typeof row.queued !== 'boolean') row.queued = false;
          if (typeof row.shortM3 !== 'number') row.shortM3 = 0;
          if (typeof row.acceptedM3 !== 'number') row.acceptedM3 = 0;
        });

        // 迁移 6：旧数据没有清池单——按池子当时状态回填（仅补 status=清池中 的池）
        const stamp = nowIso();
        const backfillDate = today();
        const cleaningPonds = await tx
          .table<Pond, string>('ponds')
          .filter((pond) => pond.status === '清池中')
          .toArray();
        const orderTable = tx.table<CleaningOrder, string>('cleaningOrders');
        for (const pond of cleaningPonds) {
          await orderTable.add({
            id: `cleaning-backfill-${pond.id}`,
            pondId: pond.id,
            enterDate: backfillDate,
            exitDate: '',
            remainDepthCm: Math.max(5, Math.round(pond.depthCm / 2)),
            crew: '',
            state: '清池中',
            backfilled: true,
            note: '升级回填：旧数据无清池单，按池子当时「清池中」状态补录，日期请向清池班核实。',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
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
  // Dexie 的重载类型最多枚举到 5 张表，6 张表用数组形式传入
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
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 清池单 ------------------------------ */

export async function listCleaningOrders(): Promise<CleaningOrder[]> {
  const rows = await db.cleaningOrders.toArray();
  return rows.sort((a, b) => b.enterDate.localeCompare(a.enterDate) || a.pondId.localeCompare(a.pondId));
}

export async function putCleaningOrder(row: CleaningOrder): Promise<void> {
  await db.cleaningOrders.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 同步池运行状态：被有效（清池中）单据覆盖的池记为「清池中」；其余曾被置为清池中的池恢复「在用」。
 * 在任何清池单变更后调用，保证两边按池号对账一致。必须在 rw 事务内调用（db 已绑定当前事务域）。
 */
async function syncPondStatuses(): Promise<void> {
  const orders = await db.cleaningOrders.toArray();
  const ponds = await db.ponds.toArray();
  const cleaningPondIds = new Set(orders.filter((o) => o.state === '清池中').map((o) => o.pondId));
  const stamp = nowIso();
  for (const pond of ponds) {
    if (cleaningPondIds.has(pond.id)) {
      if (pond.status !== '清池中') await db.ponds.update(pond.id, { status: '清池中', updatedAt: stamp });
    } else if (pond.status === '清池中') {
      await db.ponds.update(pond.id, { status: '在用', updatedAt: stamp });
    }
  }
}

/** 先撤销一张单据在走水编排上留下的挪动/排队痕迹（恢复到原池、清标记） */
async function resetOrderSchedules(orderId: string): Promise<void> {
  const rows = await db.schedules.where('cleaningOrderId').equals(orderId).toArray();
  for (const row of rows) {
    const origin = typeof row.originPondId === 'string' ? row.originPondId : row.pondId;
    await db.schedules.update(row.id, {
      pondId: origin,
      originPondId: undefined,
      cleaningOrderId: undefined,
      queued: false,
      shortM3: 0,
      acceptedM3: 0,
      state: row.queued ? '待排' : row.state,
      updatedAt: nowIso(),
    });
  }
}

export interface ApplyOrderResult {
  order: CleaningOrder;
  affected: number;
  moved: number;
  queued: number;
  shortTotal: number;
}

/**
 * 开 / 改期一张清池单并联动重排：
 * 1) 先撤销本单旧的挪动痕迹；2) 按最新窗口重算本单；3) 其余有效单据按进场先后依次重排。
 */
export async function applyCleaningOrder(order: CleaningOrder): Promise<ApplyOrderResult> {
  return db.transaction(
    'rw',
    db.cleaningOrders,
    db.schedules,
    db.ponds,
    db.observations,
    async () => {
      await resetOrderSchedules(order.id);
      await db.cleaningOrders.put({ ...order, updatedAt: nowIso(), revision: ROW_REVISION });

      const allOrders = await db.cleaningOrders.toArray();
      const activeOthers = allOrders
        .filter((o) => o.id !== order.id && o.state === '清池中')
        .sort((a, b) => a.enterDate.localeCompare(b.enterDate));

      const ponds = await db.ponds.toArray();
      const observations = await db.observations.toArray();

      // 本单
      let schedules = await db.schedules.toArray();
      const own = reallocateForOrder({ order, ponds, schedules, observations, otherActiveOrders: activeOthers });
      if (own.updates.length > 0) await db.schedules.bulkPut(own.updates);

      // 其余有效单据按进场先后重排（前一张的挪动结果参与后一张的容量计算）
      for (const other of activeOthers) {
        schedules = await db.schedules.toArray();
        const r = reallocateForOrder({
          order: other,
          ponds,
          schedules,
          observations,
          otherActiveOrders: [order, ...activeOthers.filter((o) => o.id !== other.id)],
        });
        if (r.updates.length > 0) await db.schedules.bulkPut(r.updates);
      }

      await syncPondStatuses();
      return { order, affected: own.affected, moved: own.moved, queued: own.queued, shortTotal: own.shortTotal };
    },
  );
}

/** 作废清池单：撤销本单挪动（计划回原池），再按其余有效单据重排；本单标记作废 */
export async function voidCleaningOrder(orderId: string): Promise<void> {
  await db.transaction('rw', db.cleaningOrders, db.schedules, db.ponds, db.observations, async () => {
    const order = await db.cleaningOrders.get(orderId);
    if (!order) return;
    await resetOrderSchedules(orderId);
    await db.cleaningOrders.update(orderId, { state: '已作废', updatedAt: nowIso() });

    const remaining = (await db.cleaningOrders.toArray())
      .filter((o) => o.id !== orderId && o.state === '清池中')
      .sort((a, b) => a.enterDate.localeCompare(b.enterDate));
    const ponds = await db.ponds.toArray();
    const observations = await db.observations.toArray();
    for (const other of remaining) {
      const schedules = await db.schedules.toArray();
      const r = reallocateForOrder({
        order: other,
        ponds,
        schedules,
        observations,
        otherActiveOrders: remaining.filter((o) => o.id !== other.id),
      });
      if (r.updates.length > 0) await db.schedules.bulkPut(r.updates);
    }
    await syncPondStatuses();
  });
}

/**
 * 清池班登记退场：单据置「已清完」，按清完水深回写池有效水深、池恢复在用；
 * 本单排队待排的计划回到原池待调度，其余有效单据照旧重排。
 */
export async function completeCleaningOrder(orderId: string, remainDepthCm: number): Promise<void> {
  await db.transaction('rw', db.cleaningOrders, db.schedules, db.ponds, db.observations, async () => {
    const order = await db.cleaningOrders.get(orderId);
    if (!order) return;
    await resetOrderSchedules(orderId);
    await db.cleaningOrders.update(orderId, {
      state: '已清完',
      exitDate: order.exitDate !== '' ? order.exitDate : today(),
      remainDepthCm,
      updatedAt: nowIso(),
    });
    await db.ponds.update(order.pondId, { depthCm: remainDepthCm, status: '在用', updatedAt: nowIso() });

    const remaining = (await db.cleaningOrders.toArray())
      .filter((o) => o.id !== orderId && o.state === '清池中')
      .sort((a, b) => a.enterDate.localeCompare(b.enterDate));
    const ponds = await db.ponds.toArray();
    const observations = await db.observations.toArray();
    for (const other of remaining) {
      const schedules = await db.schedules.toArray();
      const r = reallocateForOrder({
        order: other,
        ponds,
        schedules,
        observations,
        otherActiveOrders: remaining.filter((o) => o.id !== other.id),
      });
      if (r.updates.length > 0) await db.schedules.bulkPut(r.updates);
    }
    await syncPondStatuses();
  });
}

/** 手工触发：对全部有效清池单按进场先后整体重排（对账后一键按池重排） */
export async function reallocateAllCleaning(): Promise<{ moved: number; queued: number; shortTotal: number }> {
  return db.transaction('rw', db.cleaningOrders, db.schedules, db.ponds, db.observations, async () => {
    const orders = (await db.cleaningOrders.toArray())
      .filter((o) => o.state === '清池中')
      .sort((a, b) => a.enterDate.localeCompare(b.enterDate));
    // 先撤销全部有效单据的挪动痕迹，再从干净基线整体重排
    for (const order of orders) await resetOrderSchedules(order.id);
    const ponds = await db.ponds.toArray();
    const observations = await db.observations.toArray();
    let moved = 0;
    let queued = 0;
    let shortTotal = 0;
    for (const order of orders) {
      const schedules = await db.schedules.toArray();
      const r = reallocateForOrder({
        order,
        ponds,
        schedules,
        observations,
        otherActiveOrders: orders.filter((o) => o.id !== order.id),
      });
      if (r.updates.length > 0) await db.schedules.bulkPut(r.updates);
      moved += r.moved;
      queued += r.queued;
      shortTotal += r.shortTotal;
    }
    await syncPondStatuses();
    return { moved, queued, shortTotal: Math.round(shortTotal * 10) / 10 };
  });
}

export async function removeCleaningOrder(id: string): Promise<void> {
  // 直接删除仅限「已清完 / 已作废」单据；有效单据请先作废，避免计划悬挂
  await db.cleaningOrders.delete(id);
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  cleaningOrders: CleaningOrder[];
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

/** 兼容旧版（v1/v2）存档：缺清池单与清池联动字段时补空值 */
function normalizeSnapshot(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  return {
    ...snapshot,
    cleaningOrders: Array.isArray(snapshot.cleaningOrders) ? snapshot.cleaningOrders : [],
    schedules: snapshot.schedules.map((row) => ({
      ...row,
      originPondId: typeof row.originPondId === 'string' ? row.originPondId : undefined,
      cleaningOrderId: typeof row.cleaningOrderId === 'string' ? row.cleaningOrderId : undefined,
      queued: row.queued === true,
      shortM3: typeof row.shortM3 === 'number' ? row.shortM3 : 0,
      acceptedM3: typeof row.acceptedM3 === 'number' ? row.acceptedM3 : 0,
    })),
  };
}

export async function importSnapshot(rawSnapshot: DatabaseSnapshot): Promise<void> {
  const snapshot = normalizeSnapshot(rawSnapshot);
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
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.cleaningOrders.bulkPut(snapshot.cleaningOrders.map((row) => ({ ...row, revision: ROW_REVISION })));
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
