/*!
 * scheduler.js — 用药排程与判定引擎（纯逻辑，无 DOM / 无存储依赖）
 * 同时支持浏览器全局（window.Scheduler）与 Node require，便于单元测试。
 *
 * 关键设计说明：
 *  plan.times 里存的字符串就是「实际提醒时间」（用户直接选 07:00）
 *  mealRelation 仅作为展示语义（如"餐前 30 分钟"），不参与时间计算。
 *  仅当 anchorType === 'relative' 时，才用 anchorTime + offsetMinutes 推导提醒时间。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ON_TIME_THRESHOLD_MINUTES = 30;
  var DEFAULT_WINDOW_MINUTES = 120;
  var DEFAULT_SAFETY_GAP_MINUTES = 120;
  var DEFAULT_PLAN_DAYS = 90;

  /* ---------- 工具 ---------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function minutesBetween(a, b) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000); }
  function parseHHMM(s) {
    var p = String(s).split(':');
    return { h: Number(p[0]) || 0, m: Number(p[1]) || 0 };
  }

  /** 把 '2026-10-10' + '07:00' 组合成本地时间 Date */
  function combineDateTime(key, hhmm) {
    var d = String(key).split('-').map(Number);
    var t = parseHHMM(hhmm);
    return new Date(d[0], d[1] - 1, d[2], t.h, t.m, 0, 0);
  }

  /* ---------- 计划覆盖判断 ---------- */

  function planCoversDay(plan, day) {
    if (!plan || !plan.isActive) return false;
    var key = dateKey(day);
    if (key < plan.startDate) return false;
    if (plan.endDate && key > plan.endDate) return false;

    var freq = plan.frequencyType || 'daily';
    if (freq === 'weekly') {
      var wd = plan.weekdays;
      if (Array.isArray(wd) && wd.length && wd.indexOf(day.getDay()) === -1) return false;
    }
    if (freq === 'interval') {
      var ih = Number(plan.intervalHours) || 0;
      if (ih > 0) {
        var per = Math.max(1, Math.round(24 / ih));
        var days = Math.round((startOfDay(day) - startOfDay(new Date(plan.startDate + 'T00:00:00'))) / 86400000);
        if (days % per !== 0) return false;
      }
    }
    return true;
  }

  /** 计算某天某个时间点的实际提醒时刻 */
  function resolveScheduledAt(plan, day, timeStr) {
    if (plan.anchorType === 'relative' && plan.anchorTime) {
      // 相对锚点：以当天的锚点时间为基准做偏移（offsetMinutes 正数表示提前）
      var base = combineDateTime(dateKey(day), plan.anchorTime);
      return new Date(base.getTime() - (Number(plan.offsetMinutes) || 0) * 60000);
    }
    return combineDateTime(dateKey(day), timeStr);
  }

  /**
   * 生成未来排程。
   * @param {Object} opts
   * @param {Array}  opts.plans           用药计划数组
   * @param {Date}   opts.from            起始时刻（该时刻之前的提醒不生成，不回填历史）
   * @param {Number} opts.days            生成天数，默认 90
   * @returns {Array} 按时间升序的提醒候选 [{planId, scheduledAt(ISO), dateKey, time}]
   */
  function generateSchedule(opts) {
    var plans = opts.plans || [];
    var from = opts.from || new Date();
    var days = opts.days || DEFAULT_PLAN_DAYS;
    var out = [];
    var seen = {};
    var day0 = startOfDay(from);

    for (var pi = 0; pi < plans.length; pi++) {
      var plan = plans[pi];
      if (!plan.isActive) continue;
      var times = plan.times || [];
      for (var i = 0; i < days; i++) {
        var day = addDays(day0, i);
        if (!planCoversDay(plan, day)) continue;
        for (var ti = 0; ti < times.length; ti++) {
          var at = resolveScheduledAt(plan, day, times[ti]);
          if (at.getTime() <= from.getTime()) continue;      // 不回填历史
          var iso = at.toISOString();
          var uniq = plan.id + '|' + iso;                     // 幂等去重
          if (seen[uniq]) continue;
          seen[uniq] = 1;
          out.push({
            planId: plan.id,
            scheduledAt: iso,
            dateKey: dateKey(day),
            time: times[ti]
          });
        }
      }
    }
    out.sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : (a.scheduledAt > b.scheduledAt ? 1 : 0); });
    return out;
  }

  /* ---------- 服药状态判定 ---------- */

  /** delayMinutes: 实际时间 - 计划时间 */
  function classify(delayMinutes, windowMinutes) {
    var w = (windowMinutes == null) ? DEFAULT_WINDOW_MINUTES : windowMinutes;
    if (delayMinutes <= ON_TIME_THRESHOLD_MINUTES) return 'on_time';
    if (delayMinutes <= w) return 'delayed';
    return 'missed';
  }

  /* ---------- 提醒升级链路 ---------- */

  var ESCALATION_STEPS = [
    { level: 1, afterMinutes: 0,  key: 'L1', title: '初次提醒',       channels: ['notification', 'sound', 'vibrate'] },
    { level: 2, afterMinutes: 5,  key: 'L2', title: '加大音量与震动', channels: ['notification', 'soundLoud', 'vibrateLong'] },
    { level: 3, afterMinutes: 15, key: 'L3', title: '全屏强提醒',     channels: ['fullscreen', 'soundLoud', 'vibrateLong'] },
    { level: 4, afterMinutes: 30, key: 'L4', title: '通知家属',       channels: ['caregiver'] },
    { level: 5, afterMinutes: null, key: 'L5', title: '标记漏服',     channels: ['missed', 'makeupAsk'] }
  ];

  /**
   * 构建一次提醒的完整升级计划。
   * @param {String} scheduledAt  计划服药时间（ISO）
   * @param {Number} windowMinutes 漏服判定窗口
   * @param {Number} speedFactor   演示加速倍率（1 = 真实时间；0.01 = 100 倍速）
   */
  function buildEscalation(scheduledAt, windowMinutes, speedFactor) {
    var base = new Date(scheduledAt).getTime();
    var w = (windowMinutes == null) ? DEFAULT_WINDOW_MINUTES : windowMinutes;
    var sf = speedFactor || 1;
    var totalMs = w * 60000 * sf;
    return ESCALATION_STEPS.map(function (s) {
      var offset = (s.afterMinutes == null) ? totalMs : s.afterMinutes * 60000 * sf;
      return {
        level: s.level,
        key: s.key,
        title: s.title,
        channels: s.channels.slice(),
        at: new Date(base + offset).toISOString()
      };
    });
  }

  /* ---------- 漏服补救决策 ---------- */

  /**
   * @returns {{allow:Boolean, gapMinutes:Number|null, message:String}}
   * 注意：本函数只判断"是否允许补服"，绝不给出剂量建议（BR-04）
   */
  function makeUpDecision(now, nextScheduledAt, safetyGapMinutes) {
    var gap = (safetyGapMinutes == null) ? DEFAULT_SAFETY_GAP_MINUTES : safetyGapMinutes;
    if (!nextScheduledAt) {
      return { allow: true, gapMinutes: null, message: '是否现在补服？' };
    }
    var mins = minutesBetween(now, nextScheduledAt);
    if (mins > gap) {
      return { allow: true, gapMinutes: mins, message: '是否现在补服？' };
    }
    return {
      allow: false,
      gapMinutes: mins,
      message: '已接近下次服药时间，建议跳过本次。请遵医嘱服药，本应用不提供医疗建议。'
    };
  }

  /** 找出该计划在 now 之后的下一个提醒时间 */
  function nextScheduledAfter(reminders, planId, now) {
    var t = new Date(now).getTime();
    var best = null;
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i];
      if (r.planId !== planId) continue;
      if (r.status === 'confirmed' || r.status === 'cancelled') continue;
      var ts = new Date(r.scheduledAt).getTime();
      if (ts <= t) continue;
      if (best === null || ts < best) best = ts;
    }
    return best === null ? null : new Date(best).toISOString();
  }

  /* ---------- 依从性统计 ---------- */

  // 记录状态（snake_case）→ 统计字段（camelCase）的映射
  var STATUS_KEY = { on_time: 'onTime', delayed: 'delayed', missed: 'missed', skipped: 'skipped', makeup: 'makeup' };

  function summarize(logs, from, to) {
    var f = from ? new Date(from).getTime() : -Infinity;
    var t = to ? new Date(to).getTime() : Infinity;
    var rows = (logs || []).filter(function (l) {
      var ts = new Date(l.scheduledAt).getTime();
      return ts >= f && ts <= t;
    });

    var res = { total: rows.length, onTime: 0, delayed: 0, missed: 0, skipped: 0, makeup: 0, onTimeRate: 0, byHour: {}, byMedicine: {} };

    rows.forEach(function (l) {
      var key = STATUS_KEY[l.status];
      if (key && res[key] != null) res[key]++;
      var hh = new Date(l.scheduledAt).getHours();
      var hk = pad2(hh) + ':00';
      if (!res.byHour[hk]) res.byHour[hk] = { total: 0, onTime: 0, missed: 0, rate: 0 };
      res.byHour[hk].total++;
      if (l.status === 'on_time') res.byHour[hk].onTime++;
      if (l.status === 'missed') res.byHour[hk].missed++;

      var mk = l.medicineId || 'unknown';
      if (!res.byMedicine[mk]) res.byMedicine[mk] = { total: 0, onTime: 0, missed: 0, rate: 0 };
      res.byMedicine[mk].total++;
      if (l.status === 'on_time') res.byMedicine[mk].onTime++;
      if (l.status === 'missed') res.byMedicine[mk].missed++;
    });

    // 按时率 = 准时记录 / 有效应服次数（补服记录不重复计入分母）
    var denom = res.onTime + res.delayed + res.missed;
    res.onTimeRate = denom ? Math.round((res.onTime / denom) * 100) : 0;

    Object.keys(res.byHour).forEach(function (k) {
      var o = res.byHour[k];
      o.rate = o.total ? Math.round((o.onTime / o.total) * 100) : 0;
    });
    Object.keys(res.byMedicine).forEach(function (k) {
      var o = res.byMedicine[k];
      o.rate = o.total ? Math.round((o.onTime / o.total) * 100) : 0;
    });

    return res;
  }

  /* ---------- 时区（BR-05） ---------- */

  function currentTimezoneOffsetMinutes() { return -new Date().getTimezoneOffset(); }

  /** 分钟偏移 → 'UTC+8' / 'UTC-3' / 'UTC+5:30' */
  function formatTimezoneOffset(mins) {
    var sign = mins < 0 ? '-' : '+';
    var a = Math.abs(Number(mins) || 0);
    return 'UTC' + sign + pad2(Math.floor(a / 60)) + (a % 60 ? ':' + pad2(a % 60) : '');
  }

  /** 'UTC+8' / 'UTC-3' / 'UTC+5:30' → 分钟偏移；无法解析返回 null */
  function parseTimezoneOffset(tz) {
    if (tz == null) return null;
    var s = String(tz).trim();
    if (/^UTC([+-]0{1,2})?$/.test(s)) return 0;
    var m = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  }

  function currentTimezone() { return formatTimezoneOffset(currentTimezoneOffsetMinutes()); }

  /**
   * 检测时区是否发生变化（BR-05）。
   * 兼容旧签名 detectTimezoneChange(storedTz)；nowTz 可显式注入以便测试。
   * @returns {{changed:Boolean, from:String|null, to:String, deltaMinutes:Number}}
   */
  function detectTimezoneChange(storedTz, nowTz) {
    var to = nowTz || currentTimezone();
    var a = parseTimezoneOffset(storedTz);
    var b = parseTimezoneOffset(to);
    if (a == null || b == null || a === b) {
      return { changed: false, from: storedTz || null, to: to, deltaMinutes: 0 };
    }
    return { changed: true, from: storedTz, to: to, deltaMinutes: b - a };
  }

  var TZ_POLICY = { FOLLOW_LOCAL: 'follow_local', KEEP_RHYTHM: 'keep_rhythm' };

  /** 按分钟平移一组 HH:mm 时间点（自动按 24 小时环绕、去重、升序） */
  function shiftPlanTimes(times, shiftMinutes) {
    var shift = Number(shiftMinutes) || 0;
    var seen = {}, out = [];
    (times || []).forEach(function (t) {
      var p = parseHHMM(t);
      var total = (((p.h * 60 + p.m + shift) % 1440) + 1440) % 1440;
      var s = pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    });
    return out.sort();
  }

  /**
   * 时区变化后如何对待既有处方时间点（BR-05 要求用户二选一，不得静默处理）。
   *  local = UTC + offset，故同一绝对时刻在新时区的当地读数为 local + Δoffset。
   *  - follow_local（按当地作息，默认）：钟点不变（仍 07:00），绝对时刻随之平移
   *  - keep_rhythm（保持原节奏）：绝对时刻不变，钟点按 Δoffset 反向补偿
   *    （例：UTC+8 的 07:00 飞到 UTC+1 后为当地 00:00，跨天属预期结果）
   */
  function resolveTimezoneChange(policy, change, times) {
    var keepRhythm = policy === TZ_POLICY.KEEP_RHYTHM;
    var delta = (change && change.deltaMinutes) || 0;
    var shift = keepRhythm ? delta : 0;
    return {
      policy: keepRhythm ? TZ_POLICY.KEEP_RHYTHM : TZ_POLICY.FOLLOW_LOCAL,
      shiftMinutes: shift,
      times: shiftPlanTimes(times, shift),
      description: keepRhythm
        ? '维持原有服药间隔：服药钟点随时间带整体平移，可能跨越零点'
        : '按当地钟点服药：服药间隔随时间带自动调整'
    };
  }

  /* ---------- 原生提醒配额守卫（BR-09） ---------- */

  // iOS 单应用待触发本地通知硬上限为 64 条；Android 无硬上限但过多注册会被系统限流
  var NATIVE_QUOTA = { ios: 64, android: 512, default: 100 };
  var NATIVE_RESERVE = 4;   // 预留余量，避免打满系统上限后无法插入新提醒

  /**
   * 计算可交给操作系统的系统级闹钟批次。
   *
   * 背景：调度必须交给系统完成（应用被杀 / 重启后仍能响），但系统对待触发
   * 定时器有数量上限，超出部分会被静默丢弃。因此只注册"最近的一批"，
   * 其余留待下次前台刷新时滚动补齐——宁可晚注册，不可静默丢失。
   *
   * @param {Array} jobs  [{ reminderId, planId, level, at(ISO), title, body }]
   * @param {Object} opts { now, quota, horizonDays }
   * @returns {{quota,usable,registered,totalEligible,deferred,overflow,horizonEnd,coveredMinutes,items}}
   */
  function planNativeBatch(jobs, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var quota = opts.quota == null ? NATIVE_QUOTA.default : Number(opts.quota);
    var horizonDays = opts.horizonDays == null ? 30 : Number(opts.horizonDays);
    var horizonLimit = now + horizonDays * 86400000;
    var usable = Math.max(0, quota - NATIVE_RESERVE);

    var eligible = (jobs || []).filter(function (j) {
      var t = new Date(j.at).getTime();
      return isFinite(t) && t > now && t <= horizonLimit;
    }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });

    var items = eligible.slice(0, usable);
    return {
      quota: quota,
      usable: usable,
      registered: items.length,
      totalEligible: eligible.length,
      deferred: eligible.length - items.length,
      overflow: eligible.length > items.length,
      horizonEnd: items.length ? items[items.length - 1].at : null,
      coveredMinutes: items.length ? minutesBetween(now, items[items.length - 1].at) : 0,
      items: items
    };
  }

  return {
    // 常量
    ON_TIME_THRESHOLD_MINUTES: ON_TIME_THRESHOLD_MINUTES,
    DEFAULT_WINDOW_MINUTES: DEFAULT_WINDOW_MINUTES,
    DEFAULT_SAFETY_GAP_MINUTES: DEFAULT_SAFETY_GAP_MINUTES,
    DEFAULT_PLAN_DAYS: DEFAULT_PLAN_DAYS,
    ESCALATION_STEPS: ESCALATION_STEPS,
    // 工具
    pad2: pad2,
    dateKey: dateKey,
    startOfDay: startOfDay,
    addDays: addDays,
    minutesBetween: minutesBetween,
    combineDateTime: combineDateTime,
    // 核心
    planCoversDay: planCoversDay,
    resolveScheduledAt: resolveScheduledAt,
    generateSchedule: generateSchedule,
    classify: classify,
    buildEscalation: buildEscalation,
    makeUpDecision: makeUpDecision,
    nextScheduledAfter: nextScheduledAfter,
    summarize: summarize,
    // 时区
    currentTimezone: currentTimezone,
    currentTimezoneOffsetMinutes: currentTimezoneOffsetMinutes,
    formatTimezoneOffset: formatTimezoneOffset,
    parseTimezoneOffset: parseTimezoneOffset,
    shiftPlanTimes: shiftPlanTimes,
    detectTimezoneChange: detectTimezoneChange,
    resolveTimezoneChange: resolveTimezoneChange,
    TZ_POLICY: TZ_POLICY,
    // 原生提醒配额
    NATIVE_QUOTA: NATIVE_QUOTA,
    NATIVE_RESERVE: NATIVE_RESERVE,
    planNativeBatch: planNativeBatch
  };
});
