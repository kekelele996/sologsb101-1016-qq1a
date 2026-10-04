/**
 * 发运单（ShipmentOrder）
 * 储运班手里的外送台账：每张发运单归属一口蒸发池，记计划发运量与累计装车量。
 * 调度室推进出卤前必须按发运单与槽车运力核单；发运单只能由储运班维护，调度室改不了。
 */

/** 发运单状态：待发运 / 装运中 / 已装完 / 已作废 */
export type ShipmentStatus = '待发运' | '装运中' | '已装完' | '已作废'

export const SHIPMENT_STATUS_OPTIONS: ShipmentStatus[] = ['待发运', '装运中', '已装完', '已作废']

export interface ShipmentOrder {
  id: string
  /** 发运单号 */
  code: string
  /** 归属蒸发池 */
  pondId: string
  /** 计划发运量（m³） */
  plannedVolumeM3: number
  /** 累计已装车量（m³），由装车登记逐次累加 */
  loadedVolumeM3: number
  /** 发运单状态 */
  status: ShipmentStatus
  /** 承运方 */
  carrier: string
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建发运单的表单草稿（装车量由装车登记累加，不在草稿里；改派别池走专门动作） */
export interface ShipmentDraft {
  code: string
  pondId: string
  plannedVolumeM3: number
  carrier: string
  note: string
}
