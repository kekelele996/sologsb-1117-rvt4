import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Empty, Form, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { BeeColony, Deployment, DropPoint, Orchard, VehicleType, WithdrawalPlan } from '@/types'
import { VEHICLE_TYPES } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { deploymentStore } from '@/stores/deploymentStore'
import { withdrawalStore } from '@/stores/withdrawalStore'
import { isPlanStale, suggestWithdrawAt } from '@/utils/schedule'

/** 技术员侧：蜂群排到投放点（容量约束 + 排队）与撤场安排 */
export default function DeployPage(): JSX.Element {
  return (
    <Tabs
      defaultActiveKey="place"
      items={[
        { key: 'place', label: '投放与排队', children: <PlaceTab /> },
        { key: 'withdraw', label: '撤场安排', children: <WithdrawTab /> }
      ]}
    />
  )
}

/** 投放与排队：把待投放/回场的蜂群排进投放点，箱位满则 FIFO 排队，验收不达标的地块退回补投 */
function PlaceTab(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const deployments = usePersistentStore(deploymentStore, (state) => state.rows)

  const colonyById = useMemo(() => new Map(colonies.map((item) => [item.id, item])), [colonies])

  /** 可投放池：没有有效安排、且状态为待投放/回场的蜂群 */
  const pool = useMemo(
    () => colonies.filter((item) => (item.status === '待投放' || item.status === '回场') && !deployments.some((dep) => dep.colonyId === item.id)),
    [colonies, deployments]
  )

  const orderedOrchards = [...orchards].sort((a, b) => a.bloomStart.localeCompare(b.bloomStart))

  async function assign(colonyId: string, point: DropPoint): Promise<void> {
    try {
      await deploymentStore.getState().assignToPoint(colonyId, point.id)
      message.success(`已排到投放点 ${point.code}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '投放失败')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">蜂群投放与排队 · 技术员</h2>
          <p className="page-sub">
            把蜂群排进地块投放点：已投放箱数不超过容量即落箱，装不下自动进入排队；有空箱位时按排队顺序自动补位。验收不达标的地块，蜂群已退回此处等待补投。
          </p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        message="托管队只维护地块、容量与验收结论；排群、调队、撤群由本页操作。验收达标后方可在「撤场安排」页排撤场。"
      />

      <Row gutter={16}>
        <Col xs={24} xl={16}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {orderedOrchards.map((orchard) => {
              const points = dropPoints.filter((item) => item.orchardId === orchard.id)
              return (
                <Card
                  key={orchard.id}
                  size="small"
                  title={
                    <Space wrap>
                      <span>{orchard.name}</span>
                      <Tag>{orchard.bloomStart} ~ {orchard.bloomEnd}</Tag>
                      <AcceptanceTag orchard={orchard} />
                    </Space>
                  }
                >
                  {points.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="托管队尚未在该地块建立投放点" />
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }} size={10}>
                      {points.map((point) => {
                        const deps = deployments
                          .filter((dep) => dep.dropPointId === point.id)
                          .sort((a, b) => a.queuedAt - b.queuedAt)
                        const placed = deps.filter((dep) => dep.status === '已投放')
                        const queued = deps.filter((dep) => dep.status === '排队中')
                        const full = placed.length >= point.capacityBoxes
                        const queuedOrder = queued.map((item) => item.id)
                        return (
                          <div key={point.id} style={{ border: '1px solid #e6ecf1', borderRadius: 8, padding: 10 }}>
                            <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                              <Space wrap>
                                <Tag color="blue">{point.code}</Tag>
                                <Tag color={full ? 'gold' : 'green'}>
                                  已投放 {placed.length}/{point.capacityBoxes} 箱{full ? '（满，排队中）' : ''}
                                </Tag>
                                {queued.length > 0 ? <Tag color="orange">排队 {queued.length} 群</Tag> : null}
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  投放窗 {point.dropWindow} · 撤场参考 {point.withdrawTime}
                                </Typography.Text>
                              </Space>
                              <SelectColonyToPoint
                                pool={pool}
                                disabled={orchard.acceptance === '不达标'}
                                onPick={(colonyId) => void assign(colonyId, point)}
                              />
                            </Space>

                            {orchard.acceptance === '不达标' ? (
                              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                                该地块验收不达标，暂停投放，请按坐果缺口补投到达标地块或等待托管队重新验收。
                              </Typography.Text>
                            ) : null}

                            {deps.length > 0 ? (
                              <Table<Deployment>
                                style={{ marginTop: 8 }}
                                size="small"
                                pagination={false}
                                rowKey="id"
                                dataSource={deps}
                                columns={[
                                  { title: '顺序', dataIndex: 'queuedAt', key: 'seq', width: 60 },
                                  {
                                    title: '群号',
                                    key: 'code',
                                    render: (_, record) => {
                                      const colony = colonyById.get(record.colonyId)
                                      return colony ? `${colony.code}（${colony.species} ${colony.strengthFrames} 足框）` : '未知蜂群'
                                    }
                                  },
                                  {
                                    title: '状态',
                                    dataIndex: 'status',
                                    key: 'status',
                                    width: 90,
                                    render: (value: Deployment['status']) => (
                                      <Tag color={value === '已投放' ? 'green' : 'orange'}>{value}</Tag>
                                    )
                                  },
                                  {
                                    title: '操作',
                                    key: 'action',
                                    width: 200,
                                    render: (_, record) => (
                                      <Space size={4}>
                                        <Button
                                          size="small"
                                          disabled={record.status !== '排队中' || queuedOrder.indexOf(record.id) <= 0}
                                          onClick={() => void deploymentStore.getState().moveEarlier(record.id)}
                                        >
                                          前移
                                        </Button>
                                        <Button
                                          size="small"
                                          disabled={record.status !== '排队中'}
                                          onClick={() => void deploymentStore.getState().moveLater(record.id)}
                                        >
                                          后移
                                        </Button>
                                        <Popconfirm
                                          title="撤下该群？已投放撤下后排队排头会自动补位。"
                                          onConfirm={() => deploymentStore.getState().cancel(record.id)}
                                          okText="撤下"
                                          cancelText="取消"
                                        >
                                          <Button size="small" danger type="link">
                                            撤下
                                          </Button>
                                        </Popconfirm>
                                      </Space>
                                    )
                                  }
                                ]}
                              />
                            ) : (
                              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                                尚未排蜂
                              </Typography.Text>
                            )}
                          </div>
                        )
                      })}
                    </Space>
                  )}
                </Card>
              )
            })}
            {orderedOrchards.length === 0 ? <Empty description="暂无地块" /> : null}
          </Space>
        </Col>

        <Col xs={24} xl={8}>
          <Card size="small" title={`待投放蜂群池（${pool.length} 群）`}>
            {pool.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可投放的蜂群；回场或退回的群会出现在这里" />
            ) : (
              <Table<BeeColony>
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={pool}
                columns={[
                  { title: '群号', dataIndex: 'code', key: 'code', width: 80 },
                  {
                    title: '群势/箱型',
                    key: 'info',
                    render: (_, record) => `${record.strengthFrames} 框 · ${record.boxType}`
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    key: 'status',
                    width: 80,
                    render: (value: BeeColony['status']) => <Tag>{value}</Tag>
                  }
                ]}
              />
            )}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              说明：在「在园 / 转场中」的群不能重复投放；每群同一时间只有一条投放安排。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

/** 从待投放池选一群排到指定投放点 */
function SelectColonyToPoint({
  pool,
  disabled,
  onPick
}: {
  pool: BeeColony[]
  disabled: boolean
  onPick: (colonyId: string) => void
}): JSX.Element {
  const [value, setValue] = useState<string>()
  return (
    <Space>
      <SelectColony
        style={{ width: 220 }}
        disabled={disabled}
        value={value}
        onChange={setValue}
        options={pool.map((item) => ({ value: item.id, label: `${item.code}（${item.species} ${item.strengthFrames} 足框）` }))}
        placeholder="选择蜂群排入"
      />
      <Button
        size="small"
        type="primary"
        disabled={disabled || !value}
        onClick={() => {
          if (value) {
            onPick(value)
            setValue(undefined)
          }
        }}
      >
        排入
      </Button>
    </Space>
  )
}

// 抽出以便类型推断
function SelectColony(props: {
  style?: React.CSSProperties
  disabled?: boolean
  value?: string
  onChange?: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}): JSX.Element {
  return <Select allowClear showSearch optionFilterProp="label" {...props} />
}

function AcceptanceTag({ orchard }: { orchard: Orchard }): JSX.Element {
  const color = orchard.acceptance === '达标' ? 'green' : orchard.acceptance === '不达标' ? 'red' : 'gold'
  return <Tag color={color}>验收：{orchard.acceptance}</Tag>
}

/* ------------------------------------------------------------------ */
/* 撤场安排：按地块编排；托管队改花期/容量后自动失效，需重算              */
/* ------------------------------------------------------------------ */

function WithdrawTab(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const deployments = usePersistentStore(deploymentStore, (state) => state.rows)
  const plans = usePersistentStore(withdrawalStore, (state) => state.rows)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingPlan, setEditingPlan] = useState<WithdrawalPlan | null>(null)
  const [targetOrchard, setTargetOrchard] = useState<Orchard | null>(null)
  const [form] = Form.useForm<{ withdrawAt: dayjs.Dayjs; vehicleType: VehicleType; note: string }>()

  const colonyById = useMemo(() => new Map(colonies.map((item) => [item.id, item])), [colonies])
  const orderedOrchards = [...orchards].sort((a, b) => a.bloomStart.localeCompare(b.bloomStart))

  function pointsOf(orchardId: string) {
    return dropPoints.filter((item) => item.orchardId === orchardId)
  }

  function planOf(orchardId: string): WithdrawalPlan | undefined {
    return plans.find((item) => item.orchardId === orchardId)
  }

  function openCreate(orchard: Orchard): void {
    setTargetOrchard(orchard)
    setEditingPlan(null)
    const suggested = suggestWithdrawAt(orchard)
    form.setFieldsValue({
      withdrawAt: suggested ? dayjs(suggested) : dayjs(),
      vehicleType: '厢式货车',
      note: ''
    })
    setModalOpen(true)
  }

  function openEdit(plan: WithdrawalPlan, orchard: Orchard): void {
    setTargetOrchard(orchard)
    setEditingPlan(plan)
    form.setFieldsValue({
      withdrawAt: dayjs(plan.withdrawAt),
      vehicleType: plan.vehicleType,
      note: plan.note
    })
    setModalOpen(true)
  }

  async function submit(): Promise<void> {
    if (!targetOrchard) return
    const values = await form.validateFields()
    if (editingPlan) {
      await withdrawalStore.getState().save({ ...editingPlan, withdrawAt: values.withdrawAt.format('YYYY-MM-DDTHH:mm'), vehicleType: values.vehicleType, note: values.note?.trim() ?? '' })
      message.success('撤场安排已更新')
    } else {
      await withdrawalStore.getState().createForOrchard(targetOrchard.id, {
        withdrawAt: values.withdrawAt.format('YYYY-MM-DDTHH:mm'),
        vehicleType: values.vehicleType,
        note: values.note?.trim() ?? ''
      })
      message.success('撤场安排已生成')
    }
    setModalOpen(false)
  }

  async function regenerate(plan: WithdrawalPlan): Promise<void> {
    await withdrawalStore.getState().regenerate(plan.id)
    message.success('已按最新花期与容量重算撤场安排')
  }

  async function execute(plan: WithdrawalPlan): Promise<void> {
    try {
      await withdrawalStore.getState().execute(plan.id)
      message.success('已撤场：地块上蜂群回场，可赶往下个果园')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤场失败')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">撤场安排 · 技术员</h2>
          <p className="page-sub">
            按地块编排撤场时刻与车辆；托管队改动盛花期或投放点容量后，安排会标记「已失效」，须重算后才能执行，避免赶花期时撤错。
          </p>
        </div>
      </div>

      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {orderedOrchards.map((orchard) => {
          const plan = planOf(orchard.id)
          const points = pointsOf(orchard.id)
          const stale = plan ? isPlanStale(plan, orchard, points) : false
          const orchardDeps = deployments.filter((dep) => dep.orchardId === orchard.id)
          const placedDeps = orchardDeps.filter((dep) => dep.status === '已投放')
          const queuedDeps = orchardDeps.filter((dep) => dep.status === '排队中')
          return (
            <Card
              key={orchard.id}
              size="small"
              title={
                <Space wrap>
                  <span>{orchard.name}</span>
                  <Tag>{orchard.bloomStart} ~ {orchard.bloomEnd}</Tag>
                  <AcceptanceTag orchard={orchard} />
                  {plan?.status === '已撤场' ? <Tag color="blue">已撤场</Tag> : null}
                  {plan && stale && plan.status === '待执行' ? <Tag color="red">已失效·待重算</Tag> : null}
                </Space>
              }
              extra={
                plan ? (
                  <Space>
                    {stale && plan.status === '待执行' ? (
                      <Button size="small" type="primary" onClick={() => void regenerate(plan)}>
                        失效重算
                      </Button>
                    ) : null}
                    {plan.status === '待执行' ? (
                      <>
                        <Button size="small" onClick={() => openEdit(plan, orchard)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title={orchard.acceptance === '达标' ? '确认执行撤场？地块上所有蜂群将回场。' : `地块验收为「${orchard.acceptance}」，仍要执行撤场？`}
                          onConfirm={() => execute(plan)}
                          okText="执行撤场"
                          cancelText="取消"
                        >
                          <Button size="small" type="primary" danger disabled={stale}>
                            执行撤场
                          </Button>
                        </Popconfirm>
                      </>
                    ) : null}
                    <Popconfirm
                      title="删除该撤场安排？"
                      onConfirm={() => withdrawalStore.getState().remove(plan.id)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button size="small" danger type="link">
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ) : (
                  <Button size="small" type="primary" disabled={orchard.acceptance === '不达标'} onClick={() => openCreate(orchard)}>
                    编排撤场
                  </Button>
                )
              }
            >
              {plan ? (
                <Space direction="vertical" size={4}>
                  <Space wrap>
                    <Tag color="geekblue">撤场时刻 {plan.withdrawAt.replace('T', ' ')}</Tag>
                    <Tag>{plan.vehicleType}</Tag>
                    {plan.executedAt ? <Tag color="blue">完成于 {dayjs(plan.executedAt).format('YYYY-MM-DD HH:mm')}</Tag> : null}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      依据快照：花期 {plan.basisBloomStart} ~ {plan.basisBloomEnd} · 容量 {plan.basisCapacityDigest || '—'}
                    </Typography.Text>
                  </Space>
                  {plan.note ? <Typography.Text style={{ fontSize: 12 }}>备注：{plan.note}</Typography.Text> : null}
                  {stale && plan.status === '待执行' ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      托管队改过花期或容量，本安排与现状不符，执行已锁定，请点「失效重算」。
                    </Typography.Text>
                  ) : null}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {orchard.acceptance === '不达标'
                    ? '验收不达标，蜂群待补投，暂不编排撤场。'
                    : `尚无撤场安排（默认建议盛花期末次日 ${suggestWithdrawAt(orchard).replace('T', ' ')} 撤场）。`}
                </Typography.Text>
              )}
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    在场蜂群：
                  </Typography.Text>
                  {placedDeps.length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      无已投放
                    </Typography.Text>
                  ) : (
                    placedDeps.map((dep) => {
                      const colony = colonyById.get(dep.colonyId)
                      const point = dropPoints.find((item) => item.id === dep.dropPointId)
                      return <Tag key={dep.id} color="green">{colony?.code ?? '?'}@{point?.code ?? '?'}</Tag>
                    })
                  )}
                  {queuedDeps.length > 0 ? (
                    <>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        排队：
                      </Typography.Text>
                      {queuedDeps.map((dep) => {
                        const colony = colonyById.get(dep.colonyId)
                        return <Tag key={dep.id} color="orange">{colony?.code ?? '?'}</Tag>
                      })}
                    </>
                  ) : null}
                </Space>
              </div>
            </Card>
          )
        })}
        {orderedOrchards.length === 0 ? <Empty description="暂无地块" /> : null}
      </Space>

      <Modal
        title={editingPlan ? '编辑撤场安排' : `编排撤场 · ${targetOrchard?.name ?? ''}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="withdrawAt" label="撤场时刻" rules={[{ required: true, message: '请选择撤场时刻' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="vehicleType" label="车辆类型" rules={[{ required: true }]}>
            <Select options={VEHICLE_TYPES.map((item) => ({ value: item, label: item }))} />
          </Form.Item>
          <Form.Item name="note" label="撤场备注">
            <Input.TextArea rows={2} placeholder="如 顺路转运下个果园，需提前联系园主交接" />
          </Form.Item>
          {targetOrchard && !editingPlan ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              将按当前花期（{targetOrchard.bloomStart} ~ {targetOrchard.bloomEnd}）与各投放点容量固化依据，之后托管队改动会令其失效。
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>
    </div>
  )
}
