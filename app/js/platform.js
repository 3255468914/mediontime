/*!
 * platform.js — 提醒投递平台适配层
 *
 * 把「让操作系统在某个时刻叫醒用户」这件事抽象为一个统一接口，两套实现：
 *
 *   WebPlatform   —— 浏览器 Notification + 页面内定时器。
 *                    页面被关闭 / 进程被清理后即失效，这是 Web 平台的硬限制。
 *
 *   NativePlatform—— Capacitor LocalNotifications，触发时刻交给系统：
 *                    Android 落到 AlarmManager（setExactAndAllowWhileIdle），
 *                    iOS 落到 UNUserNotificationCenter 的日历触发器。
 *                    因此应用被杀、进程被清理、设备重启后提醒依然会响。
 *
 * 上层只调用 Platform.sync(jobs, opts)，不需要知道自己是跑在哪种容器里。
 * 本模块不依赖 Store / DOM，全部逻辑可在 Node 中直接测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scheduler.js'));
  else root.Platform = factory(root.Scheduler);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  /* ============================================================
   * 原生通知 ID：字符串 → 32 位正整数
   * Android 的通知 ID 必须是 int32，且同一 ID 会被覆盖，
   * 因此需要稳定的字符串哈希 + 冲突探测。
   * ============================================================ */

  var ID_SPACE = 0x7fffffff;   // 2^31-1

  /** FNV-1a 变体，返回无符号 32 位整数 */
  function hash32(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function toNativeId(key) { return (hash32(key) % ID_SPACE) + 1; }

  /**
   * 为一批提醒分配互不冲突的原生通知 ID。冲突时线性探测，
   * 保证同批次内不会互相覆盖；映射对同一输入稳定（幂等）。
   * @param {Array}    items
   * @param {Function} [hashFn] 注入哈希函数（仅测试用，用于构造冲突）
   */
  function assignNativeIds(items, hashFn) {
    var hash = hashFn || toNativeId;
    var used = {};
    return (items || []).map(function (it) {
      var id = hash(it.reminderId + '|' + it.level);
      var guard = 0;
      while (used[id] && guard < 4096) { id = (id % ID_SPACE) + 1; guard++; }
      used[id] = 1;
      var copy = {};
      Object.keys(it).forEach(function (k) { copy[k] = it[k]; });
      copy.nativeId = id;
      return copy;
    });
  }

  /* ============================================================
   * 把提醒对象编译成「交给系统的闹钟任务」
   * ============================================================ */

  /**
   * @param {Array}  reminders  Store 中的提醒对象
   * @param {Object} opts
   *   - describe(reminder) → {title, body}  由调用方注入，避免耦合 Store
   *   - levels:Number[]                     交给系统托管的升级级别，默认 [1,2,3]
   *     （L1 到点、L2 催办、L3 强催办。L4 通知家属由中继计时，L5 由页面结算，
   *      都不该出现在系统通知里）
   *   - speedFactor:Number                  演示加速倍率
   */
  function buildJobs(reminders, opts) {
    opts = opts || {};
    var levels = opts.levels || [1, 2, 3];
    var speed = opts.speedFactor || 1;
    var describe = opts.describe || function () { return { title: '用药提醒', body: '该服药了' }; };
    var out = [];

    (reminders || []).forEach(function (r) {
      if (!r || r.status !== 'pending') return;
      var d = describe(r) || {};
      var esc = S.buildEscalation(r.scheduledAt, r.windowMinutes, speed);
      esc.forEach(function (step) {
        if (levels.indexOf(step.level) === -1) return;
        out.push({
          reminderId: r.id,
          planId: r.planId,
          level: step.level,
          at: step.at,
          title: d.title + (step.level >= 2 ? '（请尽快确认）' : ''),
          body: d.body || ''
        });
      });
    });

    out.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    return out;
  }

  /* ============================================================
   * Android Doze 约束
   *
   * 官方文档明确：带 allowWhileIdle 的提醒在 Doze 模式下「每个应用每 9 分钟
   * 只能触发一次」。而升级链路的 L1→L2 间隔是 5 分钟——若两级都用
   * allowWhileIdle，L2 会吃掉本该留给下一条提醒的额度，导致同一天里后面
   * 的服药提醒在 Doze 下被静默推迟，风险反而更大。
   *
   * 因此只给 L1（真正"必须准时"的那一级）加 allowWhileIdle；L2/L3 作为
   * 催办允许被推迟到下一个维护窗口（L3 的 +15 分钟间隔正好落在
   * 节流窗口之外，由系统按维护窗口送达即可）。
   * ============================================================ */

  var DOZE_MIN_INTERVAL_MINUTES = 9;

  function allowWhileIdleFor(level) { return level === 1; }

  /* ============================================================
   * Android 通知渠道
   *
   * 渠道的重要性等级决定通知能否「横幅弹出 + 响铃」。默认渠道是 DEFAULT，
   * 只会在通知栏里静静出现——对用药提醒等于没提醒。所以必须显式建渠道：
   * L1 用 IMPORTANCE_HIGH(4)，L2 催办用 IMPORTANCE_MAX(5)。
   * ============================================================ */

  var CHANNELS = [
    { id: 'med-normal', name: '用药提醒', description: '到点服药提醒', importance: 4, visibility: 1, vibration: true },
    { id: 'med-alert', name: '用药催办', description: '未确认时的加急提醒', importance: 5, visibility: 1, vibration: true }
  ];

  /* ============================================================
   * 权限状态归一化
   * Web: 'granted' | 'denied' | 'default'
   * Capacitor: {display: 'granted'|'denied'|'prompt'|'prompt-with-rationale'}
   * ============================================================ */

  function normalizePermission(raw) {
    var v = (raw && typeof raw === 'object') ? raw.display : raw;
    if (v === 'granted') return 'granted';
    if (v === 'denied') return 'denied';
    if (v === 'default' || v === 'prompt' || v === 'prompt-with-rationale') return 'prompt';
    if (v === 'unsupported') return 'unsupported';
    return 'unknown';
  }

  /* ============================================================
   * 同步实现（各平台共用）
   * ============================================================ */

  /**
   * 把本地待触发提醒同步为系统级闹钟。
   * 返回实际注册的批次信息；被配额挤出的部分需要等下次前台刷新时滚动补齐。
   */
  function makeSync(p) {
    return function sync(jobs, opts) {
      opts = opts || {};
      var plan = S.planNativeBatch(jobs, {
        now: opts.now,
        quota: p.quota,
        horizonDays: opts.horizonDays
      });

      if (!p.canScheduleSystemAlarm) {
        plan.supported = false;
        plan.applied = 0;
        plan.mode = 'in-page';
        plan.systemCount = null;   // 没有系统侧可言：未知，不是 0（0 会谎称"已核实为空"）
        return Promise.resolve(plan);
      }

      var items = assignNativeIds(plan.items);
      return p.schedule(items, opts).then(function (res) {
        plan.supported = true;
        plan.applied = res.applied;
        plan.mode = res.mode;
        plan.items = items;
        // 系统侧真实数量：null = 未知（读回失败），数字 = 系统里实际挂着的闹钟数。
        // UI 用它与 plan.applied（账面数）对账，账实不符必须如实说。
        plan.systemCount = (res && res.systemCount !== undefined) ? res.systemCount : null;
        return plan;
      }, function (err) {
        plan.supported = true;
        plan.applied = 0;
        plan.error = (err && err.message) || String(err);
        plan.systemCount = null;   // 注册都没成功，系统侧数量无从谈起
        return plan;
      });
    };
  }

  /* ============================================================
   * Web 实现
   * ============================================================ */

  function createWebPlatform(g) {
    function hasNotification() { return !!(g && 'Notification' in g); }

    var p = {
      id: 'web',
      label: '浏览器',
      os: 'web',
      quota: S.NATIVE_QUOTA.default,
      canScheduleSystemAlarm: false,
      capabilities: {
        exactAlarm: false,
        survivesAppKill: false,
        survivesReboot: false,
        backgroundFullscreen: false,
        caregiverPush: false
      },
      note: '页面关闭后浏览器不执行脚本，提醒只能在应用处于打开状态时触发。',

      permissionState: function () {
        if (!hasNotification()) return Promise.resolve('unsupported');
        return Promise.resolve(normalizePermission(g.Notification.permission));
      },

      requestPermission: function () {
        if (!hasNotification()) return Promise.resolve('unsupported');
        if (g.Notification.permission !== 'default') {
          return Promise.resolve(normalizePermission(g.Notification.permission));
        }
        return Promise.resolve(g.Notification.requestPermission())
          .then(normalizePermission, function () { return 'denied'; });
      },

      /** Web 平台不向系统注册闹钟，投递由页面内 ReminderEngine 的 tick 完成 */
      schedule: function () { return Promise.resolve({ applied: 0, mode: 'in-page' }); },

      cancelAll: function () { return Promise.resolve(0); },

      pendingCount: function () { return Promise.resolve(0); },

      exactAlarmState: function () { return Promise.resolve('unsupported'); },

      openExactAlarmSetting: function () { return Promise.resolve(false); },

      ensureChannels: function () { return Promise.resolve(false); },

      onNotificationTap: function () { return function () { }; }
    };
    p.sync = makeSync(p);
    return p;
  }

  /* ============================================================
   * 原生实现（Capacitor LocalNotifications）
   * ============================================================ */

  function pluginOf(g) {
    if (!g || !g.Capacitor) return null;
    var plugins = g.Capacitor.Plugins || {};
    return plugins.LocalNotifications || null;
  }

  function createNativePlatform(g) {
    var plugin = pluginOf(g);
    var os = (g.Capacitor.getPlatform && g.Capacitor.getPlatform()) || 'android';
    var osName = os === 'ios' ? 'iOS' : (os === 'android' ? 'Android' : os);
    var quota = (os === 'ios') ? S.NATIVE_QUOTA.ios : S.NATIVE_QUOTA.android;

    var p = {
      id: 'native',
      label: osName + ' · 系统级闹钟',
      os: os,
      quota: quota,
      canScheduleSystemAlarm: true,
      capabilities: {
        exactAlarm: true,
        survivesAppKill: true,
        // Android 靠 RECEIVE_BOOT_COMPLETED 恢复；iOS 由系统持久化待触发请求
        survivesReboot: os === 'android',
        backgroundFullscreen: false,   // 需前台服务，见 docs/05
        caregiverPush: false           // 需服务端推送，见 docs/05
      },
      note: '触发时刻已注册到系统，应用被关闭或设备重启后仍会响铃。',

      permissionState: function () {
        if (!plugin) return Promise.resolve('unsupported');
        return Promise.resolve(plugin.checkPermissions())
          .then(function (r) { return normalizePermission(r); }, function () { return 'denied'; });
      },

      requestPermission: function () {
        if (!plugin) return Promise.resolve('unsupported');
        return Promise.resolve(plugin.requestPermissions())
          .then(function (r) { return normalizePermission(r); }, function () { return 'denied'; });
      },

      /**
       * 建好通知渠道。渠道一旦建立，其"重要性"等级用户改不了、应用也改不了
       * （Android 只允许降级不允许升级，除非卸载重装），所以必须一次建对。
       */
      ensureChannels: function () {
        if (os !== 'android' || !plugin || !plugin.createChannel) return Promise.resolve(false);
        return Promise.all(CHANNELS.map(function (c) {
          var copy = {};
          Object.keys(c).forEach(function (k) { copy[k] = c[k]; });
          return Promise.resolve(plugin.createChannel(copy)).catch(function () { });
        })).then(function () { return true; });
      },

      /**
       * 先把系统里遗留的待触发提醒全部撤销，再注册新一批。
       * 全量重建而非增量，是为了保证与本地状态严格一致（幂等）。
       */
      schedule: function (items) {
        if (!plugin) return Promise.resolve({ applied: 0, mode: 'no-plugin' });
        var self = this;

        var notifications = (items || []).map(function (it) {
          return {
            id: it.nativeId,
            title: it.title,
            body: it.body,
            schedule: { at: new Date(it.at), allowWhileIdle: allowWhileIdleFor(it.level) },
            smallIcon: 'ic_stat_pill',
            channelId: it.level >= 2 ? 'med-alert' : 'med-normal',
            ongoing: false,
            autoCancel: true,
            extra: { reminderId: it.reminderId, planId: it.planId, level: it.level }
          };
        });

        return self.ensureChannels()
          .then(function () { return Promise.resolve(plugin.getPending()); })
          .catch(function () { return { notifications: [] }; })
          .then(function (pending) {
            var existing = (pending && pending.notifications) || [];
            if (existing.length) {
              return plugin.cancel({ notifications: existing.map(function (n) { return { id: n.id }; }) });
            }
          })
          .then(function () {
            if (!notifications.length) return { applied: 0, mode: 'exact-alarm', systemCount: 0 };
            return Promise.resolve(plugin.schedule({ notifications: notifications }))
              .then(function () {
                // 注册后立刻从系统读回真实数量——上面的 applied 是 App 自己的记账，
                // 不代表闹钟真的在系统里活着（ROM 深度清理、重启、被"闹钟和提醒"
                // 开关关闭时系统会删闹钟，而 App 的账不会变）。这里对账，
                // 读回失败记 null（未知），UI 对 null 不得声称成功也不得声称失败。
                return Promise.resolve(plugin.getPending()).then(
                  function (p) {
                    return { applied: notifications.length, mode: 'exact-alarm', systemCount: ((p && p.notifications) || []).length };
                  },
                  function () {
                    return { applied: notifications.length, mode: 'exact-alarm', systemCount: null };
                  }
                );
              });
          });
      },

      cancelAll: function () {
        if (!plugin) return Promise.resolve(0);
        return Promise.resolve(plugin.getPending())
          .catch(function () { return { notifications: [] }; })
          .then(function (pending) {
            var existing = (pending && pending.notifications) || [];
            if (!existing.length) return 0;
            return Promise.resolve(plugin.cancel({
              notifications: existing.map(function (n) { return { id: n.id }; })
            })).then(function () { return existing.length; });
          });
      },

      pendingCount: function () {
        if (!plugin) return Promise.resolve(0);
        return Promise.resolve(plugin.getPending())
          .then(function (p) { return ((p && p.notifications) || []).length; }, function () { return 0; });
      },

      /**
       * Android 12+ 的精确闹钟是「应用内设置」里的独立开关，与通知权限分开。
       * 官方文档警告：用户一旦把它关掉，系统会重启应用并删除所有已排的精确闹钟。
       * 所以这里必须能查到真实状态，不能假设有权限就万事大吉。
       */
      exactAlarmState: function () {
        if (os !== 'android') return Promise.resolve('unsupported');
        if (!plugin || !plugin.checkExactNotificationSetting) return Promise.resolve('unknown');
        return Promise.resolve(plugin.checkExactNotificationSetting())
          .then(function (r) {
            if (typeof r === 'string') return r;
            return (r && r.exact_alarm) || 'unknown';
          }, function () { return 'unknown'; });
      },

      /** 跳转到系统设置页让用户开启精确闹钟 */
      openExactAlarmSetting: function () {
        if (!plugin || !plugin.changeExactNotificationSetting) return Promise.resolve(false);
        return Promise.resolve(plugin.changeExactNotificationSetting())
          .then(function () { return true; }, function () { return false; });
      },

      /** 注册「用户点了通知」回调，返回解绑函数 */
      onNotificationTap: function (handler) {
        if (!plugin || !plugin.addListener) return function () { };
        var h = plugin.addListener('localNotificationActionPerformed', function (ev) {
          var extra = (ev && ev.notification && ev.notification.extra) || {};
          handler(extra);
        });
        return function () {
          try { Promise.resolve(h).then(function (x) { if (x && x.remove) x.remove(); }); } catch (e) { }
        };
      }
    };
    p.sync = makeSync(p);
    return p;
  }

  /* ============================================================
   * 对外统一接口
   * ============================================================ */

  var current = null;

  /** 探测当前运行时；结果缓存，可传 force 重新探测 */
  function resolve(g, force) {
    if (current && !force) return current;
    g = g || (typeof globalThis !== 'undefined' ? globalThis : {});
    var native = !!(g.Capacitor && (g.Capacitor.isNativePlatform ? g.Capacitor.isNativePlatform() : true));
    current = native ? createNativePlatform(g) : createWebPlatform(g);
    return current;
  }

  function get() { return current || resolve(); }

  /** 把本地待触发提醒同步为当前运行时的系统级闹钟 */
  function sync(jobs, opts) { return get().sync(jobs, opts); }

  /**
   * 提醒可靠性自检 —— 用于设置页的「提醒体检」。
   * 逐项说明当前运行时到底能不能保证提醒送达，不粉饰限制。
   */
  function diagnose(state) {
    var p = get();
    var c = p.capabilities;
    var perm = state && state.permission ? state.permission : 'unknown';
    var checks = [];

    checks.push({
      key: 'permission',
      label: '通知权限',
      level: perm === 'granted' ? 'ok' : 'bad',
      detail: perm === 'granted' ? '已授权'
        : perm === 'unsupported' ? '当前环境不支持通知'
          : perm === 'denied' ? '已被拒绝，需到系统设置中手动开启'
            : '尚未授权，提醒无法送达'
    });

    checks.push({
      key: 'system-alarm',
      label: '系统级闹钟',
      level: c.exactAlarm ? 'ok' : 'bad',
      detail: c.exactAlarm
        ? '提醒已交给系统，不依赖应用处于打开状态'
        : '浏览器关闭后无法提醒，需使用原生版本'
    });

    checks.push({
      key: 'app-kill',
      label: '应用被关闭后仍能提醒',
      level: c.survivesAppKill ? 'ok' : 'bad',
      detail: c.survivesAppKill ? '由操作系统调度' : '页面关闭即失效（Web 平台限制）'
    });

    checks.push({
      key: 'reboot',
      label: '设备重启后自动恢复',
      level: c.survivesReboot ? 'ok' : 'warn',
      detail: c.survivesReboot
        ? '开机广播会自动恢复待触发提醒'
        : (p.os === 'ios' ? 'iOS 由系统持久化待触发请求，无需开机广播' : '不支持，重启后需手动打开应用')
    });

    // Android 12+ 的精确闹钟是独立开关，关掉会静默降级为不精确闹钟
    if (p.os === 'android') {
      var ea = (state && state.exactAlarm) || 'unknown';
      checks.push({
        key: 'exact-alarm-setting',
        label: '精确闹钟授权',
        level: ea === 'granted' ? 'ok' : (ea === 'unknown' ? 'warn' : 'bad'),
        detail: ea === 'granted' ? '系统允许按精确时刻唤醒'
          : ea === 'unknown' ? '无法确认，请到系统设置中检查'
            : '未授权，提醒时刻会被系统推迟（最长可达数十分钟）'
      });
    }

    // Doze 模式下 allowWhileIdle 有 9 分钟节流，会影响 L1→L2 的 5 分钟间隔
    if (p.canScheduleSystemAlarm) {
      checks.push({
        key: 'doze',
        label: '省电模式下的送达',
        level: 'warn',
        detail: '设备进入 Doze 后，系统对唤醒型提醒有 ' + DOZE_MIN_INTERVAL_MINUTES +
          ' 分钟节流，短间隔的催办可能被推迟——首次提醒不受影响'
      });
    }

    var bad = checks.filter(function (x) { return x.level === 'bad'; }).length;
    return {
      platform: p.id,
      label: p.label,
      quota: p.quota,
      dozeIntervalMinutes: DOZE_MIN_INTERVAL_MINUTES,
      reliable: bad === 0,
      checks: checks,
      note: p.note
    };
  }

  return {
    // 探测
    resolve: resolve,
    get: get,
    // 主接口
    sync: sync,
    diagnose: diagnose,
    buildJobs: buildJobs,
    // 工具（供测试与 UI 复用）
    hash32: hash32,
    toNativeId: toNativeId,
    assignNativeIds: assignNativeIds,
    normalizePermission: normalizePermission,
    allowWhileIdleFor: allowWhileIdleFor,
    CHANNELS: CHANNELS,
    createWebPlatform: createWebPlatform,
    createNativePlatform: createNativePlatform,
    ID_SPACE: ID_SPACE,
    DOZE_MIN_INTERVAL_MINUTES: DOZE_MIN_INTERVAL_MINUTES
  };
});
