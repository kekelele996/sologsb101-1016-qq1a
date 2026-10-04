/**
 * 按池对账（ReconReview）
 * 同一口池的累计外送量（调度室走水账）与累计装车量（储运班发运账）按池号对账；
 * 差值超过容差时把两边数字摆出来，等储运班复核确认；数字再变则重新待复核。
 */

/** 对账容差（m³）：两边差值绝对值超过它即判超差 */
export const RECON_TOLERANCE_M3 = 20

export interface ReconReview {
  id: string
  /** 对账蒸发池 */
  pondId: string
  /** 复核时调度侧累计外送量（m³） */
  scheduleTotalM3: number
  /** 复核时储运侧累计装车量（m³） */
  shipmentTotalM3: number
  /** 复核时差值（m³）= 调度外送 − 储运装车 */
  diffM3: number
  /** 复核人（储运班） */
  reviewer: string
  /** 复核时间 */
  reviewedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}
