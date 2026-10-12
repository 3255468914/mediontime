/**
 * scheduler.js 单元测试
 * 运行：node tests/scheduler.test.cjs
 */
const S = require('../js/scheduler.js');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function ok(cond, name) { eq(!!cond, true, name); }

function section(t) { console.log(`\n${t}`); }

/* ========== 基础工具 ========== */
section('【基础工具】');
eq(S.pad2(7), '07', 'pad2 补零');
eq(S.dateKey(new Date(2026, 9, 10)), '2026-10-10', 'dateKey 格式化（月份从 0 计）');
eq(S.combineDateTime('2026-10-10', '07:00').getHours(), 7, 'combineDateTime 小时正确');
eq(S.minutesBetween('2026-10-10T07:00:00', '2026-10-10T07:41:00'), 41, 'minutesBetween 计算正确');
eq(S.minutesBetween('2026-10-10T07:00:00', '2026-10-10T06:58:00'), -2, 'minutesBetween 支持负值（提前服）');

/* ========== 状态判定（BR-10） ========== */
section('【状态判定 classify】');
eq(S.classify(0), 'on_time', '准点 → on_time');
eq(S.classify(30), 'on_time', '延迟 30 分钟 → on_time（边界闭区间）');
eq(S.classify(31), 'delayed', '延迟 31 分钟 → delayed');
eq(S.classify(120), 'delayed', '延迟 120 分钟 → delayed（窗口边界）');
eq(S.classify(121), 'missed', '延迟 121 分钟 → missed');
eq(S.classify(45, 30), 'missed', '自定义窗口 30 分钟时，45 分钟 → missed');

/* ========== 排程生成 ========== */
section('【排程引擎 generateSchedule】');
const plan3x = {
  id: 'p1', isActive: true, anchorType: 'absolute',
  times: ['07:00', '12:00', '18:00'],
  frequencyType: 'daily', startDate: '2026-10-01', endDate: null
};
const from = new Date(2026, 9, 10, 6, 0, 0);   // 10 月 10 日 06:00 起算

const s30 = S.generateSchedule({ plans: [plan3x], from, days: 30 });
eq(s30.length, 90, '每日 3 次 × 30 天 = 90 条提醒');
ok(s30.every(r => new Date(r.scheduledAt) > from), '不回填历史：全部晚于起始时刻');
eq(new Date(s30[0].scheduledAt).getHours(), 7, '首条为 07:00');
ok(s30.every((r, i) => i === 0 || r.scheduledAt >= s30[i - 1].scheduledAt), '结果按时间升序');

const s90 = S.generateSchedule({ plans: [plan3x], from, days: 90 });
eq(s90.length, 270, '每日 3 次 × 90 天 = 270 条提醒');

// 幂等：相同输入重复生成，结果必须完全一致
const keyOf = r => r.planId + '|' + r.scheduledAt;
const again = S.generateSchedule({ plans: [plan3x], from, days: 90 });
eq(again.length, s90.length, '幂等：重复生成条数一致');
eq(again.map(keyOf).join(), s90.map(keyOf).join(), '幂等：重复生成结果逐条一致');
// 合并去重后仍为 270，保证落地到存储时不会重复调度
const merged = s90.concat(again);
eq(new Set(merged.map(keyOf)).size, 270, '合并去重后仍为 270 条（存储层按 planId|scheduledAt 去重）');

// 起始当天已过去的时间点被跳过
const lateFrom = new Date(2026, 9, 10, 20, 0, 0);  // 当晚 20:00
const sLate = S.generateSchedule({ plans: [plan3x], from: lateFrom, days: 1 });
eq(sLate.length, 0, '当天时间点均已过去 → 不生成（避免立刻补触发）');

/* ========== 疗程与频次 ========== */
section('【疗程与频次】');
const plan7d = { id: 'p2', isActive: true, anchorType: 'absolute', times: ['08:00'], frequencyType: 'daily', startDate: '2026-10-10', endDate: '2026-10-16' };
const s7 = S.generateSchedule({ plans: [plan7d], from: new Date(2026, 9, 10, 0, 0), days: 90 });
eq(s7.length, 7, '疗程 10/10–10/16 共 7 天 → 7 条提醒');
eq(s7[s7.length - 1].dateKey, '2026-10-16', '最后一条落在疗程结束日');

