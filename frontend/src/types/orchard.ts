/** 作物类型 */
export const CROPS = ['苹果', '梨', '樱桃', '蓝莓', '油菜'] as const
export type Crop = (typeof CROPS)[number]

/** 道路可达性 */
export const ACCESSIBILITIES = ['大车可达', '仅小车', '需步行'] as const
export type Accessibility = (typeof ACCESSIBILITIES)[number]

/** 验收结论（托管队按坐果出具） */
export const ACCEPTANCE_RESULTS = ['待验收', '达标', '不达标'] as const
export type AcceptanceResult = (typeof ACCEPTANCE_RESULTS)[number]

/** Orchard 果园地块（托管队负责：地块信息、花期、验收结论） */
export interface Orchard {
  id: string
  /** 地块名 */
  name: string
  crop: Crop
  /** 面积（亩） */
  areaMu: number
  longitude: number
  latitude: number
  /** 盛花期起 */
  bloomStart: string
  /** 盛花期止 */
  bloomEnd: string
  /** 需蜂群强度（箱/亩） */
  colonyIntensity: number
  /** 园主联系方式 */
  ownerContact: string
  accessibility: Accessibility
  /** 历史授粉年份 */
  historyYears: number[]
  note: string
  /** 授粉季末验收结论（旧数据升级时补「待验收」） */
  acceptance: AcceptanceResult
  /** 坐果 / 验收备注 */
  fruitSetNote: string
}

/** 由面积与需蜂强度算出建议箱数（向上取整，最少 1 箱） */
export function suggestColonyBoxes(orchard: Pick<Orchard, 'areaMu' | 'colonyIntensity'>): number {
  const boxes = Math.ceil((orchard.areaMu || 0) * (orchard.colonyIntensity || 0))
  return boxes > 0 ? boxes : 1
}
