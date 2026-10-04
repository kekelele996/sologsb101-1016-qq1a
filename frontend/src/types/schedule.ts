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
  /** 所属蒸发池 */
  pondId: string
  /**
   * 外送归属发运单（储运班发运单）——v3 新增字段。
   * 旧版走水计划缺外送归属，升级到 v3 后按池号补齐（同池有效发运单），原顺序与状态留着。
   * 调度室只能选择外送归属，改不了发运单本身。
   */
  shippingOrderId: string
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
  /**
   * 排队原因：密度到了但罐区容量不够时按池排队，写明还差多少方；
   * 排队期间池里水位与目标密度这轮不动（不回写池阶段 / 密度）。
   */
  queueReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  /** 外送归属发运单 id（可空，表示暂未指定，推进出卤前必须核一遍） */
  shippingOrderId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
