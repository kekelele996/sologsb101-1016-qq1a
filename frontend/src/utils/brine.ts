/**
 * 卤水计算工具
 * - 密度—温度修正
 * - 蒸发量经验公式与密度增速
 * - 离子当量换算与达标判定
 * - 池体积与闸门过流估算
 */
import type { Assay, AssayVerdict } from '../types/assay';
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import type { ShippingOrder } from '../types/shippingOrder';
import { orderRemainingM3, tankCarTotalCapacity } from '../types/shippingOrder';

/** 保留 1 位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 保留 3 位小数 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 参考温度（℃） */
export const REFERENCE_TEMP_C = 25;

/** 卤水密度温度修正系数（1/℃），温度升高密度下降 */
export const DENSITY_TEMP_COEFF = 0.00035;

/**
 * 密度—温度修正：把实测密度折算到 25 ℃ 参考温度下的密度。
 * density(25) = density(t) + coeff × (t - 25)
 */
export function correctDensity(densityGcm3: number, tempC: number): number {
  return round3(densityGcm3 + DENSITY_TEMP_COEFF * (tempC - REFERENCE_TEMP_C));
}

/** 蒸发量经验公式基准值（mm/d） */
export const EVAP_BASE_MM = 5.5;

/**
 * 蒸发量经验估算（mm/d）
 * 温度越高、风力越大蒸发越强；卤水密度越高、水活度越低蒸发越弱。
 */
export function estimateEvapMm(
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): number {
  if (!Number.isFinite(densityGcm3) || densityGcm3 <= 0) return 0;
  const tempFactor = 1 + Math.max(0, tempC - 10) * 0.022;
  const windFactor = 1 + Math.max(0, windLevel) * 0.06;
  const brineFactor = Math.max(0.15, Math.min(1.2, 1 - (densityGcm3 - 1.02) * 0.9));
  // 水位低于 10 cm 时按比例折减，避免浅池出现不合理的大蒸发量
  const levelFactor = levelCm >= 10 ? 1 : Math.max(0.3, levelCm / 10);
  return round1(EVAP_BASE_MM * tempFactor * windFactor * brineFactor * levelFactor);
}

/** 密度增速（g/cm³/天） */
export function densityGrowthRate(previousDensity: number, currentDensity: number, days: number): number {
  if (days <= 0) return 0;
  return round3((currentDensity - previousDensity) / days);
}

/** 池体有效体积（m³）= 面积 × 有效水深 */
export function pondVolumeM3(areaM2: number, depthCm: number): number {
  return Math.round(areaM2 * (depthCm / 100) * 10) / 10;
}

/** 闸门过流面积（㎡）= 口宽(m) × 开度对应水深(m) */
export function gateFlowAreaM2(gate: Pick<Gate, 'widthCm' | 'openingPct'>): number {
  const widthM = gate.widthCm / 100;
  const openM = (gate.openingPct / 100) * 0.6;
  return Math.round(widthM * openM * 100) / 100;
}

/**
 * 下游预计进水量（m³/d）
 * 由过流面积、上游水位与开度共同决定，作为开度调整后的即时反馈。
 */
export function estimateInflowM3(
  gate: Pick<Gate, 'widthCm' | 'openingPct' | 'state'>,
  upstreamLevelCm: number,
): number {
  if (gate.state === '关闭' || gate.openingPct <= 0) return 0;
  const area = gateFlowAreaM2(gate);
  const headM = Math.max(0.05, upstreamLevelCm / 100);
  // 简易堰流公式系数，仅用于量级估算
  const flow = 1.7 * area * Math.sqrt(headM) * (gate.openingPct / 100) * 86400 / 10;
  return Math.round(flow * 10) / 10;
}

/** 按开度推导闸门状态 */
export function stateFromOpening(openingPct: number): Gate['state'] {
  if (openingPct <= 0) return '关闭';
  if (openingPct >= 95) return '全开';
  return '半开';
}

/** 离子当量换算（meq/L）：Li⁺=6.94, K⁺=39.10, Mg²⁺=12.15, Na⁺=23.00 */
export function ionEquivalent(liGpl: number, kGpl: number, mgGpl: number, naGpl: number): number {
  const li = liGpl / 6.94;
  const k = kGpl / 39.1;
  const mg = (mgGpl / 12.15) * 2;
  const na = naGpl / 23;
  return round1(li + k + mg + na);
}

