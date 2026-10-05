/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 当前挂接的蒸发池（被挪走后为受纳池；排队待排时仍记原池） */
  pondId: string
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
  /** 因清池被挪走前的原池（调度室对账与恢复用，未挪过为 undefined） */
  originPondId?: string
  /** 由哪张清池单触发的挪动/排队，未涉及清池为 undefined */
  cleaningOrderId?: string
  /** 是否在受纳容量队列里等待重排（池仍为原池、状态退回待排） */
  queued?: boolean
  /** 排队时各受纳池合计仍缺的容量（m³），0/缺省表示不缺 */
  shortM3?: number
  /** 本次已被哪个受纳池吃下（m³），与 volumeM3 相等即已挪入 */
  acceptedM3?: number
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
