/** 投放状态：已运抵投放点为「已投放」，投放点箱位装满后等待补位为「排队中」 */
export const DEPLOYMENT_STATUSES = ['已投放', '排队中'] as const
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

/** Deployment 投放安排（技术员把蜂群排到投放点的记录，受投放点容量约束） */
export interface Deployment {
  id: string
  colonyId: string
  dropPointId: string
  /** 冗余归属地块，便于按地块筛选 */
  orchardId: string
  status: DeploymentStatus
  /** 入队序号（同一投放点 FIFO 排队与补位依据，越小越优先） */
  queuedAt: number
}
