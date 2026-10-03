import { db } from '@/hooks/usePersistentStore'
import type { BeeColony, DropPoint } from '@/types'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'

/** 可被排向投放点的蜂群状态（补投群退回「待投放」后可再次投放） */
export const DISPATCHABLE_STATUSES: BeeColony['status'][] = ['待投放', '回场']

export interface PlaceResult {
  /** 实际进入在点队列，还是因容量不足进入排队队列 */
  placed: boolean
  point: DropPoint
}

/** 找出某群当前所在 / 排队的投放点（同一群不会同时出现在两个点） */
export function locateColony(
  code: string,
  points: DropPoint[]
): { point: DropPoint; waiting: boolean } | null {
  for (const point of points) {
    if (point.colonyCodes.includes(code)) return { point, waiting: false }
    if (point.waitingColonyCodes.includes(code)) return { point, waiting: true }
  }
  return null
}

/** 由全部投放点排布反查一群当前所在的地块 id（排队群也计入其意向地块） */
export function orchardOfColony(code: string, points: DropPoint[]): string {
  return locateColony(code, points)?.point.orchardId ?? ''
}

async function rehydrate(): Promise<void> {
  await Promise.all([
    colonyStore.getState().hydrate(),
    droppointStore.getState().hydrate(),
    routeStore.getState().hydrate()
  ])
}

/**
 * 技术员往投放点排一群蜂：
 * - 投放点在点箱数未超容量 → 进在点队列，蜂群置「在园」；
 * - 已满 → 进 FIFO 排队队列，蜂群置「排队中」，装不下就排队。
 */
export async function assignColony(colonyId: string, dropId: string): Promise<PlaceResult> {
  const colony = await db.colonies.get(colonyId)
  const point = await db.dropPoints.get(dropId)
  if (!colony || !point) throw new Error('蜂群或投放点不存在')
  if (!DISPATCHABLE_STATUSES.includes(colony.status)) {
    throw new Error(`蜂群 ${colony.code} 当前为「${colony.status}」，不能投放`)
  }

  const allPoints = await db.dropPoints.toArray()
  if (locateColony(colony.code, allPoints)) {
    throw new Error(`蜂群 ${colony.code} 已在其他投放点，请先撤出或移出`)
  }

  const hasRoom = point.colonyCodes.length < point.capacityBoxes
  const nextPoint: DropPoint = hasRoom
    ? { ...point, colonyCodes: [...point.colonyCodes, colony.code] }
    : { ...point, waitingColonyCodes: [...point.waitingColonyCodes, colony.code] }
  const nextColony: BeeColony = {
    ...colony,
    status: hasRoom ? '在园' : '排队中',
    currentOrchardId: point.orchardId
  }

  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    await db.dropPoints.put(nextPoint)
    await db.colonies.put(nextColony)
  })
  await rehydrate()
  return { placed: hasRoom, point: nextPoint }
}

/** 把一群从在点队列移出（空位由队首自动补位） */
export async function unassignColony(colonyId: string): Promise<void> {
  const colony = await db.colonies.get(colonyId)
  if (!colony) return
  const points = await db.dropPoints.toArray()
  const located = locateColony(colony.code, points)
  if (!located) {
    await db.colonies.put({ ...colony, status: '待投放', currentOrchardId: '' })
    await rehydrate()
    return
  }
  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    await removeFromPointAndPromote(located.point.id, colony.code, 'placed')
    await db.colonies.put({ ...colony, status: '待投放', currentOrchardId: '' })
  })
  await rehydrate()
}

/** 把一群从排队队列移出（不影响在点队列） */
export async function removeFromWaiting(colonyId: string): Promise<void> {
  const colony = await db.colonies.get(colonyId)
  if (!colony) return
  const points = await db.dropPoints.toArray()
  const located = locateColony(colony.code, points)
  if (!located || !located.waiting) return
  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    const point = await db.dropPoints.get(located.point.id)
    if (!point) return
    await db.dropPoints.put({
      ...point,
      waitingColonyCodes: point.waitingColonyCodes.filter((code) => code !== colony.code)
    })
    await db.colonies.put({ ...colony, status: '待投放', currentOrchardId: '' })
  })
  await rehydrate()
}

/** 队首手动补位：容量有空位时把排队队首群升入在点队列 */
export async function promoteWaitingHead(dropId: string): Promise<string | null> {
  const point = await db.dropPoints.get(dropId)
  if (!point || point.waitingColonyCodes.length === 0) return null
  if (point.colonyCodes.length >= point.capacityBoxes) {
    throw new Error(`投放点 ${point.code} 容量已满，暂不能补位`)
  }
  const [headCode, ...rest] = point.waitingColonyCodes
  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    await db.dropPoints.put({
      ...point,
      colonyCodes: [...point.colonyCodes, headCode],
      waitingColonyCodes: rest
    })
    const head = (await db.colonies.toArray()).find((item) => item.code === headCode)
    if (head) {
      await db.colonies.put({ ...head, status: '在园', currentOrchardId: point.orchardId })
    }
  })
  await rehydrate()
  return headCode
}

