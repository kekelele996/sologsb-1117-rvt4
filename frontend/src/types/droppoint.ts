/**
 * DropPoint 投放点
 *
 * 字段分属两个责任方：
 * - 托管队：orchardId、坐标、编号、容量 capacityBoxes、遮阴、水源、投放/撤场时间窗、责任人
 * - 技术员：colonyCodes（在点蜂群）、waitingColonyCodes（装不下时的排队队列）
 */
export interface DropPoint {
  id: string
  orchardId: string
  longitude: number
  latitude: number
  /** 编号，如 A-03 */
  code: string
  /** 可容纳箱数（托管队调整后，撤场安排失效需重算） */
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
  /** 该投放点已排入的群号（在点，不得超过容量） */
  colonyCodes: string[]
  /** 容量装满后的排队群号（FIFO，队首优先补位） */
  waitingColonyCodes: string[]
}
