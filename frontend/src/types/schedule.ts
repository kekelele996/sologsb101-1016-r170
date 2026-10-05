/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 清池联动：清池班在某口池开清池单（未退场）后，挂在这口池上且尚未走水的编排
 * 退回「待排」，并由调度室挪到同池系别的在用池；挪不下按受纳容量排队并写明缺多少方。
 * 调度室这份自己留底：homePondId 始终记录这条编排原本挂在哪口池，挪水只改 pondId。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/**
 * 挪水处置去向：
 * - undefined / 本池：仍在原池，未受清池影响
 * - 已挪池：已挪到同池系别的在用池（pondId 为受纳池，homePondId 为原池）
 * - 排队待容：同池系在用池都受纳不下，按受纳容量排队，shortfallM3 写明缺多少方
 */
export type ScheduleDisposition = '本池' | '已挪池' | '排队待容'

export interface Schedule {
  id: string
  /** 当前所属蒸发池（被清池挪水后为受纳池；排队时仍指向原池） */
  pondId: string
  /** 原挂池：调度室留底，无论挪到哪口池都不被覆盖；未发生挪水时与 pondId 相同 */
  homePondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 挪水处置去向 */
  disposition: ScheduleDisposition
  /** 因哪张清池单被退回 / 挪水 / 排队（清池单 id；未受影响为空） */
  cleaningOrderId: string
  /** 排队待容时缺多少方（m³）：计划量超出同池系在用池剩余受纳容量的部分 */
  shortfallM3: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}

/** 尚未走水、会被清池退回待排的状态 */
export function isPreRunState(state: ScheduleState): boolean {
  return state === '待排' || state === '已排'
}
