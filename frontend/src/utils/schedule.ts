import type { DropPoint, Orchard, WithdrawalPlan } from '@/types'

/** 某地块投放点容量摘要（编号:容量，按编号排序后拼接） */
export function capacityDigest(points: Pick<DropPoint, 'code' | 'capacityBoxes'>[]): string {
  return points
    .map((item) => `${item.code}:${item.capacityBoxes}`)
    .sort()
    .join('|')
}

/** 撤场安排是否因托管队改动花期或容量而失效 */
export function isPlanStale(
  plan: Pick<WithdrawalPlan, 'basisBloomStart' | 'basisBloomEnd' | 'basisCapacityDigest'>,
  orchard: Pick<Orchard, 'bloomStart' | 'bloomEnd'>,
  points: Pick<DropPoint, 'code' | 'capacityBoxes'>[]
): boolean {
  return (
    plan.basisBloomStart !== orchard.bloomStart ||
    plan.basisBloomEnd !== orchard.bloomEnd ||
    plan.basisCapacityDigest !== capacityDigest(points)
  )
}

/** 默认建议撤场时刻：盛花期结束次日 07:00 */
export function suggestWithdrawAt(orchard: Pick<Orchard, 'bloomEnd'>): string {
  const [year, month, day] = orchard.bloomEnd.split('-').map(Number)
  if (!year || !month || !day) return ''
  const d = new Date(Date.UTC(year, month - 1, day) + 86400000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T07:00`
}
