/**
 * 清池单（CleaningOrder）
 * 清池班在蒸发池上开单：写清进场 / 退场日期与清完剩余水深。
 * 没退场（state = 清池中）前，这口池算「清池中」，挂在它上面的走水编排要退回待排并挪到池系别的在用池。
 */

/** 清池单状态：清池中（未退场）/ 已退场 / 已作废 */
export type CleaningState = '清池中' | '已退场' | '已作废'

export const CLEANING_STATE_OPTIONS: CleaningState[] = ['清池中', '已退场', '已作废']

export interface CleaningOrder {
  id: string
  /** 所清蒸发池 */
  pondId: string
  /** 进场日期 YYYY-MM-DD */
  entryDate: string
  /** 退场日期 YYYY-MM-DD；未退场为空字符串 */
  exitDate: string
  /** 清完剩余水深（cm） */
  residualDepthCm: number
  /** 清池班组长 */
  crewLeader: string
  /** 备注 */
  note: string
  /** 单据状态：清池中 / 已退场 / 已作废 */
  state: CleaningState
  /** 旧数据升级回填：true 表示由 v2→v3 迁移按池当时状态补单，而非清池班实开 */
  backfilled: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑清池单的表单草稿 */
export interface CleaningDraft {
  pondId: string
  entryDate: string
  exitDate: string
  residualDepthCm: number
  crewLeader: string
  note: string
}

/** 清池单是否仍在执行（未退场、未作废）：此期间该池算「清池中」 */
export function isOrderActive(order: Pick<CleaningOrder, 'state'>): boolean {
  return order.state === '清池中'
}
