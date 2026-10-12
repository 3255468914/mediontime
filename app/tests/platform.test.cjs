/**
 * platform.js 单元测试
 * 运行：node tests/platform.test.cjs
 *
 * 覆盖：原生通知 ID 分配（含冲突探测）、闹钟任务编译、权限归一化、
 *       运行时探测、同步幂等性、配额溢出、Doze 节流策略、
 *       精确闹钟授权、可靠性自检。
 *
 * 结构说明：所有用例都通过 group() 串行执行。这样做的原因有两条——
 *   1) Platform 内部缓存了「当前运行时」，并发执行会互相污染；
 *   2) 同步断言与异步断言混排会让日志顺序对不上源码顺序，难维护。
 */
const S = require('../js/scheduler.js');
const P = require('../js/platform.js');

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`); }
}
function ok(cond, name) { eq(!!cond, true, name); }
function has(text, needle, name) { eq(String(text).indexOf(needle) !== -1, true, name); }

let chain = Promise.resolve();
function group(title, fn) {
  chain = chain.then(() => {
    console.log(`\n【${title}】`);
    return Promise.resolve().then(fn).catch(err => {
      fail++; failures.push(title + ' — ' + err.message);
      console.log(`  ✗ ${title}\n      抛出: ${err.message}`);
    });
  });
  return chain;
}

/* ========== 假浏览器 / 假 Capacitor ========== */

function fakeCapacitor(os, opts) {
  opts = opts || {};
  let pending = [];
  const calls = { schedule: 0, cancel: 0, getPending: 0, request: 0, exactSetting: 0, channels: [] };

  const plugin = {
    checkPermissions: () => Promise.resolve({ display: opts.permission || 'granted' }),
    requestPermissions: () => { calls.request++; return Promise.resolve({ display: opts.permission || 'granted' }); },
    getPending: () => {
      calls.getPending++;
      if (opts.rejectGetPending) return Promise.reject(new Error('getPending blocked'));
      return Promise.resolve({ notifications: pending.slice() });
    },
    cancel: (o) => {
      calls.cancel++;
      const ids = ((o && o.notifications) || []).map(n => n.id);
      pending = pending.filter(p => ids.indexOf(p.id) === -1);
      return Promise.resolve();
    },
    schedule: (o) => {
      calls.schedule++;
      if (opts.rejectSchedule) return Promise.reject(new Error('EXACT_ALARM_PERMISSION_DENIED'));
      // clearOnSchedule：模拟「schedule 调用返回成功，但 ROM 随即把闹钟清掉」——
      // 现实对应：划卡片深度清理、一键清理、重启未恢复。此时 applied（账面）
      // 仍会记成功，只有系统侧对账才能暴露。
      if (opts.clearOnSchedule) return Promise.resolve();
      pending = pending.concat(o.notifications);
      return Promise.resolve();
    },
    checkExactNotificationSetting: () => {
      if (opts.rejectExactCheck) return Promise.reject(new Error('unavailable'));
      return Promise.resolve({ exact_alarm: opts.exactAlarm || 'granted' });
    },
    changeExactNotificationSetting: () => { calls.exactSetting++; return Promise.resolve(); },
    createChannel: (c) => { calls.channels.push(c.id); return Promise.resolve(); },
    addListener: () => ({ remove: () => { } })
  };

  return {
    g: {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => os,
        Plugins: { LocalNotifications: plugin }
      }
    },
    calls,
    plugin,
    getPending: () => pending
  };
}

const NOW = new Date(2026, 9, 10, 8, 0).getTime();
function job(i, offsetMin, level) {
  return {
    reminderId: 'r' + i, planId: 'p' + i, level: level || 1,
    at: new Date(NOW + offsetMin * 60000).toISOString(),
    title: '药名' + i, body: '1 片'
  };
}
const describeStub = () => ({ title: '苯磺酸氨氯地平片', body: '1 片 · 餐前' });
const rem = (id, status, schedISO) => ({
  id, planId: 'p_' + id, status, scheduledAt: schedISO, windowMinutes: 120
});
const baseISO = new Date(2026, 9, 10, 7, 0).toISOString();

/* ========== 1. 原生通知 ID ========== */
group('1. 原生通知 ID 分配', () => {
  ok(P.toNativeId('r1|1') > 0, 'ID 为正数');
  ok(P.toNativeId('r1|1') <= P.ID_SPACE, 'ID 落在 int32 正区间内（Android 要求）');
  ok(Number.isInteger(P.toNativeId('r1|1')), 'ID 为整数');
  eq(P.toNativeId('r1|1'), P.toNativeId('r1|1'), '同一输入 → 同一 ID（稳定）');
  ok(P.toNativeId('r1|1') !== P.toNativeId('r1|2'), '不同升级级别 → 不同 ID');
  ok(P.toNativeId('r1|1') !== P.toNativeId('r2|1'), '不同提醒 → 不同 ID');
  eq(P.ID_SPACE, 2147483647, 'ID 上界为 int32 最大值');

  const ids = P.assignNativeIds([job(0, 1), job(1, 61), job(2, 121)]);
  eq(ids.length, 3, '批次内每条都分配了 ID');
  eq(new Set(ids.map(x => x.nativeId)).size, 3, '批次内 ID 互不重复');
  eq(P.assignNativeIds([job(0, 1)]).map(x => x.nativeId), ids.map(x => x.nativeId).slice(0, 1),
    '分配结果幂等（同样输入同样输出）');

  // 注入恒定哈希，强制制造冲突以验证线性探测
  const collide = P.assignNativeIds([job(0, 1), job(1, 61), job(2, 121)], () => 7);
  eq(collide.map(x => x.nativeId), [7, 8, 9], '哈希冲突时线性探测，不互相覆盖');
  eq(new Set(collide.map(x => x.nativeId)).size, 3, '冲突处理后仍互不重复');
  const wrapCollide = P.assignNativeIds([job(0, 1), job(1, 61)], () => P.ID_SPACE);
  eq(new Set(wrapCollide.map(x => x.nativeId)).size, 2, '探测到上界后回绕，不越界');
  ok(wrapCollide.every(x => x.nativeId >= 1 && x.nativeId <= P.ID_SPACE), '回绕后仍落在合法区间');
  eq(collide.reduce((s, x) => s + x.nativeId, 0), 24, '冲突分配结果确定可复现');
});

/* ========== 2. 闹钟任务编译 ========== */
group('2. 闹钟任务编译 buildJobs', () => {
  const jobs = P.buildJobs([
    rem('a', 'pending', baseISO),
    rem('b', 'confirmed', baseISO),
    rem('c', 'cancelled', baseISO),
    rem('d', 'missed', baseISO)
  ], { describe: describeStub });
  eq(jobs.length, 3, '只为 pending 提醒生成任务（默认 L1+L2+L3 三级）');
  eq(jobs.map(j => j.reminderId), ['a', 'a', 'a'], '同一提醒生成三级任务');
  eq(jobs.map(j => j.level), [1, 2, 3], '级别为 L1、L2、L3（L4 归中继、L5 归页面）');
  eq(jobs[0].at, baseISO, 'L1 触发时刻 = 计划服药时刻');
  eq(S.minutesBetween(jobs[0].at, jobs[1].at), 5, 'L2 在 L1 之后 5 分钟（与升级链路一致）');
  eq(S.minutesBetween(jobs[1].at, jobs[2].at), 10, 'L3 在 L2 之后 10 分钟（与升级链路一致）');
  eq(jobs[0].title, '苯磺酸氨氯地平片', 'L1 标题为药名');
  eq(jobs[1].title, '苯磺酸氨氯地平片（请尽快确认）', 'L2 标题带催办后缀');
  eq(jobs[0].body, '1 片 · 餐前', '正文透传');

  eq(P.buildJobs([rem('a', 'pending', baseISO)], { describe: describeStub, levels: [1] }).length, 1,
    'levels 可限定只注册 L1');
  eq(P.buildJobs([rem('a', 'pending', baseISO)], { describe: describeStub, levels: [1, 2] }).length, 2,
    'levels 仍可回退到旧的两级组合');

  const fast = P.buildJobs([rem('a', 'pending', baseISO)], { describe: describeStub, speedFactor: 0.02 });
  eq(S.minutesBetween(fast[0].at, fast[1].at), 0, '演示加速下 L2 间隔同步压缩（与引擎一致）');

  eq(P.buildJobs([rem('a', 'pending', baseISO)])[0].title, '用药提醒',
    '未注入 describe 时使用兜底文案，不抛错');

  const multi = P.buildJobs([
    rem('x', 'pending', new Date(2026, 9, 10, 21, 0).toISOString()),
    rem('y', 'pending', new Date(2026, 9, 10, 7, 0).toISOString())
  ], { describe: describeStub, levels: [1] });
  eq(multi.map(j => j.reminderId), ['y', 'x'], '跨提醒按时间全局排序');
});

/* ========== 3. 权限归一化 ========== */
group('3. 权限状态归一化', () => {
  eq(P.normalizePermission('granted'), 'granted', "Web 'granted'");
  eq(P.normalizePermission('denied'), 'denied', "Web 'denied'");
  eq(P.normalizePermission('default'), 'prompt', "Web 'default' → prompt");
  eq(P.normalizePermission({ display: 'prompt-with-rationale' }), 'prompt', 'Capacitor 理由弹窗 → prompt');
  eq(P.normalizePermission({ display: 'granted' }), 'granted', 'Capacitor 对象形式');
  eq(P.normalizePermission(undefined), 'unknown', '未知输入不误判为已授权');
});

/* ========== 4. 平台能力声明 ========== */
group('4. 平台能力声明', () => {
  const web = P.createWebPlatform({});
  eq(web.id, 'web', 'Web 平台标识');
  eq(web.canScheduleSystemAlarm, false, 'Web 无法注册系统闹钟');
  eq(web.capabilities.survivesAppKill, false, 'Web 应用关闭后失效（如实声明）');
  eq(web.capabilities.survivesReboot, false, 'Web 重启后不恢复');

  const and = P.createNativePlatform(fakeCapacitor('android').g);
  eq(and.id, 'native', '原生平台标识');
  eq(and.canScheduleSystemAlarm, true, '原生可注册系统闹钟');
  eq(and.quota, S.NATIVE_QUOTA.android, 'Android 使用 Android 配额');
  eq(and.capabilities.survivesAppKill, true, 'Android 应用被杀后仍可提醒');
  eq(and.capabilities.survivesReboot, true, 'Android 重启后自动恢复');

  const ios = P.createNativePlatform(fakeCapacitor('ios').g);
  eq(ios.quota, 64, 'iOS 使用 64 条硬上限');
  eq(ios.capabilities.survivesReboot, false, 'iOS 无需开机广播（由系统持久化）');
});

/* ========== 5. 运行时探测 ========== */
group('5. 运行时探测', () => {
  eq(P.resolve({}, true).id, 'web', '无 Capacitor 时解析为 Web');
  eq(P.resolve({ Capacitor: { isNativePlatform: () => false } }, true).id, 'web',
    'Capacitor Web 运行时仍按 Web 处理');
  eq(P.resolve(fakeCapacitor('android').g, true).id, 'native', '原生容器解析为 native');
  const first = P.resolve({}, true);
  eq(P.resolve({}), first, '二次解析返回同一对象（缓存生效）');
});

/* ========== 6. Web 平台同步 ========== */
group('6. 同步 —— Web 平台', () => {
  return P.resolve({}, true)
    .sync([job(0, 1), job(1, 61), job(2, 121)], { now: NOW })
    .then(r => {
      eq(r.supported, false, 'Web 不声明支持系统闹钟');
      eq(r.applied, 0, 'Web 不注册任何系统闹钟');
      eq(r.mode, 'in-page', 'Web 由页面内定时器投递');
      eq(r.registered, 3, '仍返回本应注册的计划，供 UI 展示差距');
    })
    .then(() => P.createWebPlatform({
      Notification: { permission: 'default', requestPermission: () => Promise.resolve('granted') }
    }).requestPermission())
    .then(s => eq(s, 'granted', 'Web 权限授权成功'))
    .then(() => {
      const p = P.createWebPlatform({});
      return Promise.all([p.permissionState(), p.requestPermission()]);
    })
    .then(([a, b]) => {
      eq(a, 'unsupported', '无 Notification 时状态为 unsupported');
      eq(b, 'unsupported', '请求权限也返回 unsupported，不抛出');
    });
});

/* ========== 7. 原生平台同步 ========== */
group('7. 同步 —— 原生平台', () => {
  const fake = fakeCapacitor('android');
  return P.resolve(fake.g, true)
    .sync([job(0, 1), job(1, 61), job(2, 121)], { now: NOW })
    .then(r => {
      eq(r.supported, true, '原生声明支持系统闹钟');
      eq(r.mode, 'exact-alarm', '投递方式为系统精确闹钟');
      eq(r.applied, 3, '三条任务全部注册');
      eq(fake.calls.schedule, 1, '调用了原生 schedule');
      const got = fake.getPending();
      eq(got.length, 3, '系统待触发队列中有 3 条');
      ok(got.every(n => n.schedule && n.schedule.allowWhileIdle === true),
        '本批次全为 L1，全部带 Doze 豁免');
      ok(got.every(n => Number.isInteger(n.id) && n.id > 0), '通知 ID 为正整数');
      ok(got.every(n => n.extra && n.extra.reminderId), '携带 extra，点击后可回到对应提醒');
      eq(got.map(n => n.channelId), ['med-normal', 'med-normal', 'med-normal'], 'L1 使用普通渠道');
      ok(got.every(n => n.autoCancel === true), '点击后自动清除通知');
    });
});

group('8. 投递渠道与 Doze 节流', () => {
  const fake = fakeCapacitor('android');
  return P.resolve(fake.g, true)
    .sync([job(0, 1, 1), job(0, 1, 2), job(1, 61, 1), job(1, 61, 2)], { now: NOW })
    .then(() => {
      const byLevel = {};
      fake.getPending().forEach(n => { byLevel[n.extra.level] = { ch: n.channelId, idle: n.schedule.allowWhileIdle }; });
      eq(byLevel[2].ch, 'med-alert', 'L2 走 med-alert 高优先级渠道');
      eq(byLevel[1].ch, 'med-normal', 'L1 走普通渠道');
      eq(byLevel[1].idle, true, 'L1 获得 Doze 豁免');
      eq(byLevel[2].idle, false, 'L2 让出 Doze 配额');
    });
});

group('9. Doze 节流策略（常数与依据）', () => {
  eq(P.DOZE_MIN_INTERVAL_MINUTES, 9, '记录官方文档给出的 9 分钟节流阈值');
  eq(P.allowWhileIdleFor(1), true, 'L1（必须准时）带 allowWhileIdle');
  eq(P.allowWhileIdleFor(2), false, 'L2 不带 allowWhileIdle，不占用 Doze 配额');
  eq(P.allowWhileIdleFor(3), false, 'L3 不带 allowWhileIdle');
  eq(P.allowWhileIdleFor(4), false, 'L4 不带 allowWhileIdle');
  const esc = S.buildEscalation(new Date(NOW).toISOString(), 120);
  ok(S.minutesBetween(esc[0].at, esc[1].at) < P.DOZE_MIN_INTERVAL_MINUTES,
    'L1→L2 间隔（5 分钟）小于节流阈值，这正是只能给 L1 豁免的原因');
});

group('10. 同步幂等与收敛', () => {
  const fake = fakeCapacitor('android');
  const p = P.resolve(fake.g, true);
  return p.sync([job(0, 1), job(1, 61)], { now: NOW })
    .then(() => p.sync([job(0, 1), job(1, 61)], { now: NOW }))
    .then(() => p.sync([job(0, 1), job(1, 61)], { now: NOW }))
    .then(() => {
      eq(fake.getPending().length, 2, '三次同步后系统队列仍只有 2 条');
      ok(fake.calls.cancel >= 2, '每次同步都先撤销上一批（全量重建）');
      eq(new Set(fake.getPending().map(n => n.id)).size, 2, '队列内 ID 无重复');
    })
    .then(() => p.sync([job(0, 1), job(1, 61), job(2, 121)], { now: NOW }))
    .then(() => p.sync([job(0, 1)], { now: NOW }))
    .then(() => {
      eq(fake.getPending().length, 1, '停用计划后系统里不留残余闹钟');
      eq(fake.getPending()[0].extra.reminderId, 'r0', '保留的是仍然有效的提醒');
    });
});

group('11. 配额溢出与失败上报', () => {
  const ios = fakeCapacitor('ios');
  const many = Array.from({ length: 200 }, (_, i) => job(i, 1 + i * 60));
  return P.resolve(ios.g, true).sync(many, { now: NOW })
    .then(r => {
      eq(r.registered, 60, 'iOS 只注册 60 条');
      eq(r.deferred, 140, '其余 140 条标记为推迟');
      eq(r.overflow, true, '溢出标志置位，供 UI 提示用户');
      eq(ios.getPending().length, 60, '系统队列中恰好 60 条，未超出硬上限');
      ok(new Date(r.horizonEnd).getTime() > NOW, '给出已覆盖到的时间点，便于提示刷新时机');
    })
    .then(() => {
      const bad = fakeCapacitor('android', { rejectSchedule: true });
      return P.resolve(bad.g, true).sync([job(0, 1)], { now: NOW });
    })
    .then(r => {
      eq(r.applied, 0, '注册失败时不谎报已注册');
      ok(/EXACT_ALARM/.test(r.error), '错误原因透传给上层');
    })
    .then(() => {
      const f = fakeCapacitor('android');
      const p = P.resolve(f.g, true);
      return p.sync([job(0, 1), job(1, 61)], { now: NOW })
        .then(() => p.cancelAll())
        .then(n => {
          eq(n, 2, '撤销返回撤销条数');
          eq(f.getPending().length, 0, '系统队列被清空');
        });
    });
});

/* ========== 12. 精确闹钟授权 ========== */
group('12. 精确闹钟授权（Android 12+）', () => {
  return P.resolve(fakeCapacitor('android', { exactAlarm: 'granted' }).g, true).exactAlarmState()
    .then(s => eq(s, 'granted', '已授权时返回 granted'))
    .then(() => P.resolve(fakeCapacitor('android', { exactAlarm: 'denied' }).g, true).exactAlarmState())
    .then(s => eq(s, 'denied', '被关闭时返回 denied'))
    .then(() => P.resolve(fakeCapacitor('android', { rejectExactCheck: true }).g, true).exactAlarmState())
    .then(s => eq(s, 'unknown', '查询失败时返回 unknown，不谎报已授权'))
    .then(() => P.resolve(fakeCapacitor('ios').g, true).exactAlarmState())
    .then(s => eq(s, 'unsupported', 'iOS 无此概念，返回 unsupported'))
    .then(() => P.createWebPlatform({}).exactAlarmState())
    .then(s => eq(s, 'unsupported', 'Web 同样返回 unsupported'))
    .then(() => {
      const g = fakeCapacitor('android').g;
      delete g.Capacitor.Plugins.LocalNotifications.checkExactNotificationSetting;
      return P.resolve(g, true).exactAlarmState();
    })
    .then(s => eq(s, 'unknown', '旧版插件缺少接口时保守返回 unknown'))
    .then(() => {
      const f = fakeCapacitor('android');
      return P.resolve(f.g, true).openExactAlarmSetting().then(okd => {
        eq(okd, true, '可跳转系统设置开启精确闹钟');
        eq(f.calls.exactSetting, 1, '确实调用了跳转接口');
      });
    });
});

group('13. 通知渠道（Android）', () => {
  eq(P.CHANNELS.map(c => c.id), ['med-normal', 'med-alert'], '定义了两个渠道');
  eq(P.CHANNELS.find(c => c.id === 'med-normal').importance, 4,
    'L1 渠道 importance=4（HIGH），否则不会横幅弹出');
  eq(P.CHANNELS.find(c => c.id === 'med-alert').importance, 5,
    'L2 渠道 importance=5（MAX），催办更强');
  ok(P.CHANNELS.every(c => c.importance >= 4), '所有渠道都不低于 HIGH（默认渠道会静默进通知栏）');

  const fake = fakeCapacitor('android');
  return P.resolve(fake.g, true).sync([job(0, 1)], { now: NOW }).then(() => {
    eq(fake.calls.channels.sort(), ['med-alert', 'med-normal'], '注册提醒前先建好两个渠道');
  }).then(() => {
    const web = P.createWebPlatform({});
    return web.ensureChannels().then(r => eq(r, false, 'Web 平台无渠道概念，安全返回 false'));
  });
});

/* ========== 14. 通知点击回传 ========== */
group('14. 通知点击回传', () => {
  const fake = fakeCapacitor('android');
  let received = null;
  const orig = fake.plugin.addListener;
  fake.plugin.addListener = (evt, cb) => { received = cb; return orig(evt, cb); };
  const p = P.resolve(fake.g, true);
  const off = p.onNotificationTap(extra => { p.lastExtra = extra; });
  ok(typeof off === 'function', '返回解绑函数');
  if (received) {
    received({ notification: { extra: { reminderId: 'r9', level: 2 } } });
    eq(p.lastExtra && p.lastExtra.reminderId, 'r9', '点击通知能拿到对应提醒 ID');
    eq(p.lastExtra.level, 2, '同时带回级别信息');
  } else {
    ok(false, '注册了 localNotificationActionPerformed 监听');
  }
});

group('15. Web 无监听能力时不崩', () => {
  const off = P.createWebPlatform({}).onNotificationTap(() => { });
  eq(typeof off, 'function', 'Web 平台返回空解绑函数，不抛错');
});

/* ========== 15. 可靠性自检 ========== */
group('16. 可靠性自检 —— Web', () => {
  P.resolve({}, true);                              // 先切到 Web 运行时，再取诊断结果
  const d = P.diagnose({ permission: 'granted' });
  eq(d.platform, 'web', '识别为 Web 平台');
  eq(d.reliable, false, 'Web 平台判定为不可靠（这是事实，不能粉饰）');
  eq(d.checks.find(c => c.key === 'system-alarm').level, 'bad', '「系统级闹钟」不通过');
  eq(d.checks.find(c => c.key === 'app-kill').level, 'bad', '「应用被关闭后仍能提醒」不通过');
  ok(d.checks.every(c => c.key !== 'exact-alarm-setting'), 'Web 平台不出现精确闹钟项');
  ok(d.checks.every(c => c.key !== 'doze'), 'Web 平台不出现 Doze 项（无系统调度）');
  has(d.note, '浏览器', '给出限制说明');
});

group('17. 可靠性自检 —— Android', () => {
  P.resolve(fakeCapacitor('android').g, true);
  const d = P.diagnose({ permission: 'granted', exactAlarm: 'granted' });
  eq(d.reliable, true, 'Android 原生判定为可靠');
  eq(d.checks.filter(c => c.level === 'bad').length, 0, 'Android 原生没有不通过项');
  eq(d.quota, S.NATIVE_QUOTA.android, '带出配额信息');
  eq(d.dozeIntervalMinutes, 9, '带出 Doze 节流阈值');
  eq(d.checks.find(c => c.key === 'exact-alarm-setting').level, 'ok', '精确闹钟已授权时为通过');
  ok(!!d.checks.find(c => c.key === 'doze'), '包含 Doze 送达说明项');

  const denied = P.diagnose({ permission: 'granted', exactAlarm: 'denied' });
  eq(denied.reliable, false, '精确闹钟被关闭时整体不可靠');
  eq(denied.checks.find(c => c.key === 'exact-alarm-setting').level, 'bad', '精确闹钟关闭判定为不通过');
  has(denied.checks.find(c => c.key === 'exact-alarm-setting').detail, '未授权', '给出可操作的原因说明');

  const unknown = P.diagnose({ permission: 'granted' });
  eq(unknown.checks.find(c => c.key === 'exact-alarm-setting').level, 'warn', '无法确认时标记为待核查');
});

group('18. 可靠性自检 —— iOS 与权限缺失', () => {
  P.resolve(fakeCapacitor('ios').g, true);
  const ios = P.diagnose({ permission: 'granted', exactAlarm: 'granted' });
  ok(ios.checks.every(c => c.key !== 'exact-alarm-setting'), 'iOS 无精确闹钟概念，不出现该项');
  ok(!!ios.checks.find(c => c.key === 'doze'), 'iOS 仍需提示省电模式影响');
  eq(ios.reliable, true, 'iOS 权限齐备时判定为可靠');

  P.resolve(fakeCapacitor('android').g, true);
  const prompt = P.diagnose({ permission: 'prompt' });
  eq(prompt.reliable, false, '未授权时整体不可靠');
  eq(prompt.checks[0].key, 'permission', '未授权项排在首位');
  eq(prompt.checks[0].level, 'bad', '未授权即为不通过（对用药提醒而言是致命的）');
  eq(P.diagnose({ permission: 'denied' }).reliable, false, '被拒绝时整体不可靠');
  has(P.diagnose({ permission: 'denied' }).checks[0].detail, '系统设置', '被拒绝时提示去系统设置开启');
  eq(P.diagnose({ permission: 'unsupported' }).checks[0].level, 'bad', '环境不支持时标记为不通过');
  eq(P.diagnose({}).reliable, false, '完全未知权限时保守判定为不可靠');
});

group('19. 系统侧对账（systemCount）——「已托管」不许说谎', () => {
  // 背景：registered/applied 是 App 自己的记账（交了几条），不代表系统里真有。
  // ROM 深度清理、重启未恢复、系统删闹钟都会造成账实分离。
  // 同步结束后必须从系统读回真实数量，UI 才有资格说「已托管」。

  const a = fakeCapacitor('android');
  return P.resolve(a.g, true)
    .sync([job(0, 1), job(1, 61)], { now: NOW })
    .then(r => {
      eq(r.supported, true, '前提：原生同步成功');
      eq(r.applied, 2, '账面注册 2 条');
      eq(r.systemCount, 2, '系统侧读回 2 条，账实相符');
    })
    .then(() => {
      // 场景一：schedule 返回成功但闹钟随即被 ROM 清掉（划卡片深度清理等）
      const b = fakeCapacitor('android', { clearOnSchedule: true });
      return P.resolve(b.g, true)
        .sync([job(0, 1), job(1, 61)], { now: NOW })
        .then(r => {
          eq(r.applied, 2, '场景一：账面仍记 2 条（调用本身返回成功）');
          eq(r.systemCount, 0, '场景一：系统侧读回 0 条——账实分离被如实暴露');
          ok(r.systemCount < r.applied, '场景一：systemCount < applied，上层据此亮红灯');
        });
    })
    .then(() => {
      // 场景二：读回调用本身失败（ROM 限制桥接查询）——只能记「未知」
      const c = fakeCapacitor('android', { rejectGetPending: true });
      return P.resolve(c.g, true)
        .sync([job(0, 1)], { now: NOW })
        .then(r => {
          eq(r.applied, 1, '场景二：账面注册 1 条');
          eq(r.systemCount, null, '场景二：读回失败记 null（未知），不许编造成功或失败');
        });
    })
    .then(() => {
      // 场景三：Web 平台没有系统闹钟，systemCount 恒为 null（未知），不得声称已托管
      P.resolve({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }, true);
      return P.resolve({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }, true)
        .sync([job(0, 1)], { now: NOW })
        .then(r => {
          eq(r.supported, false, '场景三：Web 平台不支持系统闹钟');
          eq(r.systemCount, null, '场景三：systemCount 为 null，不产生虚假对账数');
        });
    });
});

group('20. L3 纳入系统托管 —— 催办链到 L2 之后不再静默', () => {
  // 背景：原先系统只托管 L1/L2，L2（+5 分钟）之后到用户主动打开应用之前
  // 没有任何系统提示——而真正需要"催"的恰是这一段。L3（+15 分钟强催办）
  // 现在也交给系统：不带 allowWhileIdle，允许 Doze 推迟到维护窗口，
  // 不会挤占 L1 的每 9 分钟一次的准时额度。
  eq(P.allowWhileIdleFor(1), true, 'L1 保持 allowWhileIdle（必须准时的那一级）');
  eq(P.allowWhileIdleFor(2), false, 'L2 不带 allowWhileIdle');
  eq(P.allowWhileIdleFor(3), false, 'L3 同样不带（+15 分钟在 9 分钟节流窗之外，推迟到维护窗口即可）');

  const jobs = P.buildJobs([rem('a', 'pending', baseISO)], { describe: describeStub });
  const l1 = jobs.find(j => j.level === 1);
  const l2 = jobs.find(j => j.level === 2);
  const l3 = jobs.find(j => j.level === 3);
  ok(l1 && l2 && l3, '默认批次同时包含 L1/L2/L3 三级');
  eq(S.minutesBetween(baseISO, l3.at), 15, 'L3 在计划时刻之后 15 分钟（与升级链路一致）');
  ok(l3.title.indexOf('请尽快确认') !== -1, 'L3 标题带催办后缀（走「用药催办」渠道）');
});

/* ========== 汇总 ========== */
chain.then(() => {
  console.log('\n' + '─'.repeat(52));
  console.log(`总计 ${pass + fail} 项  |  通过 ${pass}  |  失败 ${fail}`);
  if (fail) { console.log('\n失败用例：'); failures.forEach(f => console.log('  · ' + f)); }
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
});