const planInactive = { id: 'p3', isActive: false, anchorType: 'absolute', times: ['09:00'], frequencyType: 'daily', startDate: '2026-10-01', endDate: null };
eq(S.generateSchedule({ plans: [planInactive], from, days: 30 }).length, 0, '停用计划不生成提醒（BR-02 停用而非删除）');

// 每周一三五
const planWeekly = { id: 'p4', isActive: true, anchorType: 'absolute', times: ['09:00'], frequencyType: 'weekly', weekdays: [1, 3, 5], startDate: '2026-10-01', endDate: null };
const sw = S.generateSchedule({ plans: [planWeekly], from, days: 14 });   // 10/10(六) 起 14 天
ok(sw.every(r => [1, 3, 5].includes(new Date(r.scheduledAt).getDay())), '每周指定日：只落在周一/三/五');

/* ========== 相对时间（S2 场景） ========== */
section('【相对时间锚点】');
const planRel = { id: 'p5', isActive: true, anchorType: 'relative', anchorTime: '07:30', offsetMinutes: 30, times: ['07:00'], frequencyType: 'daily', startDate: '2026-10-01', endDate: null };
const sr = S.generateSchedule({ plans: [planRel], from: new Date(2026, 9, 10, 0, 0), days: 1 });
eq(new Date(sr[0].scheduledAt).getHours(), 7, '相对锚点 07:30 − 提前 30 分钟 = 07:00');
eq(new Date(sr[0].scheduledAt).getMinutes(), 0, '相对锚点分钟数正确');

/* ========== 升级链路（BR-01） ========== */
section('【提醒升级链路 buildEscalation】');
const esc = S.buildEscalation('2026-10-10T07:00:00+08:00', 120, 1);
eq(esc.length, 5, '共 5 个升级阶段');
eq(esc.map(e => e.key), ['L1', 'L2', 'L3', 'L4', 'L5'], '阶段顺序 L1→L5');
const base = new Date('2026-10-10T07:00:00+08:00').getTime();
eq(S.minutesBetween(base, esc[0].at), 0, 'L1 在到点时刻触发');
eq(S.minutesBetween(base, esc[1].at), 5, 'L2 在 +5 分钟');
eq(S.minutesBetween(base, esc[2].at), 15, 'L3 在 +15 分钟');
eq(S.minutesBetween(base, esc[3].at), 30, 'L4 在 +30 分钟');
eq(S.minutesBetween(base, esc[4].at), 120, 'L5 在 +窗口 120 分钟');
ok(esc.every((e, i) => i === 0 || new Date(e.at) > new Date(esc[i - 1].at)), '升级时间严格递增');
ok(esc[2].channels.includes('fullscreen'), 'L3 包含全屏强提醒通道');
ok(esc[3].channels.includes('caregiver'), 'L4 包含家属通知通道');

const escFast = S.buildEscalation('2026-10-10T07:00:00+08:00', 120, 0.01);
eq(S.minutesBetween(base, escFast[2].at), 0, '演示加速 100 倍：L3 变为不足 1 分钟（向下取整为 0）');
eq(S.minutesBetween(base, escFast[1].at), 0, '演示加速：L2 同理压缩');

/* ========== 漏服补救（BR-03 / BR-04） ========== */
section('【漏服补救决策】');
const now = new Date(2026, 9, 10, 19, 0, 0);
// 下次服药在 17 小时后 → 允许补服
const d1 = S.makeUpDecision(now, new Date(2026, 9, 11, 12, 0, 0), 120);
eq(d1.allow, true, '距下次 17 小时 > 安全间隔 → 允许补服');
eq(d1.message, '是否现在补服？', '允许时给出补服询问');
// 下次服药在 40 分钟后 → 不允许
const d2 = S.makeUpDecision(now, new Date(2026, 9, 10, 19, 40, 0), 120);
eq(d2.allow, false, '距下次仅 40 分钟 ≤ 安全间隔 → 建议跳过');
ok(d2.message.includes('遵医嘱'), '不允许时给出遵医嘱文案（BR-04）');
ok(!/剂[量]|加服|减服|\d+mg|\d+片/.test(d2.message), '文案中不含任何剂量建议');
// 无后续服药 → 允许
eq(S.makeUpDecision(now, null, 120).allow, true, '无后续计划 → 允许补服');

