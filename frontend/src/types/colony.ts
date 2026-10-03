/** 蜂种 */
export const BEE_SPECIES = ['意蜂', '中蜂'] as const
export type BeeSpecies = (typeof BEE_SPECIES)[number]

/** 蜂群状态 */
export const COLONY_STATUSES = ['待投放', '排队中', '在园', '转场中', '回场'] as const
export type ColonyStatus = (typeof COLONY_STATUSES)[number]

/** 箱型 */
export const BOX_TYPES = ['标准继箱', '平箱', '交尾箱'] as const
export type BoxType = (typeof BOX_TYPES)[number]

/** BeeColony 蜂群（技术员负责：台账、投放点排布与撤场） */
export interface BeeColony {
  id: string
  /** 群号 */
  code: string
  species: BeeSpecies
  /** 群势（足框数） */
  strengthFrames: number
  boxType: BoxType
  /** 当前所在地块（排队中 / 待投放时为空，由投放点排布派生） */
  currentOrchardId: string
  status: ColonyStatus
  /** 最近检查日期 */
  lastCheckDate: string
  /** 蜂群健康备注 */
  healthNote: string
}
