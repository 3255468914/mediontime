/**
 * 端到端冒烟测试：在 Node 中模拟浏览器环境，验证
 * Store（数据层） + ReminderEngine（提醒调度）的完整链路。
 *
 * 运行：node tests/smoke.test.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- 构造浏览器沙箱 ---------- */
function makeSandbox() {
  const mem = {};
  const localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
    clear: () => { Object.keys(mem).forEach((k) => delete mem[k]); }
  };

  const fired = { notifications: [], fullscreen: [], caregiver: [], missed: [] };

  const sandbox = {
    localStorage,
    crypto: { randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }) },
    navigator: { vibrate: () => true },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    focus() {},
    addEventListener() {},
    _fired: fired
  };

  function FakeNotification(title, opts) {
    fired.notifications.push({ title, body: opts && opts.body, tag: opts && opts.tag });
    this.title = title; this.onclick = null;
    this.close = function () {};
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = () => Promise.resolve('granted');
  sandbox.Notification = FakeNotification;

  // AudioContext 桩：不发声，只记录调用
  sandbox.AudioContext = function () {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.resume = () => {};
    this.createOscillator = () => ({ type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} });
    this.createGain = () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}
    });
  };

  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadInto(sandbox, rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function eq(a, e, name) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${E}\n      实际: ${A}`); }
}
function ok(c, name) { eq(!!c, true, name); }
function section(t) { console.log(`\n${t}`); }

/* ---------- 启动沙箱 ---------- */
const sb = makeSandbox();
vm.createContext(sb);
loadInto(sb, 'js/scheduler.js');
loadInto(sb, 'js/store.js');
loadInto(sb, 'js/reminder.js');

const S = sb.Scheduler;
const Store = sb.Store;
const RE = sb.ReminderEngine;

/* ========== 1. 初始化与种子数据 ========== */
section('【1. 初始化与持久化】');
Store.load();
eq(Store.state.medicines.length, 3, '种子数据含 3 种药品');
eq(Store.state.plans.length, 3, '种子数据含 3 条用药计划');
eq(Store.state.caregivers.length, 0,
  '种子数据**不含**任何家属——真实绑定只存在于中继侧，本地不伪造（P8-32）');
ok(sb.localStorage.getItem('mediontime.state.v1') !== null, '数据已写入本地存储');
ok(!Store.state.user.consentAccepted, '初始状态未同意免责声明');

// 模拟「重启应用」：清空内存状态后从 localStorage 重新加载
const memRaw = sb.localStorage.getItem('mediontime.state.v1');
Store.state.__probe = true;
eq(JSON.parse(memRaw).medicines.length, 3, '重启后可完整读回数据（BR-06）');

/* ========== 2. 排程重建 ========== */
section('【2. 排程重建与幂等】');
const r1 = Store.regenerateReminders();
ok(r1.length > 0, '重建后产生待触发提醒');
ok(r1.every(r => r.status === 'pending' || r.status === 'confirmed' || r.status === 'missed'), '提醒状态合法');

const pendingBefore = Store.state.reminders.filter(r => r.status === 'pending').length;
Store.regenerateReminders();
Store.regenerateReminders();
const pendingAfter = Store.state.reminders.filter(r => r.status === 'pending').length;
eq(pendingAfter, pendingBefore, '重复重建排程不产生重复提醒（幂等）');

const histBefore = Store.state.reminders.filter(r => r.status !== 'pending').length;
Store.regenerateReminders();
eq(Store.state.reminders.filter(r => r.status !== 'pending').length, histBefore, '重建不会动已确认/漏服的历史提醒（BR-02）');

/* ========== 3. 打卡链路 ========== */
section('【3. 打卡 confirmReminder】');
const target = Store.state.reminders.filter(r => r.status === 'pending')
  .sort((a, b) => a.scheduledAt < b.scheduledAt ? -1 : 1)[0];
ok(target, '取到一条待触发提醒');

const logCountBefore = Store.state.logs.length;
const log1 = Store.confirmReminder(target, 'in_app', new Date(target.scheduledAt));
eq(log1.status, 'on_time', '准点打卡 → on_time');
eq(log1.delayMinutes, 0, '准点打卡延迟分钟数为 0');
eq(log1.confirmedBy, 'in_app', '记录确认来源');
eq(Store.state.logs.length, logCountBefore + 1, '新增且仅新增一条服药记录');
eq(target.status, 'confirmed', '提醒状态更新为已确认');

// 幂等：重复确认不产生第二条记录
const log1again = Store.confirmReminder(target, 'notification');
eq(log1again.id, log1.id, '重复确认返回同一条记录（幂等）');
eq(Store.state.logs.length, logCountBefore + 1, '重复确认不新增记录');

// 提前确认（未到点就打卡）：delay 为负，仍归为 on_time
const tEarly = Store.state.reminders.filter(r => r.status === 'pending')
  .sort((a, b) => a.scheduledAt < b.scheduledAt ? -1 : 1)[0];
const logEarly = Store.confirmReminder(tEarly, 'in_app');
ok(logEarly.delayMinutes < 0, '提前打卡记录为负延迟');
eq(logEarly.status, 'on_time', '提前打卡仍归为 on_time（BR-10：delay ≤ 30 即准时）');

// 延迟打卡
const t2 = Store.state.reminders.filter(r => r.status === 'pending')
  .sort((a, b) => a.scheduledAt < b.scheduledAt ? -1 : 1)[0];
const log2 = Store.confirmReminder(t2, 'in_app', new Date(new Date(t2.scheduledAt).getTime() + 45 * 60000));
eq(log2.status, 'delayed', '延迟 45 分钟 → delayed');
eq(log2.delayMinutes, 45, '延迟分钟数正确');

/* ========== 4. 漏服与补救 ========== */
section('【4. 漏服标记与补服】');
// 构造一条「3 小时前该服药」的提醒——真实漏服场景下提醒必然已过时间
function pastReminder(minutesAgo, planId, id) {
  return {
    id: id, planId: planId,
    scheduledAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    windowMinutes: 120, status: 'pending', level: 0,
    fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
  };
}
const t3 = pastReminder(180, Store.state.plans[0].id, 'r_miss_1');
Store.state.reminders.push(t3);
const missedLog = Store.markMissed(t3);
eq(missedLog.status, 'missed', '标记漏服 → status=missed');
eq(missedLog.actualTakenAt, null, '漏服记录无实际服药时间');
eq(t3.status, 'missed', '提醒状态更新为漏服');

Store.markMissed(t3);
eq(Store.state.logs.filter(l => l.scheduledAt === t3.scheduledAt && l.planId === t3.planId).length, 1,
  '重复标记漏服不产生重复记录（幂等）');

// 补救决策：距下次服药足够久 → 允许补服
const nextAt = S.nextScheduledAfter(Store.state.reminders, t3.planId, new Date());
const decision = S.makeUpDecision(new Date(), nextAt, 120);
ok(typeof decision.allow === 'boolean', '补救决策返回 allow 布尔值');

// 补服：生成独立记录，原漏服记录保留
const logsBeforeMakeup = Store.state.logs.length;
const mk = Store.makeupReminder(t3, new Date());
eq(mk.isMakeup, true, '补服记录 isMakeup=true');
eq(mk.status, 'makeup', '补服记录 status=makeup');
eq(mk.sourceLogId, missedLog.id, '补服记录通过 sourceLogId 关联原漏服记录');
eq(Store.state.logs.length, logsBeforeMakeup + 1, '补服新增记录，而非覆盖');
const stillMissed = Store.state.logs.filter(l => l.id === missedLog.id)[0];
ok(stillMissed && stillMissed.status === 'missed', '原漏服记录依然存在且状态未变（不覆盖）');

/* ========== 5. 跳过 ========== */
section('【5. 跳过本次】');
const t4 = pastReminder(240, Store.state.plans[0].id, 'r_skip_1');
Store.state.reminders.push(t4);
Store.markMissed(t4);
const skipLog = Store.skipReminder(t4);
eq(skipLog.status, 'skipped', '用户选择跳过 → status=skipped');
eq(t4.status, 'cancelled', '提醒状态更新为已取消');

/* ========== 6. 提醒升级链路（真实 tick） ========== */
section('【6. 升级链路实跑】');
sb._fired.notifications.length = 0;
sb._fired.fullscreen.length = 0;

// 造一条 20 分钟前该服药的提醒 → 应推进到 L3（全屏强提醒）
const freshPlan = Store.state.plans[0];
const freshMed = Store.getMedicine(freshPlan.medicineId);
const fakeRem = {
  id: 'r_test_1', planId: freshPlan.id,
  scheduledAt: new Date(Date.now() - 20 * 60000).toISOString(),
  windowMinutes: 120, status: 'pending', level: 0,
  fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
};
Store.state.reminders.push(fakeRem);

let fullscreenHit = 0, missedHit = 0;
const caregiverArgs = [];
RE.setCallbacks({
  onFullscreen: () => { fullscreenHit++; },
  onMissed: () => { missedHit++; },
  onCaregiverAlert: function () {
    caregiverArgs.push(Array.prototype.slice.call(arguments));
    sb._fired.caregiver.push(1);
  },
  onLevel: () => {}
});

RE.tick();
eq(fakeRem.level, 3, '20 分钟前未确认 → 推进到 L3');
ok(fullscreenHit >= 1, '触发全屏强提醒回调');
ok(sb._fired.notifications.length >= 3, 'L1/L2/L3 各发过一次系统通知');

// 已到 L3，再 tick 不应重复触发
const notifCountAfter = sb._fired.notifications.length;
RE.tick();
eq(sb._fired.notifications.length, notifCountAfter, '同等级不重复触发（防刷屏）');

// 推进到 L4（30 分钟前）
fakeRem.scheduledAt = new Date(Date.now() - 35 * 60000).toISOString();
fakeRem.level = 0;
RE.tick();
eq(fakeRem.level, 4, '35 分钟前未确认 → 推进到 L4');

// 关键回归锁：L4 必须触发家属告警回调，**哪怕本地一条家属记录都没有**。
// 旧版本这条分支写的是 `if (!list.length) return;`，靠种子数据里那条写死的
// 「女儿 · 小张」让 list 永远非空——于是它看起来一直在跑，实际把"本地有个名字"
// 当成了"有人会收到"。现在判据只剩"用户开了家属通道"，真正送达由中继回报。
ok(sb._fired.caregiver.length >= 1,
  'L4 触发家属告警回调，且不依赖本地家属记录（防止退回"靠假数据才跑得起来"）');
eq(Store.state.caregivers.length, 0, '（前提）此刻本地确实一条家属记录都没有');

// 隐私红线（P9-36）：这条回调的产物会被**发到另一台设备**，
// 所以递进去的每一个参数都必须与药名、剂量无关。
// 早先这里传了 `describe(reminder)`——一个装着 med 与 plan 的对象，
// 下游顺手用一下就是把药名发给了家属。现在只传 reminder 本身；这里把它锁死。
{
  const last = caregiverArgs[caregiverArgs.length - 1] || [];
  eq(last.length, 1, '家属回调只收到 1 个参数（不再附带 describe() 那个含药名与剂量的对象）');
  ok(last[0] === fakeRem,
    '回调收到的就是那条 reminder 本身，不是某个被加工过、可能夹带药品信息的副本');
  const medNames = Store.state.medicines.map((m) => m.name);
  eq(medNames.filter((n) => JSON.stringify(last).includes(n)), [],
    '回调参数的序列化结果里不含任何药名');
  ok(!/\d+\s*(片|粒|袋|丸)/.test(JSON.stringify(last)), '回调参数里不含任何剂量');
}

// 超过窗口（130 分钟前）→ 直接标记漏服，且不重放全屏
sb._fired.fullscreen.length = 0;
const oldRem = {
  id: 'r_test_2', planId: freshPlan.id,
  scheduledAt: new Date(Date.now() - 130 * 60000).toISOString(),
  windowMinutes: 120, status: 'pending', level: 0,
  fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
};
Store.state.reminders.push(oldRem);
RE.tick();
eq(oldRem.status, 'missed', '超过窗口 → 直接补齐漏服记录');
eq(sb._fired.fullscreen.length, 0, '严重逾期的提醒不重放全屏弹窗（避免打开应用被刷屏）');

// 已确认的提醒不再升级
const doneRem = {
  id: 'r_test_3', planId: freshPlan.id,
  scheduledAt: new Date(Date.now() - 40 * 60000).toISOString(),
  windowMinutes: 120, status: 'confirmed', level: 1,
  fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
};
Store.state.reminders.push(doneRem);
const notifBefore2 = sb._fired.notifications.length;
RE.tick();
eq(sb._fired.notifications.length, notifBefore2, '已确认的提醒不再触发升级（BR-01 中断链）');

// 隐私模式：通知不出现药名
section('【7. 隐私模式】');
Store.updateUser({ hideDrugName: true });
sb._fired.notifications.length = 0;
const privRem = {
  id: 'r_test_4', planId: freshPlan.id,
  scheduledAt: new Date(Date.now() - 1000).toISOString(),
  windowMinutes: 120, status: 'pending', level: 0,
  fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
};
Store.state.reminders.push(privRem);
RE.tick();
ok(sb._fired.notifications.length >= 1, '隐私模式下发出了通知');
eq(sb._fired.notifications[0].title, '用药提醒时间到', '隐私模式下通知标题不含药名');
ok(!String(sb._fired.notifications[0].body).includes(freshMed.name), '通知正文不含药品名称');
ok(!String(sb._fired.notifications[0].body).includes('片'), '通知正文不含剂量信息');
Store.updateUser({ hideDrugName: false });

/* ========== 8. 新增药品与排程联动 ========== */
section('【8. 新增药品 → 自动生成排程】');
const pendingBeforeAdd = Store.state.reminders.filter(r => r.status === 'pending').length;
const newMed = Store.addMedicine({ name: '维生素 D3 滴剂', specification: '400IU', dosageForm: 'drop', strength: '400IU', note: '' });
const newPlan = Store.addPlan({
  medicineId: newMed.id, doseAmount: 2, doseUnit: '滴',
  frequencyType: 'daily', anchorType: 'absolute',
  mealRelation: 'after_meal', mealLabel: '餐后 30 分钟',
  times: ['09:00'], startDate: S.dateKey(new Date()), endDate: null, isLongTerm: true
});
const pendingAfterAdd = Store.state.reminders.filter(r => r.status === 'pending').length;
ok(pendingAfterAdd > pendingBeforeAdd, '新增计划后自动生成新提醒');
eq(newPlan.times.length, 1, '计划时间点已保存');

const fromPlan = Store.state.reminders.filter(r => r.planId === newPlan.id && r.status === 'pending');
// 当天已过去的时间点不回填（BR-01），因此条数为 89 或 90
ok(fromPlan.length === 89 || fromPlan.length === 90,
  '每日 1 次 → 生成 89~90 条提醒（当天已过的时间点不回填）');
ok(fromPlan.every(r => new Date(r.scheduledAt) > new Date()), '生成的提醒全部位于未来时刻');
ok(fromPlan.every(r => new Date(r.scheduledAt).getHours() === 9), '所有提醒时间点均为 09:00');

/* ========== 9. 修改处方不篡改历史 ========== */
section('【9. 修改处方（BR-02）】');
const histSnapshot = JSON.stringify(
  Store.state.logs.filter(l => l.planId === newPlan.id)
);
Store.updatePlan(newPlan.id, { times: ['10:00'] });
const afterUpdate = Store.state.reminders.filter(r => r.planId === newPlan.id && r.status === 'pending');
ok(afterUpdate.length > 0, '修改时间后重新生成提醒');
ok(new Date(afterUpdate[0].scheduledAt).getHours() === 10, '新提醒按 10:00 生成');
eq(JSON.stringify(Store.state.logs.filter(l => l.planId === newPlan.id)), histSnapshot, '修改计划不改变已有服药记录');

/* ========== 10. 疗程结束自动停止 ========== */
section('【10. 疗程边界】');
const endDate = new Date(); endDate.setDate(endDate.getDate() + 6);
const courseMed = Store.addMedicine({ name: '阿莫西林胶囊', specification: '0.25g', dosageForm: 'capsule', strength: '0.25g', note: '疗程药' });
const coursePlan = Store.addPlan({
  medicineId: courseMed.id, doseAmount: 1, doseUnit: '粒',
  frequencyType: 'daily', anchorType: 'absolute', mealRelation: 'none', mealLabel: '不限',
  times: ['08:00', '20:00'], startDate: S.dateKey(new Date()),
  endDate: S.dateKey(endDate), isLongTerm: false
});
const courseRem = Store.state.reminders.filter(r => r.planId === coursePlan.id);
// 7 天 × 2 次 = 14，减去当天已过去的时间点（最多 2 个）
ok(courseRem.length === 14 || courseRem.length === 13 || courseRem.length === 12,
  '7 天疗程 × 每日 2 次 → 生成 12~14 条提醒（当天已过的不回填）');
ok(courseRem.every(r => new Date(r.scheduledAt) <= new Date(S.dateKey(endDate) + 'T23:59:59')),
  '所有提醒都不超出疗程结束日期');

/* ========== 11. 统计 ========== */
section('【11. 依从性统计】');
const from = new Date(); from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0);
const sum = S.summarize(Store.state.logs, from, new Date());
ok(sum.total > 0, '统计到服药记录');
ok(sum.onTimeRate >= 0 && sum.onTimeRate <= 100, '按时率在 0–100 之间');
ok(Object.keys(sum.byHour).length > 0, '按小时维度聚合存在');
ok(Object.keys(sum.byMedicine).length > 0, '按药品维度聚合存在');
ok(sum.makeup >= 1, '补服次数被统计（补服记录计入 makeup 而非 on_time）');
// 补服不重复计入分母
ok(sum.onTime + sum.delayed + sum.missed <= sum.total, '按时率分母不重复计入补服记录');

/* ========== 12. 停用而非删除 ========== */
section('【12. 归档（BR-02）】');
Store.archiveMedicine(newMed.id);
ok(Store.getMedicine(newMed.id).isArchived === true, '药品被标记为归档而非删除');
eq(Store.getPlan(newPlan.id).isActive, false, '关联计划自动停用');
ok(Store.state.logs.some(l => l.planId === newPlan.id) || Store.state.logs.filter(l => l.planId === newPlan.id).length === 0,
  '归档不影响历史记录的存在性');
eq(Store.state.reminders.filter(r => r.planId === newPlan.id && r.status === 'pending').length, 0,
  '归档后该计划不再有待触发提醒');

/* ========== 13. 导出 ========== */
section('【13. 数据导出】');
const exp = JSON.parse(Store.exportJson());
ok(exp.medicines && exp.plans && exp.logs, '导出包含药品/计划/记录');
ok(typeof exp.exportedAt === 'string', '导出带时间戳');

/* ========== 14. 时区策略（BR-05） ========== */
section('【14. 时区变化与二选一策略】');

const tzMed = Store.addMedicine({ name: '时区测试药' });
const tzPlan = Store.addPlan({
  medicineId: tzMed.id, doseAmount: 1, doseUnit: '片',
  frequencyType: 'daily', times: ['07:00', '19:00'],
  startDate: S.dateKey(new Date()), isLongTerm: true
});
eq(Store.getPlan(tzPlan.id).times, ['07:00', '19:00'], '建立测试处方（07:00 / 19:00）');

const logsBeforeTz = Store.state.logs.length;
const shiftWest = { changed: true, from: 'UTC+08', to: 'UTC+01', deltaMinutes: -420 };

/* --- 策略 A：保持原有服药间隔 --- */
const keepRes = Store.applyTimezonePolicy(S.TZ_POLICY.KEEP_RHYTHM, shiftWest);
eq(keepRes.policy, 'keep_rhythm', '返回实际生效的策略');
eq(Store.getPlan(tzPlan.id).times, ['00:00', '12:00'], '保持节奏：钟点按偏移差补偿');
eq(Store.state.user.timezone, 'UTC+01', '确认后记录新时区');
eq(Store.state.user.tzPolicy, 'keep_rhythm', '策略被持久化');
ok(typeof Store.state.user.tzUpdatedAt === 'string', '记录调整时间戳');
eq(Store.state.logs.length, logsBeforeTz, '调整时区不改写任何服药历史（BR-02）');

const tzRem = Store.state.reminders.filter(r => r.planId === tzPlan.id && r.status === 'pending');
ok(tzRem.length > 0, '调整后立即重算排程，仍有待触发提醒');
ok(tzRem.every(r => [0, 12].indexOf(new Date(r.scheduledAt).getHours()) !== -1),
  '重算后的提醒时刻与调整后的处方一致');
eq(Store.state.reminders.filter(r => r.planId === tzPlan.id && r.level > 0).length, 0,
  '重算后新提醒的升级等级归零（不复用旧状态）');

/* --- 策略 B：按当地钟点服药 --- */
Store.applyTimezonePolicy(S.TZ_POLICY.FOLLOW_LOCAL, { changed: true, from: 'UTC+01', to: 'UTC+08', deltaMinutes: 420 });
eq(Store.getPlan(tzPlan.id).times, ['00:00', '12:00'], '按当地钟点：钟点保持不变');
eq(Store.state.user.tzPolicy, 'follow_local', '策略切换为按当地时间');

/* --- 相对锚点处方：应平移锚点时间而非 times --- */
const anchorPlan = Store.addPlan({
  medicineId: tzMed.id, doseAmount: 1, doseUnit: '片',
  frequencyType: 'daily', anchorType: 'relative', anchorTime: '07:00', offsetMinutes: 30,
  times: ['06:30'], startDate: S.dateKey(new Date()), isLongTerm: true
});
eq(S.resolveScheduledAt(Store.getPlan(anchorPlan.id), new Date(), '06:30').getHours(), 6,
  '相对锚点处方：提醒时刻 = 锚点 07:00 提前 30 分钟');
Store.applyTimezonePolicy(S.TZ_POLICY.KEEP_RHYTHM, shiftWest);
eq(Store.getPlan(anchorPlan.id).anchorTime, '00:00', '相对锚点处方平移锚点时间，而不是 times');
eq(S.resolveScheduledAt(Store.getPlan(anchorPlan.id), new Date(), '06:30').getHours(), 23,
  '平移后相对锚点仍按"提前 30 分钟"生效（00:00 − 30 分 = 前一日 23:30）');

/* --- 边界：偏移差为 0 时不得改动处方 --- */
const timesBefore = JSON.stringify(Store.getPlan(tzPlan.id).times);
Store.applyTimezonePolicy(S.TZ_POLICY.KEEP_RHYTHM, { changed: false, from: 'UTC+01', to: 'UTC+01', deltaMinutes: 0 });
eq(JSON.stringify(Store.getPlan(tzPlan.id).times), timesBefore, '偏移差为 0 时处方原样保留');

/* --- 确认后不再重复提示 --- */
Store.updateUser({ timezone: S.currentTimezone() });
eq(S.detectTimezoneChange(Store.state.user.timezone).changed, false, '确认后不再重复弹出时区提示');

/* ========== 15. 自适应唤醒（省电） ========== */
section('【15. 自适应唤醒（省电）】');

// 这一组要证明两件事：
//   ① 闲置时不再每秒空转（从 3600 次/小时 降到约 12 次/小时）；
//   ② 拉长轮询【不会】让提醒迟到——这才是敢拉长的前提。
// 用固定的 NOW 参与计算，避免断言被真实时钟的毫秒抖动影响。
const T = RE.TIMING;
const NOW = Date.now();

Store.resetToSeed();
Store.state.reminders = [];
Store.updateUser({ demoFast: false });
eq(RE.nextEventAt(NOW), null, '无待触发提醒时：没有下一个事件');
eq(RE.nextDelay(NOW), T.CEIL_IDLE, '无待触发提醒时：睡到空闲上限（5 分钟），不再每秒轮询');

const tzPlan0 = Store.state.plans[0];
function mkRem(id, atMs) {
  return {
    id: id, planId: tzPlan0.id, scheduledAt: new Date(atMs).toISOString(),
    windowMinutes: 120, status: 'pending', level: 0,
    fireAt: null, acknowledgedAt: null, acknowledgeType: null, createdAt: new Date().toISOString()
  };
}

// —— 事件很远：单次最多睡空闲上限，靠收敛逼近，而不是一次睡 3 小时
Store.state.reminders = [mkRem('r_far', NOW + 3 * 3600 * 1000)];
eq(RE.nextEventAt(NOW), NOW + 3 * 3600 * 1000, '事件在 3 小时后：nextEventAt 精确指向它');
eq(RE.nextDelay(NOW), T.CEIL_IDLE, '事件在 3 小时后：单次只睡空闲上限 5 分钟（留时钟跳变的保险）');

// —— 核心性质：反复重算的累计等待必须正好落在事件时刻，不得越过
// （真实引擎每醒一次都会先 tick() 结算，这里只考察"该睡多久"的收敛性，
//   所以每个场景都用独立的提醒，避免把上一场景的状态带进来）
function converge(waitMs) {
  let acc = 0, cycles = 0;
  while (acc < waitMs) {
    const d = RE.nextDelay(NOW + acc);
    if (!(d > 0)) return { acc, cycles, stuck: true };
    acc += d; cycles++;
    if (cycles > 10000) return { acc, cycles, stuck: true };
  }
  return { acc, cycles, stuck: false };
}
const cv3h = converge(3 * 3600 * 1000);
eq(cv3h.stuck, false, '3 小时后的事件：收敛过程不会卡住');
eq(cv3h.acc, 3 * 3600 * 1000, '3 小时后的事件：累计等待正好落在事件时刻，不多睡一毫秒（不迟到也不白等）');
ok(cv3h.cycles <= 60, `3 小时只唤醒 ${cv3h.cycles} 次（旧实现每秒一次 = 10800 次，即省下约 ${Math.round(10800 / cv3h.cycles)} 倍）`);

// —— 事件临近：受临近上限约束
Store.state.reminders = [mkRem('r_near', NOW + 3 * 60000)];
eq(RE.nextDelay(NOW), T.CEIL_NEAR, '事件在 3 分钟后：单次睡临近上限 30 秒');

// —— 事件在窗口内：精确睡到那一刻（不迟到）
Store.state.reminders = [mkRem('r_soon', NOW + 20000)];
eq(RE.nextDelay(NOW), 20000 + T.LEAD_MS, '事件在 20 秒后：精确睡 20 秒（含 40ms 提前量），不会迟');
const cv20 = converge(20000);
eq(cv20.acc, 20000 + T.LEAD_MS, '20 秒后的事件：累计等待正好 20 秒 + 提前量（不多等一秒）');
eq(cv20.cycles, 1, '20 秒后的事件：只唤醒 1 次');

// —— 已进入升级链：下一个事件应是下一级，而不是重新等 scheduledAt
const prog = mkRem('r_prog', NOW - 6 * 60000);   // 已过 6 分钟 → L2(5min) 已过，下一级是 L3(15min)
Store.state.reminders = [prog];
const escNow = RE.computeEscalation(prog);
const nextLv = escNow.filter(e => new Date(e.at).getTime() > NOW)[0];
eq(new Date(RE.nextEventAt(NOW)).toISOString(), nextLv.at, '已到点未确认：下一个事件正好是升级链里还没到的那一级');

// —— 严重逾期边界：升级链走完后仍要醒一次去补记漏服
const overdue = mkRem('r_over', NOW - 200 * 60000);   // 200 分钟前，窗口 120 分钟
Store.state.reminders = [overdue];
ok(RE.nextEventAt(NOW) !== null, '升级链走完（严重逾期）后仍安排了一次唤醒，用于补记漏服');

// —— 运行期：start/stop 不再使用永久 setInterval
Store.state.reminders = [mkRem('r_run', NOW + 3 * 3600 * 1000)];
RE.start();
ok(RE.isRunning(), 'start() 后处于运行态');
ok(RE.lastDelay() > 1000, 'start() 排定的单次等待 > 1 秒（确认不是每秒轮询）');
RE.stop();
ok(!RE.isRunning(), 'stop() 后不再持有定时器');
eq(RE.lastDelay(), null, 'stop() 后清空等待记录');

// —— 回归锁：源码里不允许再出现 setInterval
// 先剥掉注释：讲解"以前这里是 setInterval"的说明文字不该被当成违规代码
const reminderSrc = fs.readFileSync(path.join(ROOT, 'js/reminder.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 这类）
ok(reminderSrc.indexOf('setInterval') === -1, 'reminder.js 代码中已无 setInterval（防止后人改回每秒轮询）');
ok(reminderSrc.indexOf('setTimeout') !== -1, 'reminder.js 代码中使用 setTimeout 自适应唤醒');
ok(reminderSrc.indexOf('clearTimeout') !== -1, 'reminder.js 在重排前先 clearTimeout（不叠加定时器）');

/* ========== 源码锁：后台/熄屏链路的两个缺口 ==========
 *
 * 这两个缺口都是"界面看起来正常、到点什么都不发生"的类型，
 * 靠人工测试很难发现（要恰好把应用放后台、恰好到点、恰好没响），
 * 所以在源码层面钉住。
 */

const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

// (1) 回到前台必须重新对齐【系统闹钟】，不能只结算页面内引擎。
//     系统会在后台清掉闹钟（重启、权限变更、ROM 深度管控），
//     只 reschedule 页面内引擎会得到一个沉默失败：界面照常，到点不响。
const visIdx = appSrc.indexOf("addEventListener('visibilitychange'");
const visBlock = visIdx === -1 ? '' : appSrc.slice(visIdx, appSrc.indexOf('});', visIdx));
ok(visIdx !== -1, 'app.js 注册了 visibilitychange（回到前台的自愈时机）');
ok(visBlock.indexOf('scheduleSync()') !== -1,
  '回到前台会重新同步系统闹钟（否则后台被系统清掉的闹钟永远不会回来）');
ok(visBlock.indexOf('RE.reschedule()') !== -1,
  '回到前台仍会结算页面内引擎错过的时间');

// (2) 「提醒现在不可靠」必须在首页就能看见，而不是只藏在「我的」页里。
const todayIdx = appSrc.indexOf('function renderToday()');
const todayBody = todayIdx === -1 ? '' : appSrc.slice(todayIdx, appSrc.indexOf('function renderMeds()', todayIdx));
ok(appSrc.indexOf('function reliabilityIssue()') !== -1, '存在统一的「现在不可靠」判定函数');
ok(todayBody.indexOf('reliabilityBanner()') !== -1,
  '首页渲染包含可靠性横幅（长者不进「我的」页也能看到通知权限被关）');
['permState', 'exactAlarmState', 'syncResult'].forEach(function (k) {
  ok(appSrc.slice(appSrc.indexOf('function reliabilityIssue()')).indexOf(k) !== -1,
    '可靠性判定覆盖了 ' + k + ' 这条状态');
});

/* ========== 源码锁：P10-39 系统侧对账（「已托管」不许说谎） ==========
 *
 * registered/applied 是 App 自己的记账（"我交了几条"），不代表系统里真有。
 * ROM 深度清理、重启未恢复、系统删闹钟都会造成账实分离——
 * 若只用账面数，「系统已托管 N 条」会在闹钟已死时照常显示，纯属界面说谎。
 * 锁两件事：① 原生 schedule 注册后必须从系统读回真实数量；
 * ② UI 只在拿到真实数字（typeof === 'number'）时做账实比较并如实亮红灯。
 */
const platformSrc2 = fs.readFileSync(path.join(ROOT, 'js/platform.js'), 'utf8');
ok(platformSrc2.indexOf('systemCount') !== -1, 'platform.js 在同步结果里携带系统侧真实数量');
ok(/plugin\.schedule\(\{ notifications: notifications \}\)[\s\S]{0,500}systemCount/.test(platformSrc2),
  '原生 schedule 在注册后调用 getPending 读回系统实际数量（对账）');
ok(platformSrc2.indexOf("systemCount: null") !== -1,
  '读回失败时记 null（未知），不许编造成功或失败');
ok(appSrc.indexOf("typeof syncResult.systemCount === 'number'") !== -1,
  'app.js 只在 systemCount 是真实数字时才做账实比较——null 不参与，防止误报');
ok(appSrc.indexOf('systemCount < syncResult.registered') !== -1,
  'app.js 用 systemCount < registered 判定账实分离');
ok(appSrc.indexOf('系统闹钟已被清理') !== -1,
  '账实分离时横幅如实说「系统闹钟已被清理」，不拿账面数充数');
ok(appSrc.indexOf('系统闹钟仅剩') !== -1,
  '部分丢失时如实显示剩余比例');

/* ========== 源码锁：演示加速不得污染后台/熄屏送达测试 ==========
 * 演示加速开启时，「立即触发演示」的 L1 在 3 秒内响完，此后系统里没有任何
 * 近期闹钟（其余提醒的 L1 锚定真实每日时刻）。用户会拿演示模式测熄屏送达、
 * 得出"连接家属协同弄坏了提醒"的错误结论（2026-10-12 真机排障实录）。
 * 锁住两处提示：开启开关时的 toast、可靠性卡里的常驻警示行。
 */
const demoWarn = '验证后台/熄屏送达时请先关闭本开关';
ok(appSrc.indexOf(demoWarn) !== -1,
  '开启演示加速的 toast 明确警告「测后台/熄屏送达请先关闭」');
ok(appSrc.indexOf('演示加速开启中') !== -1 && appSrc.indexOf('没有近期闹钟') !== -1,
  '可靠性卡在演示加速开启时说明「系统里没有近期闹钟」的观测假象');

/* ========== 源码锁：L4「通知家属」交给中继计时 + L3 纳入系统托管 ==========
 * L4 原先只靠患者手机页面里的 JS 定时器驱动：熄屏/进程被冻结后永不触发，
 * 而家属协同的全部意义恰是"患者没反应时有人知道"（2026-10-12 落地的修复）。
 * 锁四处：中继两个新接口与计时扫描、患者端上报/撤销、排程处同步对齐、
 * 撤销覆盖全部结算路径（确认/跳过/补录/漏服），以及 L3 进入系统托管批次。
 */
const relayClientSrc = fs.readFileSync(path.join(ROOT, 'js/relay.js'), 'utf8');
const relayServerSrc = fs.readFileSync(
  path.join(ROOT, '..', 'server', 'relay.mjs'), 'utf8');

ok(relayServerSrc.indexOf('/api/notify-schedule') !== -1
  && relayServerSrc.indexOf('/api/notify-cancel') !== -1,
  '中继提供待办上报与撤销接口（计时数据有地方进、有地方出）');
ok(relayServerSrc.indexOf('checkWatches') !== -1
  && relayServerSrc.indexOf("via: 'relay-watch'") !== -1,
  '中继到点扫描并推送，事件带 relay-watch 来源标记');
ok(relayServerSrc.indexOf('reminderId') !== -1
  && relayServerSrc.indexOf("ev.reminderId") !== -1,
  '患者实时上报带 reminderId 时中继撤销对应待办（家属不收重复通知）');

ok(relayClientSrc.indexOf('scheduleWatches') !== -1
  && relayClientSrc.indexOf('cancelWatches') !== -1,
  '患者端 Relay 具备待办上报与撤销方法');
ok(appSrc.indexOf('caregiverWatchItems') !== -1
  && appSrc.indexOf('syncCaregiverWatches') !== -1,
  'app.js 从升级链取 L4 时刻并在排程变化时同步给中继（不重算升级链）');
ok(appSrc.indexOf('syncCaregiverWatches()') !== -1
  && appSrc.indexOf('function doSync()') !== -1
  && appSrc.indexOf('syncCaregiverWatches();') !== -1,
  'doSync 后同步中继待办：系统闹钟与中继计时来自同一次排程变化');
const cancelWatchCalls = (appSrc.match(/cancelWatch\(/g) || []).length;
ok(cancelWatchCalls >= 8,
  '确认/跳过/补录/漏服各结算路径都撤销中继待办（实测 ' + cancelWatchCalls + ' 处调用）');
ok(appSrc.indexOf('reminderId: reminder.id') !== -1,
  '白名单构造器包含 reminderId（内部随机 id，不是药名）');
ok(appSrc.indexOf('计划时刻') !== -1 || appSrc.indexOf('计划时刻（内部编号 + 时刻）') !== -1,
  '隐私政策如实说明计时时刻会上传到中继');

ok(platformSrc2.indexOf('levels = opts.levels || [1, 2, 3]') !== -1,
  '系统托管默认覆盖 L1/L2/L3（催办链到 L2 之后不再静默）');
ok(appSrc.indexOf('levels: [1, 2, 3]') !== -1,
  'app.js 的 buildJobs 批次包含 L3');

/* ========== 汇总 ========== */
console.log('\n' + '─'.repeat(52));
console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
