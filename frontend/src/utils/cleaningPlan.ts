/**
 * 清池联动走水重排引擎（纯函数，不依赖 Dexie，供运行时与 v2→v3 升级迁移共用）
 *
 * 清池班在某口池开清池单（未退场）后：
 *  1. 挂在这口池上、尚未走水（待排 / 已排）的编排一律退回「待排」；
 *  2. 「走水中」的照走完，不动；「已出卤」历史不动；
 *  3. 退回的编排挪到同一池系别的「在用」池：按受纳池剩余容量贪心装入（先到先得，优先塞最紧的一口）；
 *  4. 同池系在用池都受纳不下的，排队待容，并写明缺多少方（计划量 − 池系剩余受纳容量）。
 *
 * 调度室留底：homePondId 始终是原挂池，挪水只改 pondId；清池单改期 / 作废后按池重排，
 * 受影响的编排先归位原池再重新装位。
 */
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import { pondVolumeM3 } from './brine';

/** 生效中的清池单只需要两个字段：挂在哪口池、单据 id（排队 / 留底要回写） */
export interface ActiveCleaningOrder {
  id: string;
  pondId: string;
}

/** 容量重算需要的观测水位：按池取最近一次即可 */
export interface LevelPoint {
  pondId: string;
  date: string;
  levelCm: number;
}

export interface ReplannedSchedule {
  id: string
  pondId: string
  homePondId: string
  state: Schedule['state']
  disposition: Schedule['disposition']
  cleaningOrderId: string
  shortfallM3: number
}

export interface ReplanResult {
  /** 被改动的编排（仅包含需要写库的行） */
  changes: ReplannedSchedule[];
  /** 排队待容条数 */
  queuedCount: number;
  /** 排队缺方合计（m³） */
  totalShortfallM3: number;
  /** 退回待排条数（含成功挪走与排队） */
  returnedCount: number;
  /** 照走完不动的条数（清池开单时正在走水） */
  runningUntouchedCount: number;
  /** 成功挪到别的在用池的条数 */
  relocatedCount: number;
}

/** 池的剩余受纳容量（m³）= 有效体积 − 当前存量；观测缺失时按满池保守取 0 */
export function freeCapacityM3(pond: Pond, latestLevelCm: number | null): number {
  if (pond.status !== '在用') return 0;
  const total = pondVolumeM3(pond.areaM2, pond.depthCm);
  if (latestLevelCm === null || latestLevelCm <= 0) return 0;
  const current = pondVolumeM3(pond.areaM2, Math.min(latestLevelCm, pond.depthCm));
  return Math.max(0, Math.round((total - current) * 10) / 10);
}

/** 按池取最近一次观测水位 */
export function latestLevels(points: LevelPoint[]): Map<string, number> {
  const map = new Map<string, LevelPoint>();
  points.forEach((point) => {
    const prev = map.get(point.pondId);
    if (prev === undefined || point.date >= prev.date) map.set(point.pondId, point);
  });
  return new Map(Array.from(map.values()).map((point) => [point.pondId, point.levelCm]));
}

/**
 * 按当前生效清池单全量重排走水编排。
 * 幂等：同一份输入多次运行结果一致；不碰「走水中 / 已出卤」，也不碰未挂清池池的编排。
 */