/**
 * 托管队验收「不达标」：该地块所有在点群退回「待投放」用于补投，
 * 排队群同样退回待投放队列（由技术员重新安排补投去向）。
 * 不触发自动补位 —— 验收未过，该地块需补投后重新验收。
 */
export async function rejectOrchardPlacement(orchardId: string): Promise<string[]> {
  const points = (await db.dropPoints.toArray()).filter((item) => item.orchardId === orchardId)
  const returnedCodes: string[] = []
  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    for (const point of points) {
      returnedCodes.push(...point.colonyCodes, ...point.waitingColonyCodes)
      await db.dropPoints.put({ ...point, colonyCodes: [], waitingColonyCodes: [] })
    }
    const colonies = await db.colonies.toArray()
    for (const colony of colonies) {
      if (returnedCodes.includes(colony.code)) {
        await db.colonies.put({ ...colony, status: '待投放', currentOrchardId: '' })
      }
    }
  })
  await rehydrate()
  return returnedCodes
}

/**
 * 技术员撤场：撤收某地块全部投放点的蜂群。
 * 仅「达标」地块允许撤场（待验收 / 不达标一律拦住，避免撤早了来不及补投）。
 * 在点群置「回场」；排队群未实际进园，退回「待投放」。
 */
export async function withdrawOrchard(
  orchardId: string,
  acceptance: string
): Promise<{ returned: string[]; withdrawn: string[] }> {
  if (acceptance === '待验收') throw new Error('该地块尚未验收，不能撤场')
  if (acceptance === '不达标') throw new Error('该地块验收不达标，需补投后重新验收，不能撤场')

  const points = (await db.dropPoints.toArray()).filter((item) => item.orchardId === orchardId)
  const placedCodes: string[] = []
  const waitingCodes: string[] = []
  points.forEach((point) => {
    placedCodes.push(...point.colonyCodes)
    waitingCodes.push(...point.waitingColonyCodes)
  })

  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    for (const point of points) {
      await db.dropPoints.put({ ...point, colonyCodes: [], waitingColonyCodes: [] })
    }
    const colonies = await db.colonies.toArray()
    for (const colony of colonies) {
      if (placedCodes.includes(colony.code)) {
        await db.colonies.put({ ...colony, status: '回场', currentOrchardId: '' })
      } else if (waitingCodes.includes(colony.code)) {
        await db.colonies.put({ ...colony, status: '待投放', currentOrchardId: '' })
      }
    }
  })
  await rehydrate()
  return { returned: waitingCodes, withdrawn: placedCodes }
}

/**
 * 托管队调整容量后的再平衡（保证「在点箱数不超容量」这一不变量）：
 * - 容量调小：超出部分从在点队尾退到排队队首，蜂群置「排队中」；
 * - 容量调大：排队队首依次自动补位，蜂群置「在园」。
 * 返回再平衡后的投放点与发生状态变化的群数。
 */
export async function reconcilePointForCapacity(point: DropPoint): Promise<{ point: DropPoint; changed: number }> {
  let placed = [...point.colonyCodes]
  let waiting = [...point.waitingColonyCodes]

  const demoted: string[] = []
  if (placed.length > point.capacityBoxes) {
    const overflow = placed.splice(point.capacityBoxes)
    demoted.push(...overflow)
    waiting = [...overflow, ...waiting]
  }
  const promoted: string[] = []
  while (placed.length < point.capacityBoxes && waiting.length > 0) {
    const head = waiting.shift()
    if (head === undefined) break
    placed.push(head)
    promoted.push(head)
  }
  const changed = demoted.length + promoted.length
  const balanced: DropPoint = { ...point, colonyCodes: placed, waitingColonyCodes: waiting }
  if (changed === 0) return { point: balanced, changed: 0 }

  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    await db.dropPoints.put(balanced)
    const colonies = await db.colonies.toArray()
    for (const colony of colonies) {
      if (demoted.includes(colony.code)) {
        await db.colonies.put({ ...colony, status: '排队中', currentOrchardId: point.orchardId })
      } else if (promoted.includes(colony.code)) {
        await db.colonies.put({ ...colony, status: '在园', currentOrchardId: point.orchardId })
      }
    }
  })
  return { point: balanced, changed }
}

/** 事务内：从某投放点移除一群；若腾出空位且有排队群，队首自动升入 */
async function removeFromPointAndPromote(
  dropId: string,
  code: string,
  from: 'placed' | 'waiting'
): Promise<void> {
  const point = await db.dropPoints.get(dropId)
  if (!point) return
  let colonyCodes = point.colonyCodes
  let waiting = point.waitingColonyCodes
  if (from === 'placed') {
    colonyCodes = colonyCodes.filter((item) => item !== code)
    if (colonyCodes.length < point.capacityBoxes && waiting.length > 0) {
      const [head, ...rest] = waiting
      colonyCodes = [...colonyCodes, head]
      waiting = rest
      const headColony = (await db.colonies.toArray()).find((item) => item.code === head)
      if (headColony) {
        await db.colonies.put({ ...headColony, status: '在园', currentOrchardId: point.orchardId })
      }
    }
  } else {
    waiting = waiting.filter((item) => item !== code)
  }
  await db.dropPoints.put({ ...point, colonyCodes, waitingColonyCodes: waiting })
}
