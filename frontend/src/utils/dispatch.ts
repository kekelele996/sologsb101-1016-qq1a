/**
 * 外送调度业务规则（纯函数，不直接读写数据库）
 * - 发运单剩余量与槽车运力核算
 * - 罐区占用与剩余容量（占用 = 累计已出卤 − 累计已装车）
 * - 出卤核单：发运单 + 槽车运力 + 罐区容量逐项核，罐区不足给出排队差额
 * - 按池对账：调度累计外送 vs 储运累计装车，超容差待复核
 */
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import type { ShipmentOrder } from '../types/shipment';
import type { TankTruck } from '../types/truck';
import type { ReconReview } from '../types/recon';
import { RECON_TOLERANCE_M3 } from '../types/recon';
import { round1 } from './brine';

/** 发运单剩余可装量（m³） */
export function orderRemainingM3(order: Pick<ShipmentOrder, 'plannedVolumeM3' | 'loadedVolumeM3'>): number {
  return Math.max(0, round1(order.plannedVolumeM3 - order.loadedVolumeM3));
}

/** 单台槽车日运力（m³/日）= 单车运力 × 每日趟数；维修中不计 */
export function truckDailyCapacityM3(truck: Pick<TankTruck, 'capacityM3' | 'tripsPerDay' | 'status'>): number {
  if (truck.status !== '可用') return 0;
  return round1(truck.capacityM3 * Math.max(0, truck.tripsPerDay));
}

/** 可用槽车日总运力（m³/日） */
export function availableTruckCapacityM3(trucks: TankTruck[]): number {
  return round1(trucks.reduce((acc, truck) => acc + truckDailyCapacityM3(truck), 0));
}

/** 罐区已占用（m³）= 累计已出卤 − 累计已装车（作废单不计），不为负 */
export function tankFarmOccupiedM3(schedules: Schedule[], orders: ShipmentOrder[]): number {
  const discharged = schedules
    .filter((row) => row.state === '已出卤')
    .reduce((acc, row) => acc + row.volumeM3, 0);
  const loaded = orders
    .filter((row) => row.status !== '已作废')
    .reduce((acc, row) => acc + row.loadedVolumeM3, 0);
  return Math.max(0, round1(discharged - loaded));
}

/** 出卤核单结果 */
export interface DischargeCheck {
  /** ok=核单通过可出卤；queue=罐区不足按池排队；block=发运单/运力核不过 */
  action: 'ok' | 'queue' | 'block';
  /** 核不过的原因清单（action = block 时非空） */
  blockers: string[];
  /** 核单时接上的发运单归属（原有关联仍有效则保留，否则自动匹配同池有效单） */
  matchedOrderId: string | null;
  /** 接上归属的发运单号（无归属时为 ''） */
  matchedOrderCode: string;
  /** 罐区剩余容量（m³） */
  tankRemainingM3: number;
  /** 排队时罐区还差多少方（m³，action = queue 时 > 0） */
  shortfallM3: number;
  /** 同池有效发运单剩余可装总量（m³） */
  orderRemainingTotalM3: number;
  /** 槽车可用日运力（m³/日） */
  truckCapacityM3: number;
}

/**
 * 出卤核单：调度员推进出卤前，按发运单与槽车运力核一遍。
 * 1. 外送归属：原关联单仍有效则沿用，否则自动匹配同池有效发运单（剩余量够的最早一张）；
 * 2. 同池发运单剩余可装总量须覆盖本次出卤量；
 * 3. 可用槽车日运力须覆盖本次出卤量；
 * 4. 罐区剩余容量不足时不阻断流程，转为按池排队并给出还差多少方。
 */