/* ========== 下次服药时间 ========== */
section('【下次服药时间 nextScheduledAfter】');
const rems = [
  { planId: 'p1', scheduledAt: new Date(2026, 9, 10, 7, 0).toISOString(), status: 'confirmed' },
  { planId: 'p1', scheduledAt: new Date(2026, 9, 10, 12, 0).toISOString(), status: 'missed' },
  { planId: 'p1', scheduledAt: new Date(2026, 9, 10, 18, 0).toISOString(), status: 'pending' },
  { planId: 'p1', scheduledAt: new Date(2026, 9, 11, 7, 0).toISOString(), status: 'pending' }
];
eq(S.nextScheduledAfter(rems, 'p1', now), new Date(2026, 9, 11, 7, 0).toISOString(),
  '跳过已确认/已取消，返回最近的未来提醒');
eq(S.nextScheduledAfter(rems, 'p2', now), null, '无该计划的未来提醒 → null');

/* ========== 依从性统计 ========== */
section('【依从性统计 summarize】');
const logs = [
  { scheduledAt: new Date(2026, 9, 9, 7, 0).toISOString(), status: 'on_time', medicineId: 'm1' },
  { scheduledAt: new Date(2026, 9, 9, 12, 0).toISOString(), status: 'delayed', medicineId: 'm2' },
  { scheduledAt: new Date(2026, 9, 9, 18, 0).toISOString(), status: 'missed', medicineId: 'm2' },
  { scheduledAt: new Date(2026, 9, 9, 21, 0).toISOString(), status: 'on_time', medicineId: 'm3' },
  { scheduledAt: new Date(2026, 9, 10, 7, 0).toISOString(), status: 'on_time', medicineId: 'm1' }
];
const sum = S.summarize(logs, new Date(2026, 9, 9, 0, 0), new Date(2026, 9, 10, 23, 59));
eq(sum.total, 5, '总记录数正确');
eq(sum.onTime, 3, '按时 3 条');
eq(sum.delayed, 1, '延迟 1 条');
eq(sum.missed, 1, '漏服 1 条');
eq(sum.onTimeRate, 60, '按时率 = 3/5 = 60%');
eq(sum.byHour['07:00'].rate, 100, '07:00 时段按时率 100%');
eq(sum.byMedicine['m2'].rate, 0, 'm2 按时率 0%（1 延迟 + 1 漏服）');
eq(sum.byMedicine['m1'].total, 2, 'm1 共 2 次记录');

// 时间范围过滤
const sumFiltered = S.summarize(logs, new Date(2026, 9, 10, 0, 0), new Date(2026, 9, 10, 23, 59));
eq(sumFiltered.total, 1, '按日期区间过滤生效');

/* ========== 时区（BR-05） ========== */
section('【时区偏移解析与格式化】');
eq(S.parseTimezoneOffset('UTC+8'), 480, 'UTC+8 → 480 分钟');
eq(S.parseTimezoneOffset('UTC-3'), -180, 'UTC-3 → -180 分钟');
eq(S.parseTimezoneOffset('UTC+5:30'), 330, '支持半小时时区 UTC+5:30');
eq(S.parseTimezoneOffset('UTC'), 0, 'UTC → 0');
eq(S.parseTimezoneOffset('UTC+0'), 0, 'UTC+0 → 0');
eq(S.parseTimezoneOffset('模拟-旧时区'), null, '无法解析返回 null（不再误报时区变化）');
eq(S.parseTimezoneOffset(null), null, 'null 返回 null');
eq(S.formatTimezoneOffset(480), 'UTC+08', '480 → UTC+08');
eq(S.formatTimezoneOffset(-180), 'UTC-03', '-180 → UTC-03');
eq(S.formatTimezoneOffset(-330), 'UTC-05:30', '-330 → UTC-05:30');
eq(S.formatTimezoneOffset(0), 'UTC+00', '0 → UTC+00');
const TZ_SAMPLES = ['UTC+08', 'UTC-03', 'UTC+05:30', 'UTC+00', 'UTC-11'];
ok(TZ_SAMPLES.every(t => S.formatTimezoneOffset(S.parseTimezoneOffset(t)) === t),
  '格式化与解析互为逆运算');

