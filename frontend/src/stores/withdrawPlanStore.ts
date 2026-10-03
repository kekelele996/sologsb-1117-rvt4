import { create } from 'zustand'
import {
  currentWithdrawSignature,
  savedWithdrawSignature,
  withdrawPlanGeneratedAt
} from '@/services/withdrawPlan'

export interface WithdrawPlanState {
  /** 是否已生成过撤场安排 */
  generated: boolean
  /** 已生成安排是否因花期/容量改动而失效 */
  stale: boolean
  /** 安排生成时刻（ISO） */
  generatedAt: string
  loaded: boolean
  refresh: () => Promise<void>
}

/** 撤场安排有效性状态：由输入指纹与保存指纹比对得出 */
export const withdrawPlanStore = create<WithdrawPlanState>((set) => ({
  generated: false,
  stale: false,
  generatedAt: '',
  loaded: false,
  refresh: async () => {
    const [saved, current, generatedAt] = await Promise.all([
      savedWithdrawSignature(),
      currentWithdrawSignature(),
      withdrawPlanGeneratedAt()
    ])
    set({
      generated: Boolean(saved),
      stale: Boolean(saved) && saved !== current,
      generatedAt,
      loaded: true
    })
  }
}))
