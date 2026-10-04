/**
 * 发运单（ShippingOrder）——储运班的外送账本
 * 卤水晒到目标密度后就得外送，储运班手里的发运单与槽车另记一本，
 * 调度室排的走水计划要靠它接上：推进出卤前先按发运单和槽车运力核一遍。
 * 调度室改不了发运单：作废 / 改派别池只能由储运班操作，调度室只选外送归属。
 */

/** 发运单状态：有效 / 作废 */
export type ShippingOrderStatus = '有效' | '作废'

export const SHIPPING_ORDER_STATUS_OPTIONS: ShippingOrderStatus[] = ['有效', '作废']

export interface ShippingOrder {
  id: string
  /** 发运单号 */
  orderNo: string
  /** 装车池号（储运班指定从哪口池装车外送） */
  pondId: string
  /** 发运量（m³）：本单计划外送总量 */
  volumeM3: number
  /** 槽车数量 */
  tankCarCount: number
  /** 单车运力（m³/车） */
  tankCarCapacityM3: number
  /** 已装车量（m³） */
  loadedVolumeM3: number
  /** 去向罐区 */
  tankFarm: string
  /** 发运日期 YYYY-MM-DD */
  shipDate: string
  /** 状态：有效 / 作废 */
  status: ShippingOrderStatus
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑发运单的表单草稿 */
export interface ShippingOrderDraft {
  orderNo: string
  pondId: string
  volumeM3: number
  tankCarCount: number
  tankCarCapacityM3: number
  loadedVolumeM3: number
  tankFarm: string
  shipDate: string
  status: ShippingOrderStatus
  note: string
}

/** 槽车总运力（m³）= 槽车数量 × 单车运力 */
export function tankCarTotalCapacity(order: Pick<ShippingOrder, 'tankCarCount' | 'tankCarCapacityM3'>): number {
  return Math.round(order.tankCarCount * order.tankCarCapacityM3 * 10) / 10
}

/** 发运单剩余可装量（m³）= 发运量 − 已装车量 */
export function orderRemainingM3(order: Pick<ShippingOrder, 'volumeM3' | 'loadedVolumeM3'>): number {
  return Math.max(0, Math.round((order.volumeM3 - order.loadedVolumeM3) * 10) / 10)
}