section('【时区变化检测】');
const NOW_TZ = S.currentTimezone();
eq(S.detectTimezoneChange(NOW_TZ).changed, false, '时区未变化时不报警');
eq(S.detectTimezoneChange(NOW_TZ).deltaMinutes, 0, '未变化时偏移差为 0');
eq(S.detectTimezoneChange(null).changed, false, '首次运行（无历史时区）不报警');
const OTHER_TZ = S.parseTimezoneOffset(NOW_TZ) === 0 ? 'UTC+3' : 'UTC';
const tzChg = S.detectTimezoneChange(OTHER_TZ, 'UTC+8');
eq(tzChg.changed, true, '时区变化被检测到');
eq(tzChg.from, OTHER_TZ, '返回原时区');
eq(tzChg.to, 'UTC+8', '返回新时区');
eq(tzChg.deltaMinutes, 480 - S.parseTimezoneOffset(OTHER_TZ), '返回偏移差（新 - 旧）');
eq(S.detectTimezoneChange('UTC+8', 'UTC+1').deltaMinutes, -420, 'UTC+8 → UTC+1 偏移差 = -420');

section('【服药时间点平移】');
eq(S.shiftPlanTimes(['07:00'], 420), ['14:00'], '往后平移 7 小时');
eq(S.shiftPlanTimes(['07:00'], -420), ['00:00'], '往前平移 7 小时（跨零点）');
eq(S.shiftPlanTimes(['23:30'], 60), ['00:30'], '跨零点自动环绕');
eq(S.shiftPlanTimes(['07:00', '07:00'], 0), ['07:00'], '平移后去重');
eq(S.shiftPlanTimes(['21:00', '07:00'], 0), ['07:00', '21:00'], '结果始终升序');
eq(S.shiftPlanTimes([], 60), [], '空数组安全');
eq(S.shiftPlanTimes(['12:00'], 0), ['12:00'], '平移 0 分钟保持原样');

section('【时区二选一策略（BR-05）】');
const chgW = { deltaMinutes: -420 };   // UTC+8 → UTC+1
const keepR = S.resolveTimezoneChange(S.TZ_POLICY.KEEP_RHYTHM, chgW, ['07:00', '21:00']);
eq(keepR.policy, 'keep_rhythm', '按原节奏：策略识别正确');
eq(keepR.shiftMinutes, -420, '按原节奏：平移量 = 偏移差');
eq(keepR.times, ['00:00', '14:00'], '按原节奏：钟点随时间带平移');
const followL = S.resolveTimezoneChange(S.TZ_POLICY.FOLLOW_LOCAL, chgW, ['07:00', '21:00']);
eq(followL.policy, 'follow_local', '按当地时间：策略识别正确');
eq(followL.shiftMinutes, 0, '按当地时间：不平移');
eq(followL.times, ['07:00', '21:00'], '按当地时间：钟点不变');
eq(S.resolveTimezoneChange(undefined, chgW, ['07:00']).policy, 'follow_local',
  '缺省策略为按当地时间（最符合常识）');

// 核心不变量：keep_rhythm 下「当地时刻 - 当地偏移」必须保持不变
function absoluteUtc(hhmm, offsetMinutes) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m - offsetMinutes;
}
const oldLocal = '07:00', newLocal = keepR.times[0];
eq(absoluteUtc(oldLocal, 480), absoluteUtc(newLocal, 60),
  '按原节奏：UTC+8 的 07:00 与 UTC+1 的 00:00 是同一绝对时刻');
ok(absoluteUtc(oldLocal, 480) !== absoluteUtc(followL.times[0], 60),
  '按当地时间：绝对时刻确实发生了平移（两种策略不等价）');

