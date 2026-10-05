/**
 * 清池单（CleaningOrder）
 * 清池班在蒸发池上开的作业单：写清进场日期、预计退场日期与清完水深。
 * 从进场到退场（含未填退场日期）这口池都算「清池中」；退场后回填实际水深，池恢复在用。
 */

/** 清池单状态：清池中 / 已清完 / 已作废 */
export type CleaningState = '清池中' | '已清完' | '已作废'

export const CLEANING_STATE_OPTIONS: CleaningState[] = ['清池中', '已清完', '已作废']

export interface CleaningOrder {
  id: string
  /** 被清的蒸发池 */
  pondId: string
  /** 进场日期 YYYY-MM-DD（从这一天起算清池中） */
  enterDate: string
  /** 预计退场日期 YYYY-MM-DD；可留空，表示未约定退场 */
  exitDate: string
  /** 清完后剩余水深（cm），退场时据此回写池有效水深 */
  remainDepthCm: number
  /** 清池负责人（清池班） */
  crew: string
  /** 单据状态 */
  state: CleaningState
  /** 旧数据升级回填的单据标记 true（非清池班实开，仅用于对账） */
  backfilled: boolean
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑清池单的表单草稿 */
export interface CleaningDraft {
  pondId: string
  enterDate: string
  exitDate: string
  remainDepthCm: number
  crew: string
  state: CleaningState
  note: string
}