export function checkDischarge(input: {
  schedule: Schedule;
  orders: ShipmentOrder[];
  trucks: TankTruck[];
  /** 全部走水计划（用于罐区占用派生） */
  schedules: Schedule[];
  totalCapacityM3: number;
}): DischargeCheck {
  const { schedule, orders, trucks, schedules, totalCapacityM3 } = input;
  const pondOrders = orders
    .filter((row) => row.pondId === schedule.pondId && row.status !== '已作废')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const orderRemainingTotalM3 = round1(pondOrders.reduce((acc, row) => acc + orderRemainingM3(row), 0));
  const truckCapacityM3 = availableTruckCapacityM3(trucks);
  const occupiedM3 = tankFarmOccupiedM3(schedules, orders);
  const tankRemainingM3 = round1(Math.max(0, totalCapacityM3 - occupiedM3));

  // 1. 外送归属：原关联有效则沿用；否则自动匹配同池有效单，把两边接上
  let matched: ShipmentOrder | null = null;
  if (schedule.shipmentOrderId !== null) {
    const linked = pondOrders.find((row) => row.id === schedule.shipmentOrderId);
    if (linked !== undefined) matched = linked;
  }
  if (matched === null) {
    matched =
      pondOrders.find((row) => orderRemainingM3(row) >= schedule.volumeM3) ??
      [...pondOrders].sort((a, b) => orderRemainingM3(b) - orderRemainingM3(a))[0] ??
      null;
  }

  const blockers: string[] = [];
  if (matched === null) {
    blockers.push('没有归属本池的有效发运单，等储运班开单后再排');
  }
  if (orderRemainingTotalM3 < schedule.volumeM3) {
    blockers.push(
      `发运单剩余量不足：剩 ${orderRemainingTotalM3} m³，还差 ${round1(schedule.volumeM3 - orderRemainingTotalM3)} m³`,
    );
  }
  if (truckCapacityM3 < schedule.volumeM3) {
    blockers.push(
      `槽车可用运力不足：日运力 ${truckCapacityM3} m³，还差 ${round1(schedule.volumeM3 - truckCapacityM3)} m³`,
    );
  }
  if (blockers.length > 0) {
    return {
      action: 'block',
      blockers,
      matchedOrderId: matched?.id ?? null,
      matchedOrderCode: matched?.code ?? '',
      tankRemainingM3,
      shortfallM3: 0,
      orderRemainingTotalM3,
      truckCapacityM3,
    };
  }

  // 4. 罐区容量：不足则按池排队，本轮水位与目标密度不动
  if (tankRemainingM3 < schedule.volumeM3) {
    return {
      action: 'queue',
      blockers: [],
      matchedOrderId: matched?.id ?? null,
      matchedOrderCode: matched?.code ?? '',
      tankRemainingM3,
      shortfallM3: round1(schedule.volumeM3 - tankRemainingM3),
      orderRemainingTotalM3,
      truckCapacityM3,
    };
  }

  return {
    action: 'ok',
    blockers: [],
    matchedOrderId: matched?.id ?? null,
    matchedOrderCode: matched?.code ?? '',
    tankRemainingM3,
    shortfallM3: 0,
    orderRemainingTotalM3,
    truckCapacityM3,
  };
}

/** 按池对账一行 */
export interface ReconRow {
  pondId: string;
  pondCode: string;
  seriesName: string;
  /** 调度侧累计外送量（m³）：该池已出卤走水计划量合计 */
  scheduleTotalM3: number;
  /** 储运侧累计装车量（m³）：该池有效发运单已装车量合计 */
  shipmentTotalM3: number;
  /** 差值（m³）= 调度外送 − 储运装车 */
  diffM3: number;
  /** 差值绝对值超过容差 */
  overTolerance: boolean;
  /** 当前两边数字已被储运班复核确认 */
  reviewed: boolean;
  /** 最近一条复核记录（无则 null） */
  lastReview: ReconReview | null;
}

/**
 * 按池号对账：同一口池累计外送量与储运班装车量逐池对比。
 * 超容差且未被复核的排最前，等储运班把两边数字摆出来复核。
 */
export function reconcileByPond(
  ponds: Pond[],
  schedules: Schedule[],
  orders: ShipmentOrder[],
  reviews: ReconReview[],
): ReconRow[] {
  const rows = ponds.map((pond) => {
    const scheduleTotalM3 = round1(
      schedules
        .filter((row) => row.pondId === pond.id && row.state === '已出卤')
        .reduce((acc, row) => acc + row.volumeM3, 0),
    );
    const shipmentTotalM3 = round1(
      orders
        .filter((row) => row.pondId === pond.id && row.status !== '已作废')
        .reduce((acc, row) => acc + row.loadedVolumeM3, 0),
    );
    const diffM3 = round1(scheduleTotalM3 - shipmentTotalM3);
    const lastReview =
      reviews
        .filter((row) => row.pondId === pond.id)
        .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0] ?? null;
    // 复核只对当时的数字负责：两边任一数字再变，重新待复核
    const reviewed =
      lastReview !== null &&
      lastReview.scheduleTotalM3 === scheduleTotalM3 &&
      lastReview.shipmentTotalM3 === shipmentTotalM3;
    return {
      pondId: pond.id,
      pondCode: pond.code,
      seriesName: pond.seriesName,
      scheduleTotalM3,
      shipmentTotalM3,
      diffM3,
      overTolerance: Math.abs(diffM3) > RECON_TOLERANCE_M3,
      reviewed,
      lastReview,
    };
  });
  return rows.sort((a, b) => {
    const rank = (row: ReconRow): number => {
      if (row.overTolerance && !row.reviewed) return 0;
      if (row.overTolerance) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.pondCode.localeCompare(b.pondCode);
  });
}
