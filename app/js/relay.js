/*!
 * relay.js — 患者端与「家属协同中继」的连接（零依赖）
 *
 * 设计上的两条硬规矩：
 *   1. **默认不联网**。没有配置服务器时，本模块一个请求都不发，
 *      应用行为与"没有家属协同"完全一致。
 *   2. **绝不谎报送达**。任何失败（未配置 / 网络不通 / 服务端拒绝）
 *      都如实返回，由界面照实说出来——
 *      旧版本在这里说"已通知 N 位家属"，其实什么都没发出去。
 */
(function (global) {
  'use strict';

  var TIMEOUT_MS = 6000;

  function cfg() { return (global.Store.state.user && global.Store.state.user.relay) || {}; }
  function baseUrl() { return String(cfg().url || '').replace(/\/+$/, ''); }
  function token() { return String(cfg().patientToken || ''); }

  function isConfigured() {
    var c = cfg();
    return !!(c.url && c.code && c.patientToken);
  }

  /** 邀请码：4 位易读字符（去掉 0/O/1/I 这类易混字符，老人要念给家人听） */
  function newCode() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s = '';
    var buf = new Uint8Array(4);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (var i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 4; j++) s += alphabet[buf[j] % alphabet.length];
    return 'MEDI-' + s;
  }

  function newToken() { return global.Store.uuid('pt'); }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('连接超时（' + (ms / 1000) + ' 秒）'));
      }, ms);
      promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }

  function post(path, body) {
    if (!global.fetch) return Promise.reject(new Error('当前环境不支持网络请求'));
    return withTimeout(global.fetch(baseUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }), TIMEOUT_MS).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) {
          var err = new Error(j.error || ('服务端返回 ' + res.status));
          err.status = res.status;
          throw err;
        }
        return j;
      });
    });
  }

  /**
   * 登记邀请码。患者端本地生成码与令牌，服务端只做登记——
   * 这样即使服务端被换掉，患者的令牌也不用变。
   */
  function pair(url, code, label) {
    var clean = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(clean)) {
      return Promise.reject(new Error('服务器地址要以 http:// 或 https:// 开头'));
    }
    var c = cfg();
    var pt = c.patientToken || newToken();
    var pairCode = code || c.code || newCode();

    var saved = c.url;
    global.Store.setRelay({ url: clean });     // 让 post() 用新地址
    return post('/api/pair', {
      code: pairCode,
      patientToken: pt,
      patientLabel: label || g_label()
    }).then(function (j) {
      global.Store.setRelay({
        url: clean, code: j.code || pairCode, patientToken: pt,
        pairedAt: new Date().toISOString(), lastDelivery: null,
        // 绑定人数**只能从中继来**：本地没有任何办法知道另一台设备上有没有人绑定。
        // 存下来是为了让界面能说一句有依据的"已绑定 N 位家属"，
        // 而不是像旧版本那样挂一个写死的"已绑定"徽标。
        boundCount: Number(j.caregiversBound) || 0
      });
      return { ok: true, code: j.code || pairCode, caregiversBound: j.caregiversBound || 0 };
    }).catch(function (e) {
      global.Store.setRelay({ url: saved });   // 失败就回滚，不留半配置状态
      throw e;
    });
  }

  function g_label() {
    var u = global.Store.state.user || {};
    return u.nickname && u.nickname !== '我' ? u.nickname : '家人';
  }

  function unpair() {
    global.Store.setRelay({ url: '', code: '', patientToken: '', pairedAt: null, lastDelivery: null, boundCount: 0 });
    return { ok: true };
  }

  function status() {
    var c = cfg();
    return {
      configured: isConfigured(),
      url: c.url || '',
      code: c.code || '',
      hasToken: !!c.patientToken,
      pairedAt: c.pairedAt || null,
      lastDelivery: c.lastDelivery || null,
      lastWatchSync: c.lastWatchSync || null,
      boundCount: c.boundCount || 0
    };
  }

  /**
   * 上报一条事件给中继。
   * @returns {Promise<Object>} 永不 reject —— 调用方要的是"如实的结果"，
   *          而不是一个需要 try/catch 的异常路径（漏服通知失败不该炸掉提醒流程）。
   */
  function report(event) {
    if (!isConfigured()) {
      return Promise.resolve({ ok: false, reason: 'unconfigured', delivered: 0, caregivers: 0 });
    }
    return post('/api/report', { patientToken: token(), event: event }).then(function (j) {
      var out = {
        ok: true,
        delivered: Number(j.delivered) || 0,
        caregivers: Number(j.caregivers) || 0,
        detail: j.detail || {}
      };
      global.Store.setRelay({
        lastDelivery: { at: new Date().toISOString(), delivered: out.delivered, caregivers: out.caregivers },
        // 每次投递中继都会回报"这个码下现在绑着几位家属"，顺手刷新计数
        boundCount: out.caregivers
      });
      return out;
    }).catch(function (e) {
      var out = {
        ok: false,
        reason: (e && e.status) ? 'server' : 'network',
        status: e && e.status,
        message: (e && e.message) || '网络错误',
        delivered: 0, caregivers: 0
      };
      global.Store.setRelay({
        lastDelivery: { at: new Date().toISOString(), delivered: 0, caregivers: 0, error: out.message }
      });
      return out;
    });
  }

  /**
   * 上报「每剂该通知家属的时刻」，交给中继计时（全量对账语义）。
   *
   * 为什么这件事不能只靠患者手机：L4 原先由页面内的 JS 定时器驱动，
   * 手机熄屏/进程被冻结后定时器不再运行——而「患者已经没反应了」
   * 恰恰是最可能熄屏的时刻。把时刻预先交给一个一直活着的进程（中继），
   * 到点仍未撤销就由中继推送家属，家属协同才在关键时刻成立。
   *
   * 条目只有提醒内部 id 与时刻，**没有药名**——构造方在 app.js，
   * 这里不接触 Store 里的任何业务对象。
   *
   * @returns {Promise<Object>} 永不 reject（与 report 同样的纪律）
   */
  function scheduleWatches(items) {
    if (!isConfigured()) {
      return Promise.resolve({ ok: false, reason: 'unconfigured', watched: 0 });
    }
    return post('/api/notify-schedule', { patientToken: token(), items: items || [] }).then(function (j) {
      var out = { ok: true, watched: Number(j.watched) || 0 };
      global.Store.setRelay({ lastWatchSync: { at: new Date().toISOString(), watched: out.watched } });
      return out;
    }).catch(function (e) {
      var out = { ok: false, reason: (e && e.status) ? 'server' : 'network', message: (e && e.message) || '网络错误', watched: 0 };
      global.Store.setRelay({ lastWatchSync: { at: new Date().toISOString(), watched: 0, error: out.message } });
      return out;
    });
  }

  /** 撤销某剂（或某几剂）的计时待办：确认/跳过/补录之后调用，家属不会再被打扰。 */
  function cancelWatches(reminderIds) {
    if (!isConfigured()) {
      return Promise.resolve({ ok: false, reason: 'unconfigured', cancelled: 0 });
    }
    return post('/api/notify-cancel', { patientToken: token(), reminderIds: reminderIds || [] }).then(function (j) {
      return { ok: true, cancelled: Number(j.cancelled) || 0 };
    }, function (e) {
      // 撤销失败不弹窗打扰患者——中继到点会推一次「未收到确认」，
      // 家属看到后打电话确认即可，这比在服药流程里插一条报错更安全
      return { ok: false, reason: (e && e.status) ? 'server' : 'network', message: (e && e.message) || '网络错误', cancelled: 0 };
    });
  }

  global.Relay = {
    isConfigured: isConfigured,
    status: status,
    pair: pair,
    unpair: unpair,
    report: report,
    scheduleWatches: scheduleWatches,
    cancelWatches: cancelWatches,
    newCode: newCode,
    baseUrl: baseUrl
  };
})(window);