export function replanForCleaning(
  ponds: Pond[],
  orders: ActiveCleaningOrder[],
  schedules: Schedule[],
  levels: Map<string, number>,
): ReplanResult {
  const pondById = new Map(ponds.map((pond) => [pond.id, pond]));
  const activeOrderByPond = new Map(orders.map((order) => [order.pondId, order]));

  // 受纳池初始剩余容量：同池系别的「在用」池，且自身不在清池中
  const capacityById = new Map<string, number>();
  ponds.forEach((pond) => {
    if (pond.status === '在用' && !activeOrderByPond.has(pond.id)) {
      capacityById.set(pond.id, freeCapacityM3(pond, levels.get(pond.id) ?? null));
    }
  });

  const changes: ReplannedSchedule[] = [];
  let queuedCount = 0;
  let totalShortfallM3 = 0;
  let returnedCount = 0;
  let runningUntouchedCount = 0;
  let relocatedCount = 0;

  const pushChange = (schedule: Schedule, next: Omit<ReplannedSchedule, 'id' | 'homePondId'>): void => {
    const homePondId = schedule.homePondId || schedule.pondId;
    const prev = changes.find((item) => item.id === schedule.id);
    const patch: ReplannedSchedule = { id: schedule.id, homePondId, ...next };
    if (prev) Object.assign(prev, patch);
    else changes.push(patch);
  };

  // 第一步：归位。凡原挂池（homePondId）上有生效清池单的未完成编排，一律回到原池并退回待排，
  // 清掉上一轮的挪水 / 排队标记后再统一重新装位（支撑「清池单改期 / 作废后按池重排」）。
  const affected = schedules.filter((schedule) => {
    const homePondId = schedule.homePondId || schedule.pondId;
    return schedule.state !== '已出卤' && activeOrderByPond.has(homePondId);
  });

  affected.forEach((schedule) => {
    const homePondId = schedule.homePondId || schedule.pondId;
    const order = activeOrderByPond.get(homePondId)!;
    if (schedule.state === '走水中') {
      // 正在走的照走完：留在当前池（可能是受纳池），不退回、不排队
      runningUntouchedCount += 1;
      pushChange(schedule, {
        pondId: schedule.pondId,
        state: '走水中',
        disposition: schedule.disposition === '已挪池' ? '已挪池' : '本池',
        cleaningOrderId: order.id,
        shortfallM3: 0,
      });
      return;
    }
    returnedCount += 1;
    pushChange(schedule, {
      pondId: homePondId,
      state: '待排',
      disposition: '本池',
      cleaningOrderId: order.id,
      shortfallM3: 0,
    });
  });

  // 第二步：把退回待排的编排按走水先后（orderIndex，再按计划日期）装入同池系在用池。
  const candidates = affected
    .filter((schedule) => schedule.state !== '走水中')
    .map((schedule) => ({ schedule, homePondId: schedule.homePondId || schedule.pondId }))
    .sort(
      (a, b) =>
        a.schedule.orderIndex - b.schedule.orderIndex ||
        a.schedule.planDate.localeCompare(b.schedule.planDate) ||
        a.schedule.id.localeCompare(b.schedule.id),
    );

  // 孤儿归位：清池单改期 / 作废后原挂池已无生效单，但上一轮被挪到受纳池、仍未走水的编排，
  // 不在 affected 里（其 homePondId 已无生效单），需要归位原池、清掉挪水 / 排队留底。
  // 正在走水的照走完（即便清池单作废也停不下来），已出卤的历史不动。
  const orphaned = schedules.filter(
    (schedule) => {
      const homePondId = schedule.homePondId || schedule.pondId;
      return (
        (schedule.disposition === '已挪池' || schedule.disposition === '排队待容') &&
        !activeOrderByPond.has(homePondId) &&
        schedule.state !== '走水中' &&
        schedule.state !== '已出卤'
      );
    },
  );
  orphaned.forEach((schedule) => {
    const homePondId = schedule.homePondId || schedule.pondId;
    pushChange(schedule, {
      pondId: homePondId,
      state: schedule.state === '已排' ? '已排' : '待排',
      disposition: '本池',
      cleaningOrderId: '',
      shortfallM3: 0,
    });
  });

  candidates.forEach(({ schedule, homePondId }) => {
    const homePond = pondById.get(homePondId);
    const order = activeOrderByPond.get(homePondId)!;
    if (homePond === undefined) return;

    // 同池系、在用、非清池中、且装得下整笔计划量的受纳池；选剩余容量最紧的一口（best-fit）
    const fits = ponds
      .filter(
        (pond) =>
          pond.id !== homePondId &&
          pond.seriesName === homePond.seriesName &&
          pond.status === '在用' &&
          !activeOrderByPond.has(pond.id) &&
          (capacityById.get(pond.id) ?? 0) + 1e-6 >= schedule.volumeM3,
      )
      .sort((a, b) => (capacityById.get(a.id) ?? 0) - (capacityById.get(b.id) ?? 0) || a.code.localeCompare(b.code));

    const target = fits[0];
    if (target !== undefined) {
      capacityById.set(target.id, Math.round(((capacityById.get(target.id) ?? 0) - schedule.volumeM3) * 10) / 10);
      relocatedCount += 1;
      pushChange(schedule, {
        pondId: target.id,
        state: '待排',
        disposition: '已挪池',
        cleaningOrderId: order.id,
        shortfallM3: 0,
      });
      return;
    }

    // 挪不下：按受纳容量排队。缺方 = 计划量 − 同池系在用池剩余受纳容量合计
    const seriesFree = ponds
      .filter(
        (pond) =>
          pond.id !== homePondId &&
          pond.seriesName === homePond.seriesName &&
          pond.status === '在用' &&
          !activeOrderByPond.has(pond.id),
      )
      .reduce((acc, pond) => acc + (capacityById.get(pond.id) ?? 0), 0);
    const shortfall = Math.max(0, Math.round((schedule.volumeM3 - seriesFree) * 10) / 10);
    queuedCount += 1;
    totalShortfallM3 = Math.round((totalShortfallM3 + shortfall) * 10) / 10;
    pushChange(schedule, {
      pondId: homePondId,
      state: '待排',
      disposition: '排队待容',
      cleaningOrderId: order.id,
      shortfallM3: shortfall,
    });
  });

  return { changes, queuedCount, totalShortfallM3, returnedCount, runningUntouchedCount, relocatedCount };
}

/** 把重排结果合并进编排行（返回新数组，不改原行） */
export function applyReplan(schedules: Schedule[], result: ReplanResult): Schedule[] {
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
