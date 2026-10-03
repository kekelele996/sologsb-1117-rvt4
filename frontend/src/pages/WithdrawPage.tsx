import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { AcceptanceResult, BeeColony, DropPoint, Orchard, TransitRoute } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { routeStore } from '@/stores/routeStore'
import { withdrawPlanStore } from '@/stores/withdrawPlanStore'
import {
  DISPATCHABLE_STATUSES,
  assignColony,
  promoteWaitingHead,
  removeFromWaiting,
  unassignColony,
  withdrawOrchard
} from '@/services/placement'

const ACCEPTANCE_COLORS: Record<AcceptanceResult, string> = {
  待验收: 'default',
  达标: 'green',
  不达标: 'red'
}

/**
 * 撤场安排（技术员）：
 * - 往投放点排蜂群，箱数不超容量，装不下进 FIFO 排队队列；
 * - 验收不达标的群已由托管队操作退回「待投放」补投；
 * - 仅达标地块允许撤场并纳入撤场计划；托管队改花期/容量后安排自动失效，一键重算。
 */
export default function WithdrawPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const planGenerated = usePersistentStore(withdrawPlanStore, (state) => state.generated)
  const planStale = usePersistentStore(withdrawPlanStore, (state) => state.stale)
  const planGeneratedAt = usePersistentStore(withdrawPlanStore, (state) => state.generatedAt)

  const [picked, setPicked] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    void withdrawPlanStore.getState().refresh()
  }, [orchards, dropPoints, routes])

  const availableColonies = useMemo(
    () => colonies.filter((item) => DISPATCHABLE_STATUSES.includes(item.status)),
    [colonies]
  )

  const colonyByCode = useMemo(() => new Map(colonies.map((item) => [item.code, item])), [colonies])

  function orchardName(id: string): string {
    return orchards.find((item) => item.id === id)?.name ?? '未知地块'
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      colonyStore.getState().hydrate(),
      droppointStore.getState().hydrate(),
      routeStore.getState().hydrate(),
      withdrawPlanStore.getState().refresh()
    ])
  }

  async function handleAssign(point: DropPoint): Promise<void> {
    const colonyId = picked[point.id]
    if (!colonyId) {
      message.warning('请先选择一群待投放/回场蜂')
      return
    }
    try {
      const result = await assignColony(colonyId, point.id)
      const code = colonies.find((item) => item.id === colonyId)?.code ?? ''
      message[result.placed ? 'success' : 'warning'](
        result.placed ? `${code} 已排入投放点 ${point.code}` : `${point.code} 容量已满，${code} 已进入排队队列`
      )
      setPicked((prev) => ({ ...prev, [point.id]: undefined }))
      await refreshAll()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '投放失败')
    }
  }

  async function handleUnassign(code: string): Promise<void> {
    const colony = colonies.find((item) => item.code === code)
    if (!colony) return
    await unassignColony(colony.id)
    message.success(`${code} 已移出投放点，空位由排队队首自动补位`)
    await refreshAll()
  }

  async function handleRemoveWaiting(code: string): Promise<void> {
    const colony = colonies.find((item) => item.code === code)
    if (!colony) return
    await removeFromWaiting(colony.id)
    message.success(`${code} 已移出排队队列，回到待投放`)
    await refreshAll()
  }

  async function handlePromote(point: DropPoint): Promise<void> {
    try {
      const code = await promoteWaitingHead(point.id)
      if (code) message.success(`${code} 已补位进入投放点 ${point.code}`)
      await refreshAll()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '补位失败')
    }
  }

  async function handleWithdraw(orchard: Orchard): Promise<void> {
    try {
      const { withdrawn, returned } = await withdrawOrchard(orchard.id, orchard.acceptance)
      message.success(
        `「${orchard.name}」已撤场：${withdrawn.length} 群回场` +
          (returned.length > 0 ? `，排队中 ${returned.length} 群退回待投放` : '')
      )
      await refreshAll()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤场失败')
    }
  }

  async function handleRebuild(): Promise<void> {
    const summary = await routeStore.getState().rebuildWithdrawPlan()
    await withdrawPlanStore.getState().refresh()
    if (summary.included === 0) {
      message.warning('暂无「达标」且有在点蜂群的投放点可撤场；未达标/待验收地块需等验收与补投')
      return
    }
    message.success(
      `撤场安排已重算：纳入 ${summary.included} 个投放点、${summary.legs} 段转场` +
        (summary.skipped > 0 ? `，跳过未达标的 ${summary.skipped} 个投放点` : '')
    )
  }

  const totalWaiting = dropPoints.reduce((sum, item) => sum + item.waitingColonyCodes.length, 0)
  const pendingCount = colonies.filter((item) => item.status === '待投放').length

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">撤场安排 · 技术员</h2>
          <p className="page-sub">
            技术员负责蜂群排布与撤场：往投放点排蜂不超容量、装不下排队；只有托管队验收「达标」的地块才能撤场。
            托管队改动花期或容量后，本页撤场安排自动失效，需要重算。
          </p>
        </div>
        <Space>
          <Tag>待投放 {pendingCount} 群</Tag>
          <Tag color="orange">排队 {totalWaiting} 群</Tag>
          <Button type="primary" onClick={() => void handleRebuild()}>
            重算撤场安排
          </Button>
        </Space>
      </div>

      {planStale ? (
        <Alert
          type="error"
          showIcon
          message="撤场安排已失效：托管队改动了花期或容量（或增删了地块 / 投放点）"
          description="原有转场路线仅作参考，请勿据此撤场；点击右上角「重算撤场安排」按最新验收与撤场时间生成。"
          style={{ marginBottom: 16 }}
        />
      ) : planGenerated ? (
        <Alert
          type="success"
          showIcon
          message={`撤场安排有效（生成于 ${dayjs(planGeneratedAt).format('YYYY-MM-DD HH:mm')}）`}
          description="仅纳入验收达标且有在点蜂群的投放点；待验收 / 不达标的地块不参与撤场。"
          style={{ marginBottom: 16 }}
        />
      ) : (
        <Alert
          type="info"
          showIcon
          message="尚未生成撤场安排"
          description="排好蜂群、托管队出具达标验收后，点击「重算撤场安排」生成转场路线。"
          style={{ marginBottom: 16 }}
        />
      )}

      {orchards.map((orchard) => {
        const points = dropPoints.filter((item) => item.orchardId === orchard.id)
        const orchardWaiting = points.reduce((sum, item) => sum + item.waitingColonyCodes.length, 0)
        return (
          <Card
            key={orchard.id}
            size="small"
            style={{ marginBottom: 16 }}
            title={
              <Space wrap>
                <span>{orchard.name}</span>
                <Tag color="blue">{orchard.crop}</Tag>
                <span>花期 {orchard.bloomStart} ~ {orchard.bloomEnd}</span>
                <Tag color={ACCEPTANCE_COLORS[orchard.acceptance]}>验收·{orchard.acceptance}</Tag>
                {orchardWaiting > 0 ? <Tag color="orange">{orchardWaiting} 群排队中</Tag> : null}
              </Space>
            }
            extra={
              <Button
                size="small"
                disabled={orchard.acceptance !== '达标'}
                danger={orchard.acceptance === '达标'}
                onClick={() => void handleWithdraw(orchard)}
              >
                {orchard.acceptance === '达标' ? '撤场（全部回场）' : `未达标，不可撤场`}
              </Button>
            }
          >
            {orchard.acceptance === '不达标' ? (
              <Alert
                type="error"
                showIcon
                message="验收不达标：在点蜂群已退回「待投放」，请安排补投后由托管队重新验收"
                style={{ marginBottom: 10 }}
              />
            ) : null}
            {orchard.acceptance === '待验收' ? (
              <Alert
                type="warning"
                showIcon
                message="托管队尚未出具验收结论：花期结束前不要撤场，撤早了补投来不及"
                style={{ marginBottom: 10 }}
              />
            ) : null}
            {points.length === 0 ? (
              <Empty description="该地块暂无投放点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Row gutter={[12, 12]}>
                {points.map((point) => {
                  const full = point.colonyCodes.length >= point.capacityBoxes
                  return (
                    <Col key={point.id} xs={24} lg={12}>
                      <Card size="small" type="inner" title={
                        <Space wrap>
                          <Tag color="blue">{point.code}</Tag>
                          <span style={{ fontSize: 12 }}>
                            容量 {point.colonyCodes.length}/{point.capacityBoxes} · 撤场 {point.withdrawTime}
                          </span>
                          {full ? <Tag color="orange">已满</Tag> : <Tag color="green">可投 {point.capacityBoxes - point.colonyCodes.length}</Tag>}
                        </Space>
                      }>
                        <Space.Compact block style={{ marginBottom: 8 }}>
                          <Select
                            style={{ flex: 1 }}
                            placeholder="选择待投放/回场蜂群排入"
                            value={picked[point.id]}
                            onChange={(value) => setPicked((prev) => ({ ...prev, [point.id]: value }))}
                            options={availableColonies.map((item: BeeColony) => ({
                              value: item.id,
                              label: `${item.code}（${item.species} ${item.strengthFrames}足框 · ${item.status}）`
                            }))}
                          />
                          <Button onClick={() => void handleAssign(point)}>排入</Button>
                        </Space.Compact>
                        <Row gutter={12}>
                          <Col span={12}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              在点蜂群（{point.colonyCodes.length}/{point.capacityBoxes}）
                            </Typography.Text>
                            <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
                              {point.colonyCodes.length === 0 ? <Typography.Text type="secondary">空</Typography.Text> : null}
                              {point.colonyCodes.map((code) => (
                                <Space key={code}>
                                  <Tag color="green">{code}</Tag>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {colonyByCode.get(code)?.species} · {colonyByCode.get(code)?.strengthFrames} 足框
                                  </Typography.Text>
                                  <Button size="small" type="link" danger onClick={() => void handleUnassign(code)}>
                                    移出
                                  </Button>
                                </Space>
                              ))}
                            </Space>
                          </Col>
                          <Col span={12}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              排队队列 FIFO（{point.waitingColonyCodes.length} 群）
                            </Typography.Text>
                            <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
                              {point.waitingColonyCodes.length === 0 ? <Typography.Text type="secondary">无排队</Typography.Text> : null}
                              {point.waitingColonyCodes.map((code, index) => (
                                <Space key={code}>
                                  <Tag color={index === 0 ? 'orange' : 'default'}>
                                    {index === 0 ? '队首' : `#${index + 1}`} {code}
                                  </Tag>
                                  <Button size="small" type="link" onClick={() => void handleRemoveWaiting(code)}>
                                    移出
                                  </Button>
                                </Space>
                              ))}
                              {point.waitingColonyCodes.length > 0 && point.colonyCodes.length < point.capacityBoxes ? (
                                <Button size="small" onClick={() => void handlePromote(point)}>
                                  队首补位
                                </Button>
                              ) : null}
                            </Space>
                          </Col>
                        </Row>
                      </Card>
                    </Col>
                  )
                })}
              </Row>
            )}
          </Card>
        )
      })}

      <Card
        size="small"
        title={`撤场转场路线（${routes.length} 段 · 合计 ${Math.round(routes.reduce((sum, item) => sum + item.distanceKm, 0) * 100) / 100} km）${planStale ? ' · 已失效待重算' : ''}`}
      >
        <Table<TransitRoute>
          dataSource={routes}
          rowKey="id"
          pagination={false}
          rowClassName={() => (planStale ? 'conflict-row' : '')}
          locale={{ emptyText: '尚未生成撤场转场路线' }}
          columns={[
            {
              title: '撤场顺序',
              key: 'seq',
              width: 90,
              render: (_, __, index) => <Tag color="gold">第 {index + 1} 站</Tag>
            },
            {
              title: '出发投放点',
              key: 'from',
              render: (_, record) => {
                const point = dropPoints.find((item) => item.id === record.fromDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
              }
            },
            {
              title: '到达投放点',
              key: 'to',
              render: (_, record) => {
                const point = dropPoints.find((item) => item.id === record.toDropId)
                return point ? `${point.code}（${orchardName(point.orchardId)}）` : '—'
              }
            },
            { title: '里程(km)', dataIndex: 'distanceKm', key: 'km', width: 100 },
            { title: '预计耗时(h)', dataIndex: 'durationH', key: 'hour', width: 110 },
            { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
            { title: '出发时刻', dataIndex: 'departAt', key: 'depart', width: 150 },
            { title: '执行记录', dataIndex: 'actualNote', key: 'actual', width: 100 }
          ]}
        />
      </Card>
    </div>
  )
}
