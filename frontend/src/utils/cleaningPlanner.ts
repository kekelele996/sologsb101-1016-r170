/**
 * 清池联动走水重排（纯函数，供 db 层与 seed 复用，不触碰 IndexedDB）
 *
 * 规则（调度室口径）：
 * - 清池窗口 [enterDate, exitDate]（退场日期留空 → 开口区间）内，挂在被清池上、
 *   尚未开始走水（待排/已排）的走水编排退回待排；走水中/已出卤的照走完，不动。
 * - 其余编排挪到同一池系的其他「在用」池，受纳容量按 面积×(有效水深−最近水位) 估算，
 *   并扣除该池已挂的未走水量；一条计划要么整体落得下，要么整体排队。
 * - 挪不下的按计划先后排队：仍记原池、状态退回「待排」、queued=true，并写明各受纳池
 *   合计还缺多少方（shortM3）。
 */
import type { Pond } from '../types/pond';
import type { Observation } from '../types/observation';
import type { Schedule } from '../types/schedule';
import type { CleaningOrder } from '../types/cleaning';

/** 尚未开始走水的状态（受清池影响） */
const NON_STARTED: ReadonlySet<Schedule['state']> = new Set(['待排', '已排']);

/** 计划日期是否落在清池窗口内；exitDate 留空表示尚未约定退场 */
export function inCleaningWindow(planDate: string, enterDate: string, exitDate: string): boolean {
  if (planDate < enterDate) return false;
  if (exitDate !== '' && planDate > exitDate) return false;
  return true;
}

/** 该池在某张清池单的窗口内是否算「清池中」（单据有效且覆盖该日期） */
export function orderCoversDate(order: Pick<CleaningOrder, 'state' | 'enterDate' | 'exitDate'>, date: string): boolean {
  if (order.state !== '清池中') return false;
  return inCleaningWindow(date, order.enterDate, order.exitDate);
}

/** 取某池最近一次水位（cm），无观测时按有效水深的一半保守估计 */
function latestLevelCm(pondId: string, observations: Observation[]): number {
  const list = observations
    .filter((row) => row.pondId === pondId)
    .sort((a, b) => a.date.localeCompare(b.date));
  return list.length === 0 ? 0 : list[list.length - 1].levelCm;
}

/**
 * 受纳池在指定计划日期的可用容量（m³）。
 * = 面积 × max(有效水深 − 最近水位, 0) ÷ 100，再扣除该池已挂的未走水量。
 */
export function receiveCapacityM3(
  pond: Pond,
  planDate: string,
  schedules: Schedule[],
  observations: Observation[],
): number {
  const freeDepth = Math.max(0, pond.depthCm - latestLevelCm(pond.id, observations));
  let freeM3 = (pond.areaM2 * freeDepth) / 100;
  schedules.forEach((row) => {
    if (row.pondId !== pond.id) return;
    if (row.queued === true) return; // 排队中的计划只占原池名义，不占受纳容量
    if (!NON_STARTED.has(row.state)) return;
    // 只扣与本次计划同期（窗口相邻 ±30 天内）的已挂量，避免把远期计划全扣光
    if (Math.abs(dateGap(row.planDate, planDate)) <= 30) freeM3 -= row.volumeM3;
  });
  return Math.max(0, Math.round(freeM3 * 10) / 10);
}

function dateGap(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((da - db) / 86400000);
}

export interface ReallocateInput {
  /** 本次开/改期的清池单 */
  order: CleaningOrder;
  ponds: Pond[];
  schedules: Schedule[];
  observations: Observation[];
  /** 其余仍有效的清池单（用于排除正在清的受纳池），不含本次单据 */
  otherActiveOrders?: CleaningOrder[];
}

export interface ReallocateResult {
  /** 需要落库的计划（含挪动与排队），按原顺序 */
  updates: Schedule[];
  /** 受影响（在窗口内、未走水）的计划条数 */
  affected: number;
  /** 成功挪走的条数 */
  moved: number;
  /** 挪不下排队的条数 */
  queued: number;
  /** 排队合计缺口（m³） */
  shortTotal: number;
}

/**
 * 按一张清池单重排挂在被清池上的走水编排。
 * 不修改入参数组，返回需要 bulkPut 的计划副本。
 */
export function reallocateForOrder(input: ReallocateInput): ReallocateResult {
  const { order, ponds, schedules, observations } = input;
  const target = ponds.find((pond) => pond.id === order.pondId);
  const updates: Schedule[] = [];
  let moved = 0;
  let queued = 0;
  let shortTotal = 0;

  if (target === undefined) {
    return { updates, affected: 0, moved, queued, shortTotal };
  }

  // 候选受纳池：同池系、在用、不是被清池、且在计划日期没有其他有效清池单
  const otherOrders = input.otherActiveOrders ?? [];
  const candidates = ponds.filter((pond) => {
    if (pond.id === target.id) return false;
    if (pond.seriesName !== target.seriesName) return false;
    if (pond.status !== '在用') return false;
    return !otherOrders.some((o) => o.pondId === pond.id);
  });

  // 受影响的计划：当前挂在被清池、未开始走水、计划日落窗口
  const affectedRows = schedules
    .filter((row) => row.pondId === target.id)
    .filter((row) => NON_STARTED.has(row.state))
    .filter((row) => inCleaningWindow(row.planDate, order.enterDate, order.exitDate))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));

  // 本轮已挪入各受纳池的量，参与容量扣减（在 schedules 副本上累加）
  const working = schedules.map((row) => ({ ...row }));

  affectedRows.forEach((row) => {
    const next: Schedule = {
      ...row,
      originPondId: row.originPondId ?? row.pondId,
      cleaningOrderId: order.id,
      queued: false,
      shortM3: 0,
      acceptedM3: 0,
    };

    // 剩余容量最大的受纳池优先，挪得下就整体挪入
    const ranked = candidates
      .map((pond) => ({ pond, free: receiveCapacityM3(pond, row.planDate, working, observations) }))
      .sort((a, b) => b.free - a.free);
    const fit = ranked.find((item) => item.free >= row.volumeM3);

    if (fit !== undefined) {
      next.pondId = fit.pond.id;
      next.acceptedM3 = row.volumeM3;
      moved += 1;
    } else {
      // 整体排队：仍记原池、退回待排、写明缺口
      const spareTotal = ranked.reduce((acc, item) => acc + Math.max(0, item.free), 0);
      const short = Math.round((row.volumeM3 - spareTotal) * 10) / 10;
      next.pondId = target.id;
      next.state = '待排';
      next.queued = true;
      next.shortM3 = Math.max(0, short);
      queued += 1;
      shortTotal += Math.max(0, short);
    }
    updates.push(next);
    const idx = working.findIndex((item) => item.id === row.id);
    if (idx >= 0) working[idx] = next;
  });

  return { updates, affected: affectedRows.length, moved, queued, shortTotal: Math.round(shortTotal * 10) / 10 };
}

/** 某池当前是否处于「已进场、未退场」的清池中（任意有效单据覆盖 today） */
export function pondIsCleaning(pondId: string, orders: CleaningOrder[], todayDate: string): boolean {
  return orders.some((o) => o.pondId === pondId && orderCoversDate(o, todayDate));
}

/** 某池是否有尚未进场的有效清池单（待进场提示） */
export function pondPendingCleaning(pondId: string, orders: CleaningOrder[], todayDate: string): CleaningOrder | null {
  const found = orders.find(
    (o) => o.pondId === pondId && o.state === '清池中' && o.enterDate > todayDate,
  );
  return found ?? null;
}
