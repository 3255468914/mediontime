/*!
 * store.js — 数据存储层
 * MVP 使用 localStorage 单键 JSON 存储，字段命名与 docs/02 的 SQL 表一一对应，
 * 便于后续平移到 SQLite（只需替换 load/save 与加一个 toSqlRow 适配层）。
 */
(function (global) {
  'use strict';

  var S = global.Scheduler;
  var KEY = 'mediontime.state.v1';

  var state = null;

  /* ---------- 工具 ---------- */

  function uuid(prefix) {
    var rnd;
    if (global.crypto && global.crypto.randomUUID) rnd = global.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    else rnd = Math.random().toString(36).slice(2, 14);
    return (prefix || 'id') + '_' + rnd;
  }
  function nowIso() { return new Date().toISOString(); }

  /* ---------- 默认状态 ---------- */

  function defaultUser() {
    return {
      id: 'u_local',
      nickname: '我',
      role: 'self',
      elderMode: false,
      hideDrugName: false,
      consentAccepted: false,
      voiceEnabled: true,
      windowMinutes: 120,
      safetyGapMinutes: 120,
      channels: { notification: true, sound: true, vibrate: true, fullscreen: true, caregiver: true },
      timezone: 'UTC' + (new Date().getTimezoneOffset() <= 0 ? '+' : '-') +
        S.pad2(Math.floor(Math.abs(new Date().getTimezoneOffset()) / 60)),
      tzPolicy: S.TZ_POLICY.FOLLOW_LOCAL,
      tzUpdatedAt: null,
      demoFast: false,
      /* 家属协同中继：默认全部为空 = 一个请求都不发。
         这是刻意的默认值——「不收集、不上传、全本地」是给用户的承诺，
         只有用户自己填了服务器地址，才会有数据离开这台设备。 */
      relay: { url: '', code: '', patientToken: '', pairedAt: null, lastDelivery: null, boundCount: 0 },
      createdAt: nowIso()
    };
  }

  function blankState() {
    return {
      version: 1,
      user: defaultUser(),
      medicines: [],
      plans: [],
      reminders: [],
      logs: [],
      caregivers: []
    };
  }

  /* ---------- 种子数据（首次打开时生成，便于立即体验） ---------- */

  function seed() {
    var st = blankState();
    var now = new Date();
    var iso = nowIso();
    var today = S.dateKey(now);

    st.medicines = [
      { id: 'm_aml', name: '苯磺酸氨氯地平片', specification: '5mg × 7 片/盒', dosageForm: 'tablet', strength: '5mg', note: '血压高时服用', stockAmount: 21, isArchived: false, createdAt: iso, updatedAt: iso },
      { id: 'm_met', name: '二甲双胍缓释片', specification: '0.5g × 30 片/盒', dosageForm: 'tablet', strength: '0.5g', note: '随餐服用可减少胃部不适', stockAmount: 5, isArchived: false, createdAt: iso, updatedAt: iso },
      { id: 'm_ator', name: '阿托伐他汀钙片', specification: '20mg × 7 片/盒', dosageForm: 'tablet', strength: '20mg', note: '', stockAmount: 14, isArchived: false, createdAt: iso, updatedAt: iso }
    ];

    st.plans = [
      {
        id: 'p_aml', medicineId: 'm_aml', doseAmount: 1, doseUnit: '片',
        frequencyType: 'daily', anchorType: 'absolute',
        mealRelation: 'before_meal', mealLabel: '餐前 30 分钟',
        times: ['07:00'], startDate: today, endDate: null, isLongTerm: true, isActive: true,
        windowMinutes: 120, safetyGapMinutes: 120, createdAt: iso
      },
      {
        id: 'p_met', medicineId: 'm_met', doseAmount: 1, doseUnit: '片',
        frequencyType: 'daily', anchorType: 'absolute',
        mealRelation: 'with_meal', mealLabel: '餐中',
        times: ['12:00', '18:00'], startDate: today, endDate: null, isLongTerm: true, isActive: true,
        windowMinutes: 120, safetyGapMinutes: 120, createdAt: iso
      },
      {
        id: 'p_ator', medicineId: 'm_ator', doseAmount: 1, doseUnit: '片',
        frequencyType: 'daily', anchorType: 'absolute',
        mealRelation: 'bedtime', mealLabel: '睡前',
        times: ['21:00'], startDate: today, endDate: null, isLongTerm: true, isActive: true,
        windowMinutes: 120, safetyGapMinutes: 120, createdAt: iso
      }
    ];

    // 为「今天已经过去的时间点」补建历史记录，让首页时间轴立刻有内容
    var todaySlots = [
      { planId: 'p_aml', time: '07:00', outcome: 'on_time', delay: 4 },
      { planId: 'p_met', time: '12:00', outcome: 'delayed', delay: 41 },
      { planId: 'p_met', time: '18:00', outcome: 'missed', delay: null },
      { planId: 'p_ator', time: '21:00', outcome: 'pending', delay: null }
    ];

    todaySlots.forEach(function (slot) {
      var at = S.combineDateTime(today, slot.time);
      if (at.getTime() > now.getTime()) return;                 // 未来时间点不补历史
      if (slot.outcome === 'pending') return;

      var plan = st.plans.filter(function (p) { return p.id === slot.planId; })[0];
      var actual = slot.delay == null ? null : new Date(at.getTime() + slot.delay * 60000);

      st.reminders.push({
        id: uuid('r'), planId: slot.planId, scheduledAt: at.toISOString(),
        status: slot.outcome === 'missed' ? 'missed' : 'confirmed',
        level: slot.outcome === 'missed' ? 5 : 1,
        fireAt: at.toISOString(),
        acknowledgedAt: actual ? actual.toISOString() : null,
        acknowledgeType: slot.outcome === 'missed' ? null : 'in_app',
        createdAt: iso
      });

      st.logs.push({
        id: uuid('l'), planId: slot.planId, medicineId: plan.medicineId,
        scheduledAt: at.toISOString(),
        actualTakenAt: actual ? actual.toISOString() : null,
        delayMinutes: slot.delay,
        status: slot.outcome,
        isMakeup: false, sourceLogId: null, confirmedBy: 'self',
        missReason: null, note: '', createdAt: iso
      });
    });

    /* 家属列表**默认留空**。
     *
     * 旧版本在这里种了一条「女儿 · 小张 / MEDI-8F3K」的演示记录，于是设置页
     * 挂出一个绿色「已绑定」徽标——而那条记录**不代表任何真实绑定**：家属是在
     * 另一台设备上通过中继绑定的，本机没有任何办法知道有谁、有几位。
     * 一条写死的演示数据被当成了"已绑定"的证据，这正是 P8 那一批"界面在说话、
     * 说法没有依据"的另一种形态（见 docs/04 §4.8）。
     *
     * 真实绑定数的唯一来源是中继回报的 `caregiversBound`（存在 user.relay.boundCount），
     * 由「我的 → 家属协同」如实显示。 */
    st.caregivers = [];

    return st;
  }

  /* ---------- 读写 ---------- */

  function load() {
    if (state) return state;
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1) { state = parsed; return state; }
      }
    } catch (e) { /* 存储损坏则重建 */ }
    state = seed();
    save();
    return state;
  }

  function save() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('保存失败', e); }
  }

  function reset() {
    state = blankState();
    save();
    return state;
  }

  function resetToSeed() {
    state = seed();
    save();
    return state;
  }

  /* ---------- 药品 ---------- */

  function getMedicine(id) {
    return state.medicines.filter(function (m) { return m.id === id; })[0] || null;
  }

  function addMedicine(data) {
    var m = {
      id: uuid('m'),
      name: data.name || '未命名药品',
      specification: data.specification || '',
      dosageForm: data.dosageForm || 'tablet',
      strength: data.strength || '',
      note: data.note || '',
      stockAmount: data.stockAmount == null ? null : Number(data.stockAmount),
      isArchived: false,
      createdAt: nowIso(), updatedAt: nowIso()
    };
    state.medicines.push(m);
    save();
    return m;
  }

  function updateMedicine(id, patch) {
    var m = getMedicine(id);
    if (!m) return null;
    Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
    m.updatedAt = nowIso();
    save();
    return m;
  }

  /** 归档而非删除，保留历史记录（BR-02） */
  function archiveMedicine(id) {
    var m = getMedicine(id);
    if (!m) return;
    m.isArchived = true;
    state.plans.forEach(function (p) { if (p.medicineId === id) p.isActive = false; });
    state.reminders.forEach(function (r) {
      if (r.status === 'pending' && planOf(r.planId) && planOf(r.planId).medicineId === id) r.status = 'cancelled';
    });
    save();
  }

  /* ---------- 计划 ---------- */

  function planOf(id) {
    return state.plans.filter(function (p) { return p.id === id; })[0] || null;
  }
  function getPlan(id) { return planOf(id); }

  function addPlan(data) {
    var p = {
      id: uuid('p'),
      medicineId: data.medicineId,
      doseAmount: Number(data.doseAmount) || 1,
      doseUnit: data.doseUnit || '片',
      frequencyType: data.frequencyType || 'daily',
      intervalHours: data.intervalHours || null,
      weekdays: data.weekdays || null,
      anchorType: data.anchorType || 'absolute',
      anchorTime: data.anchorTime || null,
      offsetMinutes: Number(data.offsetMinutes) || 0,
      mealRelation: data.mealRelation || 'none',
      mealLabel: data.mealLabel || '',
      times: (data.times || ['08:00']).slice(),
      startDate: data.startDate || S.dateKey(new Date()),
      endDate: data.endDate || null,
      isLongTerm: data.isLongTerm !== false,
      isActive: true,
      windowMinutes: Number(data.windowMinutes) || state.user.windowMinutes,
      safetyGapMinutes: Number(data.safetyGapMinutes) || state.user.safetyGapMinutes,
      createdAt: nowIso()
    };
    state.plans.push(p);
    save();
    regenerateReminders();
    return p;
  }

  function updatePlan(id, patch) {
    var p = planOf(id);
    if (!p) return null;
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    save();
    regenerateReminders();   // 修改处方只影响未来排程，历史记录不动（BR-02）
    return p;
  }

  /** 停用而非删除 */
  function deactivatePlan(id) {
    var p = planOf(id);
    if (!p) return;
    p.isActive = false;
    state.reminders.forEach(function (r) {
      if (r.planId === id && r.status === 'pending') r.status = 'cancelled';
    });
    save();
  }

  /* ---------- 排程重建（幂等） ---------- */

  /**
   * 重建未来提醒。
   * - 保留所有非 pending 的提醒（历史不可篡改）
   * - pending 全部丢弃后按当前计划重算，因此重复调用结果一致
   */
  function regenerateReminders(days) {
    var now = new Date();
    var kept = state.reminders.filter(function (r) { return r.status !== 'pending'; });
    var seen = {};
    kept.forEach(function (r) { seen[r.planId + '|' + r.scheduledAt] = 1; });

    var fresh = S.generateSchedule({
      plans: state.plans.filter(function (p) { return p.isActive; }),
      from: now,
      days: days || S.DEFAULT_PLAN_DAYS
    });

    var out = kept.slice();
    fresh.forEach(function (f) {
      var k = f.planId + '|' + f.scheduledAt;
      if (seen[k]) return;                 // 幂等去重
      seen[k] = 1;
      var plan = planOf(f.planId);
      out.push({
        id: uuid('r'),
        planId: f.planId,
        scheduledAt: f.scheduledAt,
        windowMinutes: plan ? plan.windowMinutes : state.user.windowMinutes,
        status: 'pending',
        level: 0,
        fireAt: null,
        acknowledgedAt: null,
        acknowledgeType: null,
        createdAt: now.toISOString()
      });
    });

    out.sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });
    state.reminders = out;
    save();
    return out;
  }

  /* ---------- 打卡与记录 ---------- */

  /** 找出最近一条待触发提醒 */
  function findReminderById(id) {
    return state.reminders.filter(function (r) { return r.id === id; })[0] || null;
  }

  /** 按「计划 + 时间点」查找提醒 */
  function findReminderBySlot(planId, scheduledAtIso) {
    return state.reminders.filter(function (r) {
      return r.planId === planId && r.scheduledAt === scheduledAtIso;
    })[0] || null;
  }

  /** 若该时间点没有提醒对象则创建一个（用于补录今天已过的时间点） */
  function ensureReminder(planId, scheduledAtIso) {
    var found = findReminderBySlot(planId, scheduledAtIso);
    if (found) return found;
    var plan = planOf(planId);
    var r = {
      id: uuid('r'), planId: planId, scheduledAt: scheduledAtIso,
      windowMinutes: plan ? plan.windowMinutes : state.user.windowMinutes,
      status: 'pending', level: 0, fireAt: null,
      acknowledgedAt: null, acknowledgeType: null, createdAt: nowIso()
    };
    state.reminders.push(r);
    save();
    return r;
  }

  /**
   * 结算「应用未运行期间错过的服药时间点」。
   *
   * 场景：用户一整天没打开应用，晚上打开时，早上的提醒从未生成过提醒对象，
   * 若不处理会被永久遗忘。这里把「今天已过、超出漏服窗口、且完全无记录」
   * 的时间点补记为漏服事实（只补记事实，不回放提醒、不改动已有历史）。
   */
  function reconcileMissed() {
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var created = 0;

    state.plans.filter(function (p) { return p.isActive; }).forEach(function (p) {
      if (!S.planCoversDay(p, todayStart)) return;
      var win = p.windowMinutes || state.user.windowMinutes || 120;
      (p.times || []).forEach(function (t) {
        var at = S.resolveScheduledAt(p, todayStart, t);
        if (at.getTime() >= now.getTime()) return;                    // 还没到点
        if (now.getTime() - at.getTime() < win * 60000) return;       // 仍在窗口内，不判定
        var iso = at.toISOString();
        var hasLog = state.logs.some(function (l) { return l.planId === p.id && l.scheduledAt === iso; });
        if (hasLog) return;
        var hasRem = state.reminders.some(function (r) {
          return r.planId === p.id && r.scheduledAt === iso && r.status !== 'cancelled';
        });
        if (hasRem) return;

        state.reminders.push({
          id: uuid('r'), planId: p.id, scheduledAt: iso, windowMinutes: win,
          status: 'missed', level: 5, fireAt: null,
          acknowledgedAt: null, acknowledgeType: null, createdAt: nowIso()
        });
        state.logs.push({
          id: uuid('l'), planId: p.id, medicineId: p.medicineId,
          scheduledAt: iso, actualTakenAt: null, delayMinutes: null,
          status: 'missed', isMakeup: false, sourceLogId: null,
          confirmedBy: 'system', missReason: '应用未运行期间漏服', note: '', createdAt: nowIso()
        });
        created++;
      });
    });

    if (created) save();
    return created;
  }

  function logOf(planId, scheduledAt, isMakeup) {
    return state.logs.filter(function (l) {
      return l.planId === planId && l.scheduledAt === scheduledAt && !!l.isMakeup === !!isMakeup;
    })[0] || null;
  }

  /**
   * 确认服药。幂等：重复确认不会产生第二条记录。
   * @param {Object} reminder
   * @param {String} type in_app | notification | widget | watch | caregiver
   * @param {Date}   at   实际服药时间，默认 now
   */
  function confirmReminder(reminder, type, at) {
    if (!reminder) return null;
    if (reminder.status === 'confirmed' || reminder.status === 'cancelled') return logOf(reminder.planId, reminder.scheduledAt, false);

    var when = at || new Date();
    var plan = planOf(reminder.planId);
    var delay = S.minutesBetween(reminder.scheduledAt, when);
    var status = S.classify(delay, reminder.windowMinutes || (plan ? plan.windowMinutes : 120));

    reminder.status = 'confirmed';
    reminder.acknowledgedAt = when.toISOString();
    reminder.acknowledgeType = type || 'in_app';
    if (reminder.level === 0) reminder.level = 1;

    var existing = logOf(reminder.planId, reminder.scheduledAt, false);
    if (existing) {
      existing.actualTakenAt = when.toISOString();
      existing.delayMinutes = delay;
      existing.status = status;
      existing.confirmedBy = type || 'in_app';
      save();
      return existing;
    }

    var log = {
      id: uuid('l'),
      planId: reminder.planId,
      medicineId: plan ? plan.medicineId : null,
      scheduledAt: reminder.scheduledAt,
      actualTakenAt: when.toISOString(),
      delayMinutes: delay,
      status: status,
      isMakeup: false,
      sourceLogId: null,
      confirmedBy: type || 'in_app',
      missReason: null,
      note: '',
      createdAt: nowIso()
    };
    state.logs.push(log);
    save();
    return log;
  }

  /** 标记漏服（幂等） */
  function markMissed(reminder) {
    if (!reminder) return null;
    if (reminder.status === 'confirmed' || reminder.status === 'missed' || reminder.status === 'cancelled') {
      return logOf(reminder.planId, reminder.scheduledAt, false);
    }
    reminder.status = 'missed';
    reminder.level = 5;

    var plan = planOf(reminder.planId);
    var existing = logOf(reminder.planId, reminder.scheduledAt, false);
    if (existing) { existing.status = 'missed'; save(); return existing; }

    var log = {
      id: uuid('l'),
      planId: reminder.planId,
      medicineId: plan ? plan.medicineId : null,
      scheduledAt: reminder.scheduledAt,
      actualTakenAt: null,
      delayMinutes: null,
      status: 'missed',
      isMakeup: false,
      sourceLogId: null,
      confirmedBy: 'system',
      missReason: null,
      note: '',
      createdAt: nowIso()
    };
    state.logs.push(log);
    save();
    return log;
  }

  /** 用户主动跳过本次（S5 分支） */
  function skipReminder(reminder) {
    if (!reminder) return null;
    reminder.status = 'cancelled';
    var plan = planOf(reminder.planId);
    var log = logOf(reminder.planId, reminder.scheduledAt, false);
    if (log) { log.status = 'skipped'; save(); return log; }
    var rec = {
      id: uuid('l'), planId: reminder.planId, medicineId: plan ? plan.medicineId : null,
      scheduledAt: reminder.scheduledAt, actualTakenAt: null, delayMinutes: null,
      status: 'skipped', isMakeup: false, sourceLogId: null, confirmedBy: 'self',
      missReason: '用户选择跳过', note: '', createdAt: nowIso()
    };
    state.logs.push(rec);
    save();
    return rec;
  }

  /**
   * 补服。生成独立记录，原漏服记录保留不覆盖（BR-03 / S5）
   */
  function makeupReminder(reminder, at) {
    if (!reminder) return null;
    var when = at || new Date();
    var plan = planOf(reminder.planId);
    var sourceLog = logOf(reminder.planId, reminder.scheduledAt, false);

    reminder.status = 'confirmed';
    reminder.acknowledgedAt = when.toISOString();
    reminder.acknowledgeType = 'makeup';

    var rec = {
      id: uuid('l'),
      planId: reminder.planId,
      medicineId: plan ? plan.medicineId : null,
      scheduledAt: reminder.scheduledAt,
      actualTakenAt: when.toISOString(),
      delayMinutes: S.minutesBetween(reminder.scheduledAt, when),
      status: 'makeup',
      isMakeup: true,
      sourceLogId: sourceLog ? sourceLog.id : null,
      confirmedBy: 'self',
      missReason: null,
      note: '漏服后补服',
      createdAt: nowIso()
    };
    state.logs.push(rec);

    if (sourceLog) sourceLog.missReason = '漏服后补服';   // 原记录保留，仅补充说明
    save();
    return rec;
  }

  /** 记录漏服原因（P1 归因分析） */
  function setMissReason(logId, reason) {
    var l = state.logs.filter(function (x) { return x.id === logId; })[0];
    if (l) { l.missReason = reason; save(); }
  }

  /* ---------- 设置 ---------- */

  function updateUser(patch) {
    Object.keys(patch).forEach(function (k) {
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
        state.user[k] = Object.assign({}, state.user[k], patch[k]);
      } else {
        state.user[k] = patch[k];
      }
    });
    save();
    return state.user;
  }

  /**
   * 应用时区变化策略（BR-05）。
   * 由用户在两条路径中明确选择，绝不静默改写处方：
   *  - follow_local：钟点不变，绝对时刻随当地时区平移
   *  - keep_rhythm ：绝对时刻不变，钟点按偏移差补偿
   * 只影响未来排程，历史记录不动（BR-02）。
   */
  function applyTimezonePolicy(policy, change) {
    var decisions = [];

    state.plans.forEach(function (p) {
      var res;
      // 相对锚点的处方（如"早餐前 30 分钟"）平移锚点时间，而非 times
      if (p.anchorType === 'relative' && p.anchorTime) {
        res = S.resolveTimezoneChange(policy, change, [p.anchorTime]);
        p.anchorTime = res.times[0];
        decisions.push({ planId: p.id, target: 'anchorTime', shiftMinutes: res.shiftMinutes, value: p.anchorTime });
      } else {
        res = S.resolveTimezoneChange(policy, change, p.times);
        p.times = res.times;
        decisions.push({ planId: p.id, target: 'times', shiftMinutes: res.shiftMinutes, value: p.times });
      }
    });

    state.user.timezone = (change && change.to) || S.currentTimezone();
    state.user.tzPolicy = (policy === S.TZ_POLICY.KEEP_RHYTHM)
      ? S.TZ_POLICY.KEEP_RHYTHM : S.TZ_POLICY.FOLLOW_LOCAL;
    state.user.tzUpdatedAt = nowIso();
    save();
    regenerateReminders();
    return { policy: state.user.tzPolicy, decisions: decisions };
  }

  /* 注意：这里只往**本地**列表里加一条记录，它**不构成绑定**。
   * 家属真正绑上是在另一台设备上凭邀请码向中继 claim 完成的，
   * 本机只能从中继回报的计数知道"有几位"，永远不知道"是谁"。
   * 因此任何界面都不得把这条本地记录渲染成「已绑定」。 */
  function addCaregiver(name, relation) {
    var c = {
      id: uuid('c'), userId: state.user.id, caregiverName: name,
      relation: relation || '家属', permission: 'view',
      // 默认 'pending' 而不是 'active'，与 SQL 设计（docs/02）一致：
      // 本机写下的这一行**不是**绑定成功的证据，绑定只在中继侧成立。
      status: 'pending',
      inviteCode: 'MEDI-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
      createdAt: nowIso()
    };
    state.caregivers.push(c);
    save();
    return c;
  }

  /** 家属协同中继配置（浅合并，避免把其它字段冲掉） */
  function setRelay(patch) {
    state.user.relay = Object.assign({}, state.user.relay || {}, patch || {});
    save();
    return state.user.relay;
  }

  /* ---------- 导出 ---------- */

  function exportJson() {
    return JSON.stringify({
      exportedAt: nowIso(),
      version: state.version,
      user: state.user, medicines: state.medicines, plans: state.plans,
      reminders: state.reminders, logs: state.logs, caregivers: state.caregivers
    }, null, 2);
  }

  global.Store = {
    load: load, save: save, reset: reset, resetToSeed: resetToSeed, uuid: uuid,
    get state() { return state; },
    // 药品
    getMedicine: getMedicine, addMedicine: addMedicine, updateMedicine: updateMedicine, archiveMedicine: archiveMedicine,
    // 计划
    getPlan: getPlan, addPlan: addPlan, updatePlan: updatePlan, deactivatePlan: deactivatePlan,
    // 排程
    regenerateReminders: regenerateReminders,
    // 提醒与记录
    findReminderById: findReminderById,
    findReminderBySlot: findReminderBySlot,
    ensureReminder: ensureReminder,
    reconcileMissed: reconcileMissed,
    confirmReminder: confirmReminder, markMissed: markMissed, skipReminder: skipReminder,
    makeupReminder: makeupReminder, setMissReason: setMissReason,
    // 设置
    updateUser: updateUser, addCaregiver: addCaregiver, setRelay: setRelay,
    applyTimezonePolicy: applyTimezonePolicy,
    // 导出
    exportJson: exportJson
  };
})(window);
