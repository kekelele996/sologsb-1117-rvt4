import { db } from '@/hooks/usePersistentStore'
import type { DropPoint, Orchard } from '@/types'

/**
 * 撤场安排的「输入指纹」。
 *
 * 责任边界：托管队掌握花期与容量；技术员的撤场安排只对生成时刻的输入负责。
 * 只要托管队改动了地块花期（bloomStart/bloomEnd）或投放点容量（capacityBoxes），
 * 或增删了地块 / 投放点，指纹即变化，已保存的撤场安排（转场路线）判为失效，需要重算。
 */
export const WITHDRAW_SIG_KEY = 'withdrawInputSignature'
export const WITHDRAW_GENERATED_AT_KEY = 'withdrawPlanGeneratedAt'

/** FNV-1a 32 位哈希，得到稳定短指纹 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 依据当前地块花期与投放点容量计算输入指纹 */
export async function computeWithdrawSignature(
  orchards?: Orchard[],
  dropPoints?: DropPoint[]
): Promise<string> {
  const orc = orchards ?? (await db.orchards.toArray())
  const dps = dropPoints ?? (await db.dropPoints.toArray())
  const bloomPart = orc
    .map((item) => `${item.id}|${item.bloomStart}|${item.bloomEnd}`)
    .sort()
    .join(';')
  const capPart = dps
    .map((item) => `${item.id}|${item.capacityBoxes}`)
    .sort()
    .join(';')
  return fnv1a(`bloom:${bloomPart}#cap:${capPart}`)
}

/** 读取当前数据应有的指纹 */
export async function currentWithdrawSignature(): Promise<string> {
  return computeWithdrawSignature()
}

/** 读取已保存撤场安排所基于的指纹（从未生成过返回空串） */
export async function savedWithdrawSignature(): Promise<string> {
  const row = await db.meta.get(WITHDRAW_SIG_KEY)
  return typeof row?.value === 'string' ? row.value : ''
}

/** 撤场安排是否已失效：从未生成不算失效（无安排可失效）；生成后指纹不一致即失效 */
export async function isWithdrawPlanStale(): Promise<boolean> {
  const saved = await savedWithdrawSignature()
  if (!saved) return false
  return saved !== (await currentWithdrawSignature())
}

/** 记录撤场安排生成时的指纹与时刻（技术员重算后调用） */
export async function stampWithdrawPlan(generatedAt: string = new Date().toISOString()): Promise<void> {
  await db.meta.put({ key: WITHDRAW_SIG_KEY, value: await currentWithdrawSignature() })
  await db.meta.put({ key: WITHDRAW_GENERATED_AT_KEY, value: generatedAt })
}

/**
 * 托管队改动花期/容量（或增删地块、投放点）后令撤场安排失效。
 * 保留「已生成」标记（指纹故意置为与当前输入不一致），这样 UI 能区分
 * 「从未生成」与「生成后已失效待重算」两种状态。
 */
export async function invalidateWithdrawPlan(): Promise<void> {
  const exists = await savedWithdrawSignature()
  if (!exists) return
  await db.meta.put({ key: WITHDRAW_SIG_KEY, value: `stale:${Date.now().toString(36)}` })
}

/** 读取撤场安排生成时刻 */
export async function withdrawPlanGeneratedAt(): Promise<string> {
  const row = await db.meta.get(WITHDRAW_GENERATED_AT_KEY)
  return typeof row?.value === 'string' ? row.value : ''
}
