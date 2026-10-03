/** DropPoint 投放点（地块、容量等由托管队维护；群号安排归技术员，见 Deployment） */
export interface DropPoint {
  id: string
  orchardId: string
  longitude: number
  latitude: number
  /** 编号，如 A-03 */
  code: string
  /** 可容纳箱数 */
  capacityBoxes: number
  /** 遮阴条件 */
  shade: string
  /** 水源距离（米） */
  waterDistance: number
  /** 投放时间窗（起） */
  dropWindow: string
  /** 撤场时间 */
  withdrawTime: string
  /** 责任人 */
  owner: string
}