/** 出卤达标阈值：Li⁺ 与 K⁺ 双指标 */
export const ASSAY_THRESHOLD = {
  liPass: 1.0,
  liNear: 0.6,
  kPass: 20,
  kNear: 12,
} as const;

/** 自动达标判定：Li⁺ 与 K⁺ 均达标为「达标」，任一项接近为「接近」，否则「未达标」 */
export function autoVerdict(liGpl: number, kGpl: number): AssayVerdict {
  const liPass = liGpl >= ASSAY_THRESHOLD.liPass;
  const kPass = kGpl >= ASSAY_THRESHOLD.kPass;
  if (liPass && kPass) return '达标';
  const liNear = liGpl >= ASSAY_THRESHOLD.liNear;
  const kNear = kGpl >= ASSAY_THRESHOLD.kNear;
  if ((liPass || liNear) && (kPass || kNear)) return '接近';
  return '未达标';
}

/** 取化验记录的实际判定（人工覆盖优先） */
export function effectiveVerdict(assay: Pick<Assay, 'verdict' | 'verdictManual' | 'liGpl' | 'kGpl'>): AssayVerdict {
  if (assay.verdictManual) return assay.verdict;
  return autoVerdict(assay.liGpl, assay.kGpl);
}

/** 密度是否达到目标（用于判断走水是否可以出卤） */
export function densityReached(currentDensity: number, targetDensity: number): boolean {
  return currentDensity >= targetDensity;
}

/* ------------------------------ 罐区容量 ------------------------------ */

/**
 * 罐区额定容量（m³）：按去向罐区名称配置，未配置的罐区用默认容量。
 * 出卤前核检的一环：密度到了但罐区容量不够，就按池排队并写明还差多少方。
 */
export const TANK_FARM_CAPACITY_M3: Record<string, number> = {
  东罐区: 2000,
  西罐区: 1500,
};

/** 未在配置中列出的罐区，统一按默认容量核算 */
export const DEFAULT_TANK_FARM_CAPACITY_M3 = 1000;

export function tankFarmCapacityM3(tankFarm: string): number {
  return TANK_FARM_CAPACITY_M3[tankFarm] ?? DEFAULT_TANK_FARM_CAPACITY_M3;
}

/* ------------------------------ 按池对账 ------------------------------ */

/** 对账容差：累计外送量与装车量相差超过 5%（且绝对差 > 1 m³）即判定不符，转储运班复核 */
export const RECONCILE_TOLERANCE_PCT = 0.05;

/** 单口池的对账结果：调度室累计外送量 vs 储运班装车量，按池号对账 */
export interface ReconcileResult {
  pondId: string;
  /** 调度室累计外送量（m³）：已出卤走水计划的计划量之和 */
  dispatchM3: number;
  /** 储运班装车量（m³）：发运单已装车量之和 */
  loadedM3: number;
  /** 差值 = 调度室 − 储运班（m³） */
  diffM3: number;
  /** 是否超过容差：不符 → 把两边数字摆出来等储运班复核，调度室改不了发运单 */
  mismatch: boolean;
}

/** 单口池对账：累计外送量与装车量按池号对账，差过容差就摆出来等储运班复核 */
export function reconcilePond(pondId: string, dispatchM3: number, loadedM3: number): ReconcileResult {
  const diffM3 = Math.round((dispatchM3 - loadedM3) * 10) / 10;
  const tolerance = Math.max(1, RECONCILE_TOLERANCE_PCT * Math.max(dispatchM3, loadedM3));
  return { pondId, dispatchM3, loadedM3, diffM3, mismatch: Math.abs(diffM3) > tolerance };
}

/** 全部蒸发池的对账结果（按池号） */
export function reconcileByPond(ponds: Pond[], schedules: Schedule[], orders: ShippingOrder[]): ReconcileResult[] {
  return ponds.map((pond) => {
    const dispatchM3 = Math.round(
      schedules
        .filter((row) => row.pondId === pond.id && row.state === '已出卤')
        .reduce((acc, row) => acc + row.volumeM3, 0) * 10,
    ) / 10;
    const loadedM3 = Math.round(
      orders.filter((row) => row.pondId === pond.id).reduce((acc, row) => acc + row.loadedVolumeM3, 0) * 10,
    ) / 10;
    return reconcilePond(pond.id, dispatchM3, loadedM3);
  });
}

/* ------------------------------ 出卤前核检 ------------------------------ */

