/*!
 * reminder.js — 提醒调度引擎
 *
 * 设计要点：
 *  - 等级按「当前时间反推」而非依赖定时器累加，因此刷新页面 / 重新打开后
 *    仍能落在正确的升级阶段，不会漏级或重放。
 *  - 每条提醒的升级链由 Scheduler.buildEscalation 统一生成，保证与单元测试一致。
 *  - 轮询是自适应的：算出「下一个该做事的时刻」睡到那一刻，另设兜底上限
 *    （临近事件 30 秒 / 空闲 5 分钟）。正因为等级是按时间反推的，
 *    醒得晚不会出错、只会把该做的补上——这是敢把轮询拉长的前提。详见下方「自适应唤醒」。
 *  - 浏览器关闭后无法提醒，这是 PWA 的固有限制，真机后台提醒需原生能力（见 README）。
 */
(function (global) {
  'use strict';

  var S = global.Scheduler;
  var Store = global.Store;

  // 演示加速倍率：开启后 1 分钟压缩为约 1.2 秒，便于在几十秒内看完整条 L1→L5
  var DEMO_SPEED = 0.02;

  var timer = null;
  var notified = {};
  var cb = {};
  var audioCtx = null;

  function speed() { return Store.state.user.demoFast ? DEMO_SPEED : 1; }

  /* ---------- 权限 ---------- */

  function notificationState() {
    if (!('Notification' in global)) return 'unsupported';
    return global.Notification.permission;   // granted | denied | default
  }

  function requestPermission() {
    if (!('Notification' in global)) return Promise.resolve('unsupported');
    if (global.Notification.permission !== 'default') return Promise.resolve(global.Notification.permission);
    return global.Notification.requestPermission();
  }

  /* ---------- 声音与震动 ---------- */

  function beep(level) {
    if (!Store.state.user.channels.sound) return;
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var ctx = audioCtx;
      var count = level >= 3 ? 3 : (level === 2 ? 2 : 1);
      for (var i = 0; i < count; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = level >= 2 ? 880 : 660;
        var t0 = ctx.currentTime + i * 0.36;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(level >= 2 ? 0.22 : 0.13, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.32);
      }
    } catch (e) { /* 浏览器未解锁音频则静默 */ }
  }

  function vibrate(level) {
    if (!Store.state.user.channels.vibrate) return;
    if (!global.navigator || !global.navigator.vibrate) return;
    try {
      if (level === 1) global.navigator.vibrate(150);
      else if (level === 2) global.navigator.vibrate([220, 120, 220]);
      else global.navigator.vibrate([320, 140, 320, 140, 320]);
    } catch (e) { /* 桌面端不支持震动 */ }
  }

  /* ---------- 通知 ---------- */

  function describe(reminder) {
    var plan = Store.getPlan(reminder.planId);
    var med = plan ? Store.getMedicine(plan.medicineId) : null;
    var hide = Store.state.user.hideDrugName;
    if (hide) {
      return { title: '用药提醒时间到', body: '请打开应用查看详情', med: null, plan: plan };
    }
    return {
      title: med ? med.name : '用药提醒',
      body: plan
        ? (plan.doseAmount + ' ' + plan.doseUnit + (plan.mealLabel ? ' · ' + plan.mealLabel : ''))
        : '该服药了',
      med: med, plan: plan
    };
  }

  function notify(reminder, level) {
    if (!Store.state.user.channels.notification) return;
    if (notificationState() !== 'granted') return;
    var key = reminder.id + '|' + level;
    if (notified[key]) return;              // 防止重复弹同一条
    notified[key] = 1;

    var d = describe(reminder);
    var suffix = level >= 2 ? '（请尽快确认）' : '';
    try {
      var n = new global.Notification(d.title + suffix, {
        body: d.body,
        tag: reminder.id,
        requireInteraction: level >= 2,
        silent: false
      });
      n.onclick = function () {
        try { global.focus(); } catch (e) { }
        if (cb.onOpen) cb.onOpen(reminder);
        n.close();
      };
      setTimeout(function () { try { n.close(); } catch (e) { } }, level >= 2 ? 60000 : 12000);
    } catch (e) { /* 部分浏览器要求用户手势后才允许 */ }
  }

  function notifyCaregiver(reminder) {
    if (!Store.state.user.channels.caregiver) return;

    /* 这里**不能**拿本地的 caregivers 列表当作"有人会收到"的依据。
     * 家属是在另一台设备上凭邀请码向中继 claim 之后才算绑上的，
     * 本机没有任何办法知道有谁、有几位——本地方便存的那份列表天然是空的。
     *
     * 旧版本在这里写了 `if (!list.length) return;`，再加上种子数据里那条
     * 写死的「女儿 · 小张」，于是 `list.length` 永远 ≥ 1：这条分支看起来
     * 一直"工作正常"，实际发出去的却是一句空话（见 docs/04 §4.8 P8-32）。
     *
     * 唯一有依据的判断是"用户开启了家属通道"；真送到没送到，交给中继回报。
     *
     * **回调只传 reminder**（P9-36）：早先这里还传了 `describe(reminder)`，
     * 那是个装着药名与剂量的对象。把它递进"要发到另一台设备"的回调里，
     * 就是在源头上给泄漏留了一条路——下游只要顺手用一下，隐私承诺就破了。
     * 送出去的内容由 app.js 里的白名单构造器决定，这里不提供任何药名。 */
    if (cb.onCaregiverAlert) cb.onCaregiverAlert(reminder);
  }

  /* ---------- 核心：等级反推 ---------- */

  function computeEscalation(reminder) {
    var plan = Store.getPlan(reminder.planId);
    var win = reminder.windowMinutes || (plan ? plan.windowMinutes : 120) || 120;
    return S.buildEscalation(reminder.scheduledAt, win, speed());
  }

  var TITLES = ['初次提醒', '加大音量与震动', '全屏强提醒', '通知家属', '标记漏服'];

  function fireLevel(reminder, level, esc) {
    var step = esc.filter(function (e) { return e.level === level; })[0] || { level: level, key: 'L' + level };
    if (cb.onLevel) cb.onLevel(reminder, step, describe(reminder));

    switch (level) {
      case 1:
        notify(reminder, 1); beep(1); vibrate(1);
        break;
      case 2:
        notify(reminder, 2); beep(2); vibrate(2);
        break;
      case 3:
        notify(reminder, 3); beep(3); vibrate(3);
        if (Store.state.user.channels.fullscreen && cb.onFullscreen) cb.onFullscreen(reminder, describe(reminder));
        break;
      case 4:
        notifyCaregiver(reminder);
        break;
      case 5:
        break;   // 由 markMissed 分支处理
    }
  }

  function tick() {
    var st = Store.state;
    if (!st) return;
    var now = Date.now();
    var spd = speed();
    var changed = false;

    st.reminders.forEach(function (r) {
      if (r.status !== 'pending') return;
      var sched = new Date(r.scheduledAt).getTime();
      if (sched > now) return;

      var esc = computeEscalation(r);
      var windowMs = (r.windowMinutes || 120) * 60000 * spd;
      var overdue = now - sched;

      // 严重逾期（远超窗口）：直接补记漏服，不重放全屏提醒，避免打开应用被刷屏
      if (overdue > windowMs + 60000) {
        if (r.level < 5) {
          Store.markMissed(r);
          changed = true;
        }
        return;
      }

      // 按时间反推当前应处于的等级
      var level = 0;
      for (var i = 0; i < esc.length; i++) {
        if (new Date(esc[i].at).getTime() <= now) level = esc[i].level;
      }

      if (level > (r.level || 0)) {
        for (var L = (r.level || 0) + 1; L <= level; L++) {
          if (L > 5) break;
          if (L < 5) fireLevel(r, L, esc);
        }
        r.level = Math.min(level, 5);
        changed = true;
      }

      // 到达 L5：标记漏服并进入补救流程
      if (level >= 5 && r.status === 'pending') {
        var log = Store.markMissed(r);
        changed = true;
        if (cb.onMissed) cb.onMissed(r, log);
      }
    });

    if (changed) Store.save();
  }

  /* ---------- 生命周期：自适应唤醒（省电） ----------
   *
   * 早先这里是 setInterval(tick, 1000)：每秒醒一次，每次遍历全部提醒。
   * 一条 90 天 × 每日 3 次的计划就是 270 条，多药并用上千条，
   * 于是应用即使闲置，每秒也在做几百次 Date 解析——对手机是白白的耗电。
   *
   * 之所以敢把轮询拉长，是因为本引擎的等级是「按当前时间反推」的：
   * 醒得晚了不会漏级、不会重放，只会把该做的补上。
   * 换句话说，**正确性不依赖醒得多勤**，这正是能用自适应唤醒的前提。
   *
   * 策略：算出「下一个该做事的时刻」，睡到那一刻再醒；
   * 另设一个兜底上限，防止用户改系统时间 / 时钟跳变 / 休眠恢复导致睡过头。
   */

  var LEAD_MS = 40;              // 提前一点醒，避免踩在边界上刚好差几毫秒
  var CEIL_NEAR = 30 * 1000;     // 临近事件（≤10 分钟）时的兜底上限
  var CEIL_IDLE = 5 * 60 * 1000; // 无临近事件时的兜底上限
  var NEAR_MS = 10 * 60 * 1000;

  var lastDelay = null;          // 最近一次实际排定的等待毫秒数（供测试与自检观察）

  /** 下一个「需要做事」的时刻；没有则返回 null。 */
  function nextEventAt(now) {
    var st = Store.state;
    if (!st || !st.reminders) return null;

    var spd = speed();
    var best = null;
    function consider(t) { if (t != null && (best === null || t < best)) best = t; }

    st.reminders.forEach(function (r) {
      if (r.status !== 'pending') return;
      var sched = new Date(r.scheduledAt).getTime();

      if (sched > now) { consider(sched); return; }

      // 已到点：下一个事件是升级链里还没到的那一级
      var esc = computeEscalation(r);
      for (var i = 0; i < esc.length; i++) {
        var at = new Date(esc[i].at).getTime();
        if (at > now) { consider(at); break; }
      }

      // 升级链走完仍未确认：还要在「严重逾期」边界醒一次去补记漏服。
      // 故意不加 t > now 判断：若该边界已经过去，说明此刻就该结算，
      // 于是 nextDelay 返回一个极小的值 → 立即唤醒一次 → tick() 当场标记漏服
      // → 该提醒不再是 pending → 下一轮就不会再安排它，因此不会空转。
      var windowMs = (r.windowMinutes || 120) * 60000 * spd;
      consider(sched + windowMs + 60001);
    });

    return best;
  }

  /** 下一次应等待的毫秒数（已含兜底上限）。 */
  function nextDelay(now) {
    if (now == null) now = Date.now();
    var at = nextEventAt(now);
    if (at === null) return CEIL_IDLE;

    var wait = at - now;
    if (wait <= 0) return LEAD_MS;

    var cap = wait <= NEAR_MS ? CEIL_NEAR : CEIL_IDLE;
    return Math.min(wait + LEAD_MS, cap);
  }

  function scheduleNext() {
    if (timer) { clearTimeout(timer); timer = null; }
    lastDelay = nextDelay();
    timer = setTimeout(function () {
      timer = null;
      tick();
      scheduleNext();
    }, lastDelay);
  }

  function start() {
    stop();
    tick();            // 立即执行一次（补偿刷新期间错过的时间）
    scheduleNext();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    lastDelay = null;
  }

  /** 排程发生变化（新增药品 / 改处方 / 换时区 / 改演示加速）后立刻重排唤醒时刻。
   *  不调用也不会出错，只是可能要等到兜底上限才响应——但「新加的药 2 分钟后该吃」
   *  这类情况必须立刻响应，所以各改动入口都应主动调一次。 */
  function reschedule() {
    tick();
    scheduleNext();
  }

  function isRunning() { return timer !== null; }

  function setCallbacks(c) {
    cb = Object.assign({}, cb, c);
  }

  /** 演示用：立刻对某条待触发提醒触发一次 L1 */
  function testFire(reminderId) {
    var r = Store.findReminderById(reminderId);
    if (!r || r.status !== 'pending') return null;
    var esc = computeEscalation(r);
    fireLevel(r, 1, esc);
    r.level = 1;
    r.fireAt = new Date().toISOString();
    Store.save();
    return r;
  }

  /** 找出最近一条待触发提醒 */
  function nextPending() {
    var now = Date.now();
    var list = Store.state.reminders
      .filter(function (r) { return r.status === 'pending' && new Date(r.scheduledAt).getTime() > now; })
      .sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });
    return list[0] || null;
  }

  /** 取今天所有提醒（含已确认/漏服），用于首页时间轴 */
  function todayReminders() {
    var key = S.dateKey(new Date());
    return Store.state.reminders
      .filter(function (r) {
        var p = Store.getPlan(r.planId);
        if (!p) return false;
        return S.dateKey(new Date(r.scheduledAt)) === key && r.status !== 'cancelled';
      })
      .sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });
  }

  function pendingCount() {
    return Store.state.reminders.filter(function (r) { return r.status === 'pending'; }).length;
  }

  global.ReminderEngine = {
    start: start, stop: stop, tick: tick, setCallbacks: setCallbacks,
    reschedule: reschedule, isRunning: isRunning,
    nextEventAt: nextEventAt, nextDelay: nextDelay,
    lastDelay: function () { return lastDelay; },
    requestPermission: requestPermission, notificationState: notificationState,
    testFire: testFire, nextPending: nextPending, todayReminders: todayReminders,
    pendingCount: pendingCount, describe: describe, computeEscalation: computeEscalation,
    TITLES: TITLES, DEMO_SPEED: DEMO_SPEED,
    TIMING: { LEAD_MS: LEAD_MS, CEIL_NEAR: CEIL_NEAR, CEIL_IDLE: CEIL_IDLE, NEAR_MS: NEAR_MS }
  };
})(window);