/* ========== 原生提醒配额守卫（BR-09） ========== */
section('【原生提醒配额守卫 planNativeBatch】');
const NOW_MS = new Date(2026, 9, 10, 8, 0).getTime();
function makeJobs(n, startMin, stepMin) {
  return Array.from({ length: n }, (_, i) => ({
    reminderId: 'r' + i, planId: 'p' + i, level: 1,
    at: new Date(NOW_MS + (startMin + i * stepMin) * 60000).toISOString(),
    title: 'T' + i, body: 'B' + i
  }));
}

const batch = S.planNativeBatch(makeJobs(200, 1, 60), { now: NOW_MS, quota: 64 });
eq(batch.quota, 64, '配额透传');
eq(batch.usable, 64 - S.NATIVE_RESERVE, '可用额度预留安全余量');
eq(batch.registered, 60, '按额度截断注册数');
eq(batch.totalEligible, 200, '统计全部合格任务');
eq(batch.deferred, 140, '统计被推迟的任务数');
eq(batch.overflow, true, '溢出标志置位');
ok(new Date(batch.horizonEnd).getTime() === new Date(batch.items[59].at).getTime(),
  'horizonEnd 等于最后一条注册任务的时间');
ok(batch.items.every((it, i) => i === 0 || new Date(batch.items[i - 1].at) <= new Date(it.at)),
  '注册批次按时间升序（先到先保）');
eq(batch.coveredMinutes, 1 + 59 * 60, '覆盖时长 = 末条任务距今分钟数');

const noOverflow = S.planNativeBatch(makeJobs(10, 1, 60), { now: NOW_MS, quota: 64 });
eq(noOverflow.registered, 10, '未超限时全部注册');
eq(noOverflow.overflow, false, '未超限时溢出标志为 false');
eq(noOverflow.deferred, 0, '未超限时无推迟任务');

const past = S.planNativeBatch([
  { reminderId: 'a', level: 1, at: new Date(NOW_MS - 60000).toISOString() },
  { reminderId: 'b', level: 1, at: new Date(NOW_MS + 60000).toISOString() }
], { now: NOW_MS, quota: 64 });
eq(past.totalEligible, 1, '已过期的任务不注册');

const beyond = S.planNativeBatch([
  { reminderId: 'near', level: 1, at: new Date(NOW_MS + 86400000).toISOString() },
  { reminderId: 'far', level: 1, at: new Date(NOW_MS + 40 * 86400000).toISOString() }
], { now: NOW_MS, quota: 64, horizonDays: 30 });
eq(beyond.totalEligible, 1, '超出时间视野的任务不注册');
eq(beyond.registered, 1, '视野内的任务正常注册');

const tiny = S.planNativeBatch(makeJobs(5, 1, 60), { now: NOW_MS, quota: 2 });
eq(tiny.usable, 0, '配额小于安全余量时可用额度为 0（宁可晚注册也不打满）');
eq(tiny.registered, 0, '可用额度为 0 时不注册任何任务');
eq(tiny.deferred, 5, '全部推迟，不静默丢弃');

const unsorted = S.planNativeBatch([
  { reminderId: 'late', level: 1, at: new Date(NOW_MS + 7200000).toISOString() },
  { reminderId: 'early', level: 1, at: new Date(NOW_MS + 3600000).toISOString() }
], { now: NOW_MS, quota: 64 });
eq(unsorted.items.map(x => x.reminderId), ['early', 'late'], '输入乱序也会按时间重排');

eq(S.planNativeBatch([], { now: NOW_MS, quota: 64 }).registered, 0, '空任务安全');
eq(S.planNativeBatch(makeJobs(3, 1, 60), { now: NOW_MS }).quota, S.NATIVE_QUOTA.default,
  '未指定配额时使用默认值');

section('【ios / android 配额常量】');
eq(S.NATIVE_QUOTA.ios, 64, 'iOS 待触发本地通知硬上限为 64 条');
ok(S.NATIVE_QUOTA.android > S.NATIVE_QUOTA.ios, 'Android 配额高于 iOS');
eq(S.planNativeBatch(makeJobs(300, 1, 60), { now: NOW_MS, quota: S.NATIVE_QUOTA.ios }).usable, 60,
  'iOS 实际可用 60 条');

/* ========== 汇总 ========== */
console.log('\n' + '─'.repeat(52));
console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
