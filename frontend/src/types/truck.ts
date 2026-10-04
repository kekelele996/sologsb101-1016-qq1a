/**
 * 槽车（TankTruck）与罐区（TankFarm）
 * 储运班的运力与库容台账：槽车日运力 = 单车运力 × 每日趟数；
 * 罐区占用量由「累计已出卤 − 累计已装车」派生，剩余容量不足时出卤按池排队。
 */

/** 槽车状态：可用 / 维修中 */
export type TruckStatus = '可用' | '维修中'

export const TRUCK_STATUS_OPTIONS: TruckStatus[] = ['可用', '维修中']

export interface TankTruck {
  id: string
  /** 车牌号 */
  plateNo: string
  /** 单车运力（m³/趟） */
  capacityM3: number
  /** 每日趟数 */
  tripsPerDay: number
  /** 槽车状态 */
  status: TruckStatus
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑槽车的表单草稿 */
export interface TruckDraft {
  plateNo: string
  capacityM3: number
  tripsPerDay: number
  status: TruckStatus
}

/** 罐区固定 id（全厂一座成品卤罐区） */
export const TANK_FARM_ID = 'tankfarm-main'

export interface TankFarm {
  id: string
  /** 罐区名称 */
  name: string
  /** 总容量（m³），由储运班维护 */
  totalCapacityM3: number
  createdAt: string
  updatedAt: string
  revision: number
}
