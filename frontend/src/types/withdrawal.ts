import type { VehicleType } from './route'

/** 撤场安排状态 */
export const WITHDRAWAL_STATUSES = ['待执行', '已撤场'] as const
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number]

/** WithdrawalPlan 撤场安排（技术员按地块编排，每个地块一份） */
export interface WithdrawalPlan {
  id: string
  orchardId: string
  /** 计划撤场时刻（YYYY-MM-DDTHH:mm） */
  withdrawAt: string
  vehicleType: VehicleType
  /** 撤场备注（车辆班次、交接要求等） */
  note: string
  status: WithdrawalStatus
  /** 以下 basis* 为生成时的依据快照：托管队改动花期或容量后与现状不符即判定失效 */
  basisBloomStart: string
  basisBloomEnd: string
  /** 各地块投放点「编号:容量」摘要，投放点增删或改容量都会使其变化 */
  basisCapacityDigest: string
  /** 实际撤场完成时间（ISO） */
  executedAt: string
}