/** 推进出卤前的核检结果：按发运单与槽车运力核一遍，密度到了但罐区不够就按池排队 */
export interface ShippingCheck {
  /** 匹配到的有效发运单（外送归属优先，否则自动匹配同池有效单） */
  order: ShippingOrder | null;
  /** 槽车总运力（m³）= 槽车数量 × 单车运力 */
  tankCarCapacityM3: number;
  /** 发运单剩余可装量（m³）= 发运量 − 已装车量 */
  orderRemainingM3: number;
  /** 罐区额定容量（m³） */
  farmCapacityM3: number;
  /** 罐区已接收量（m³）：去向罐区相同的有效发运单已装车量合计 */
  farmLoadedM3: number;
  /** 罐区剩余容量（m³） */
  farmRemainingM3: number;
  /** 本次外送量是否可发（发运单有效 + 槽车运力够 + 发运量剩余够 + 罐区容量够） */
  canDeliver: boolean;
  /** 罐区容量是否不足（密度到了但罐区不够 → 按池排队） */
  farmShortfall: boolean;
  /** 还差多少方（m³） */
  shortfallM3: number;
  /** 不可发原因列表（逐条摆出） */
  reasons: string[];
}

/**
 * 出卤前核检：先按发运单和槽车运力核一遍。
 * 发运单作废 / 改派会导致匹配不到有效单；槽车运力、发运量剩余、罐区容量任一不足都不能出卤；
 * 其中罐区容量不足时按池排队并写明还差多少方，池里水位和目标密度这轮不动。
 */
export function checkShipping(
  schedule: Pick<Schedule, 'pondId' | 'volumeM3' | 'shippingOrderId'>,
  orders: ShippingOrder[],
): ShippingCheck {
  const reasons: string[] = [];
  const active = orders.filter((order) => order.status === '有效');

  let order: ShippingOrder | null = null;
  if (schedule.shippingOrderId !== '') {
    order = active.find((item) => item.id === schedule.shippingOrderId) ?? null;
    if (order === null) reasons.push('外送归属发运单已作废或改派，请重新选择发运单');
  }
  if (order === null) {
    order = active.find((item) => item.pondId === schedule.pondId) ?? null;
    if (order === null) reasons.push('本池暂无有效发运单，无法外送');
  }

  if (order === null) {
    return {
      order: null,
      tankCarCapacityM3: 0,
      orderRemainingM3: 0,
      farmCapacityM3: 0,
      farmLoadedM3: 0,
      farmRemainingM3: 0,
      canDeliver: false,
      farmShortfall: false,
      shortfallM3: 0,
      reasons,
    };
  }

  const tankCarCapacityM3 = tankCarTotalCapacity(order);
  const orderRemaining = orderRemainingM3(order);
  const farmCapacityM3 = tankFarmCapacityM3(order.tankFarm);
  const farmLoadedM3 = Math.round(
    active
      .filter((item) => item.tankFarm === order!.tankFarm)
      .reduce((acc, item) => acc + item.loadedVolumeM3, 0) * 10,
  ) / 10;
  const farmRemainingM3 = Math.round((farmCapacityM3 - farmLoadedM3) * 10) / 10;

  let farmShortfall = false;
  let shortfallM3 = 0;
  if (tankCarCapacityM3 < schedule.volumeM3) {
    reasons.push(`槽车运力不足：${tankCarCapacityM3} m³ < 本次 ${schedule.volumeM3} m³`);
  }
  if (orderRemaining < schedule.volumeM3) {
    reasons.push(`发运单剩余发运量不足：${orderRemaining} m³ < 本次 ${schedule.volumeM3} m³`);
  }
  if (farmRemainingM3 < schedule.volumeM3) {
    farmShortfall = true;
    shortfallM3 = Math.round((schedule.volumeM3 - farmRemainingM3) * 10) / 10;
    reasons.push(`${order.tankFarm}容量不足：剩余 ${farmRemainingM3} m³，还差 ${shortfallM3} m³`);
  }

  const canDeliver =
    tankCarCapacityM3 >= schedule.volumeM3 && orderRemaining >= schedule.volumeM3 && farmRemainingM3 >= schedule.volumeM3;

  return {
    order,
    tankCarCapacityM3,
    orderRemainingM3: orderRemaining,
    farmCapacityM3,
    farmLoadedM3,
    farmRemainingM3,
    canDeliver,
    farmShortfall,
    shortfallM3,
    reasons,
  };
}
