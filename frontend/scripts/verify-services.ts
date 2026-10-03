// 核心业务逻辑验证：排蜂/排队/补位/验收退回/撤场门槛/指纹失效/撤场重算
// 运行：node --import tsx --import ./scripts/alias-register.mjs scripts/verify-services.ts
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db } from '../src/hooks/usePersistentStore'
import type { BeeColony, DropPoint, Orchard } from '../src/types'
import {
  computeWithdrawSignature,
  currentWithdrawSignature,
  isWithdrawPlanStale,
  stampWithdrawPlan
} from '../src/services/withdrawPlan'
import {
  assignColony,
  promoteWaitingHead,
  unassignColony,
  withdrawOrchard
} from '../src/services/placement'
import { orchardStore } from '../src/stores/orchardStore'
import { droppointStore } from '../src/stores/droppointStore'
import { routeStore } from '../src/stores/routeStore'
import { colonyStore } from '../src/stores/colonyStore'

let passed = 0
function check(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

const orchardA: Orchard = {
  id: 'o1', name: '甲园', crop: '苹果', areaMu: 10, longitude: 100, latitude: 30,
  bloomStart: '2026-04-01', bloomEnd: '2026-04-10', colonyIntensity: 0.1,
  ownerContact: '', accessibility: '大车可达', historyYears: [], note: '',
  acceptance: '待验收', fruitSetNote: ''
}
const orchardB: Orchard = {
  id: 'o2', name: '乙园', crop: '梨', areaMu: 20, longitude: 100.1, latitude: 30.1,
  bloomStart: '2026-04-05', bloomEnd: '2026-04-15', colonyIntensity: 0.1,
  ownerContact: '', accessibility: '大车可达', historyYears: [], note: '',
  acceptance: '待验收', fruitSetNote: ''
}
function colony(id: string, code: string, status: BeeColony['status'] = '待投放'): BeeColony {
  return {
    id, code, species: '意蜂', strengthFrames: 6, boxType: '标准继箱',
    currentOrchardId: '', status, lastCheckDate: '2026-03-30', healthNote: ''
  }
}
function dropPoint(id: string, orchardId: string, capacityBoxes: number, withdrawTime: string): DropPoint {
  return {
    id, orchardId, longitude: 100, latitude: 30, code: id.toUpperCase(),
    capacityBoxes, shade: '', waterDistance: 100, dropWindow: '2026-03-31',
    withdrawTime, owner: '', colonyCodes: [], waitingColonyCodes: []
  }
}

async function reset(): Promise<void> {
  await db.delete()
  await db.open()
  await db.orchards.bulkPut([orchardA, orchardB])
  await db.colonies.bulkPut([colony('c1', 'Q-1'), colony('c2', 'Q-2'), colony('c3', 'Q-3')])
  await db.dropPoints.bulkPut([dropPoint('d1', 'o1', 2, '2026-04-11'), dropPoint('d2', 'o2', 2, '2026-04-16')])
  await Promise.all([
    orchardStore.getState().hydrate(),
    colonyStore.getState().hydrate(),
    droppointStore.getState().hydrate(),
    routeStore.getState().hydrate()
  ])
}

async function main(): Promise<void> {
  console.log('1) 排蜂：容量内入点，超容量排队')
  await reset()
  let r = await assignColony('c1', 'd1')
  check('第一群入点', r.placed === true)
  await assignColony('c2', 'd1')
  r = await assignColony('c3', 'd1')
  check('第三群装不下 → 排队', r.placed === false)
  let d1 = await db.dropPoints.get('d1')
  check('在点 2 群', d1!.colonyCodes.join() === 'Q-1,Q-2')
  check('排队 1 群', d1!.waitingColonyCodes.join() === 'Q-3')
  check('排队群状态=排队中', (await db.colonies.get('c3'))!.status === '排队中')
  check('在点群状态=在园', (await db.colonies.get('c1'))!.status === '在园')

  console.log('2) 移出在点群 → 队首自动补位')
  await unassignColony('c1')
  d1 = await db.dropPoints.get('d1')
  check('Q-3 自动补位入点', d1!.colonyCodes.includes('Q-3'))
  check('排队清空', d1!.waitingColonyCodes.length === 0)
  check('Q-3 状态=在园', (await db.colonies.get('c3'))!.status === '在园')
  check('移出群回到待投放', (await db.colonies.get('c1'))!.status === '待投放')
  const promoted = await promoteWaitingHead('d1')
  check('无排队时补位返回 null', promoted === null)

  console.log('3) 验收不达标 → 全部退回待投放')
  await orchardStore.getState().save({ ...orchardA, acceptance: '不达标' })
  d1 = await db.dropPoints.get('d1')
  check('不达标地块在点清空', d1!.colonyCodes.length === 0 && d1!.waitingColonyCodes.length === 0)
  check('Q-2 退回待投放', (await db.colonies.get('c2'))!.status === '待投放')
  check('Q-3 退回待投放', (await db.colonies.get('c3'))!.status === '待投放')

  console.log('4) 待验收 / 不达标禁止撤场；达标可撤')
  await assert.rejects(() => withdrawOrchard('o1', '待验收'), /尚未验收/)
  await orchardStore.getState().save({ ...orchardA, acceptance: '不达标' })
  await assert.rejects(() => withdrawOrchard('o1', '不达标'), /不能撤场/)
  // 重新安排一群用于达标撤场
  await assignColony('c1', 'd1')
  await orchardStore.getState().save({ ...orchardA, acceptance: '达标' })
  const wd = await withdrawOrchard('o1', '达标')
  check('达标撤场，群回场', wd.withdrawn.join() === 'Q-1' && (await db.colonies.get('c1'))!.status === '回场')

  console.log('5) 指纹：改花期/容量 → 撤场安排失效')
  await stampWithdrawPlan('2026-04-10T00:00:00.000Z')
  check('盖章后未改动 → 有效', (await isWithdrawPlanStale()) === false)
  const orchardADa = { ...orchardA, acceptance: '达标' as const }
  await orchardStore.getState().save({ ...orchardADa, bloomStart: '2026-04-02' })
  check('改花期 → 失效', (await isWithdrawPlanStale()) === true)
  // 恢复花期再测容量（保持达标，避免触发验收退回）
  await orchardStore.getState().save({ ...orchardADa, bloomStart: '2026-04-01' })
  await stampWithdrawPlan()
  await droppointStore.getState().save({ ...(await db.dropPoints.get('d2'))!, capacityBoxes: 5 })
  check('改容量 → 失效', (await isWithdrawPlanStale()) === true)
  await stampWithdrawPlan()
  check('重算盖章 → 恢复有效', (await isWithdrawPlanStale()) === false)

  console.log('6) 容量再平衡：调小降级、调大补位')
  await reset()
  // 先放宽容量，让 3 群都在点；再逐步调小验证降级
  await droppointStore.getState().save({ ...(await db.dropPoints.get('d2'))!, capacityBoxes: 5 })
  await assignColony('c1', 'd2')
  await assignColony('c2', 'd2')
  await assignColony('c3', 'd2')
  let d2 = await db.dropPoints.get('d2')
  check('d2 在点 3 群', d2!.colonyCodes.length === 3)
  await droppointStore.getState().save({ ...d2!, capacityBoxes: 1 })
  d2 = await db.dropPoints.get('d2')
  check('容量调小到 1：在点 1 群', d2!.colonyCodes.length === 1)
  check('容量调小：排队 2 群', d2!.waitingColonyCodes.length === 2)
  check('降级群状态=排队中', (await db.colonies.get('c3'))!.status === '排队中')
  await droppointStore.getState().save({ ...d2!, capacityBoxes: 3 })
  d2 = await db.dropPoints.get('d2')
  check('容量调大到 3：排队全部补位', d2!.colonyCodes.length === 3 && d2!.waitingColonyCodes.length === 0)
  check('补位群状态=在园', (await db.colonies.get('c3'))!.status === '在园')

  console.log('7) 撤场安排重算：只纳入达标且有在点蜂群的点，按撤场时间排序')
  await reset()
  await assignColony('c1', 'd1') // 甲园待验收
  await assignColony('c2', 'd2') // 乙园
  // 甲园达标、乙园待验收
  await orchardStore.getState().save({ ...orchardA, acceptance: '达标' })
  const summary = await routeStore.getState().rebuildWithdrawPlan()
  check('只纳入 1 个达标有点的投放点', summary.included === 1)
  check('跳过 1 个待验收投放点', summary.skipped === 1)
  check('单点无转场段', summary.legs === 0 && (await db.routes.count()) === 0)
  // 乙园也达标，两点各 1 群 → 1 段，按撤场时间 d1(04-11) → d2(04-16)
  await orchardStore.getState().save({ ...orchardB, acceptance: '达标' })
  const summary2 = await routeStore.getState().rebuildWithdrawPlan()
  check('两点 1 段', summary2.legs === 1)
  const leg = (await db.routes.toArray())[0]
  check('顺序按撤场时间 d1→d2', leg.fromDropId === 'd1' && leg.toDropId === 'd2')
  check('重算后安排有效', (await isWithdrawPlanStale()) === false)
  // 改容量后又失效
  await droppointStore.getState().save({ ...(await db.dropPoints.get('d1'))!, capacityBoxes: 4 })
  check('改容量后重算结果失效', (await isWithdrawPlanStale()) === true)

  console.log('8) 指纹稳定性：与数据传入方式无关')
  const fromTables = await currentWithdrawSignature()
  const fromArgs = await computeWithdrawSignature(await db.orchards.toArray(), await db.dropPoints.toArray())
  check('整表读取与传参结果一致', fromTables === fromArgs)

  console.log(`\n全部通过：${passed} 项断言`)
  await db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
