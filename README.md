# 药准时（MediOnTime）

[![测试](https://github.com/3255468914/mediontime/actions/workflows/tests.yml/badge.svg)](https://github.com/3255468914/mediontime/actions/workflows/tests.yml)
[![演示站点](https://github.com/3255468914/mediontime/actions/workflows/pages.yml/badge.svg)](https://3255468914.github.io/mediontime/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

**在线体验 👉 [3255468914.github.io/mediontime](https://3255468914.github.io/mediontime/)**（直接用浏览器打开，无需安装）

面向长期服药人群及其家属的用药提醒与依从性管理工具。核心价值是让该吃的药一次都不落下：
到点强提醒、未确认逐级升级、漏服有人知道。

> **定位声明**：本应用是健康管理辅助工具，用于提醒与记录用药时间，
> 不提供任何医疗建议，不能替代医生或药师的诊断与处方。

## 功能一览

- **用药计划与排程**：药品建档、多频次计划、餐食关系、疗程起止；排程引擎一次生成 90 天排程
- **分级提醒 L1–L5**：到点通知 → 5 分钟催办 → 15 分钟再次催办 → 30 分钟仍未确认则通知家属，未确认不静默
- **系统级投递**（安卓，经 Capacitor 容器）：提醒交给 AlarmManager 调度，应用被关闭、设备重启后仍会响；浏览器环境自动降级为页面内提醒
- **漏服处理**：补服 / 跳过询问，原漏服记录独立留存不覆盖；整天未打开应用时会补记超窗口的漏服
- **家属协同**：患者端生成邀请码，家属端经自建中继实时接收漏服告警（SSE + Web Push，页面关闭也能收到）
- **依从性统计与报告导出**：按时率、漏服率、时段分布、复诊报告（文本）与全量备份（JSON）
- **长者模式与无障碍**：字号放大、高对比度（多项达 WCAG AAA）、读屏可用的语义与焦点管理
- **隐私默认**：数据全部存本地；通知与家属事件不显示药名与剂量；不配置中继则一个请求都不发

## 快速开始

最快的方式是直接打开在线演示：**https://3255468914.github.io/mediontime/**

想在本机跑（可脱离网络、可用完整 Service Worker 能力）：

```bash
cd app
python -m http.server 8788 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8788/index.html
```

要求 Edge / Chrome 等现代浏览器（Service Worker 与通知需要 http 环境）。
首次进入需勾选免责声明；想跳过引导可用 `index.html?auto=1`。

演示加速：进入后在设置里打开「演示加速」，点「立即触发一次提醒」，
1 分钟内可走完 L1→L5 升级链。注意验证后台/熄屏送达时必须关掉这个开关。

## 家属协同（可选）

需要一个自己部署的中继（Node 18+，零 npm 依赖）：

```bash
cd server
node relay.mjs --host 0.0.0.0 --port 8789
```

患者端「我的 → 家属协同」填入 `http://<电脑局域网IP>:8789`，登记邀请码；
家属端打开 `app/caregiver.html`，填同一地址 + 邀请码绑定即可。
双击根目录的两个 `.bat` 也可以一键起服务和页面。

默认不联网；唯一的例外是用户自己开启的家属协同，且发出去的事件永远不含药名与剂量。
公网部署前请按 [docs/08](docs/08-家属协同服务端.md) §六收紧（限流、CORS、令牌吊销、HTTPS）。

## 安卓安装包

不想自己编译，可直接下载现成的：[**Releases → v1.0.0**](https://github.com/3255468914/mediontime/releases/latest)
（debug 签名，仅供自用与测试）。

也可以自己构建——`native/` 是 Capacitor 容器，把 `app/` 原封不动装进原生壳，触发时刻交给系统：

```bash
cd native
npm install
npm run sync                              # 同步 web 资产到 android 工程
cd android
./gradlew assembleDebug                   # 需要 JDK 21（工具链硬要求）与 Android SDK
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

构建细节、权限清单与已知坑见 [docs/05](docs/05-原生移植指南.md)。

## 测试

```bash
cd app && python -m http.server 8788 --bind 127.0.0.1 &   # 浏览器系测试需要

cd app
node tests/scheduler.test.cjs    # 115 项  排程引擎与判定逻辑（纯函数）
node tests/platform.test.cjs     # 152 项  平台适配层（闹钟、配额、Doze、渠道、系统侧对账）
node tests/smoke.test.cjs        # 139 项  Node vm 沙箱跑完整数据链路
node tests/pwa.test.cjs          #  37 项  Service Worker（vm 模拟 SW 环境）
node tests/a11y.test.cjs         #  76 项  无障碍：对比度实算、字号、点击区、语义
node tests/browser-check.mjs --port 8788   #138 项  真实 Edge 无头 + CDP（含家属协同接线、药名泄漏探测器、家属端页面）
node tests/a11y-tree.mjs --port 8788       # 75 项  真实可访问性树（角色/名称/状态/焦点）

cd ../native && node tests/native.test.mjs # 131 项  原生工程脚本（含 www 与 sw.js 的漂移锁）

cd ../server && npm test                   #  87 项  中继端到端（SSE 送达 + Web Push 解密还原 + 中继计时）

cd ../app && node tools/ui-shots.mjs --port 8788  # 43 项  生成 UI 稿（渲染断言 + 清单自校验）
```

合计 **993 项断言**，当前全绿。除静态服务器外零依赖，不需要 `npm install`。

## 项目结构

```
app/                 可运行的 PWA（患者端 + 家属端）
├── index.html       患者端单页外壳
├── caregiver.html   家属端接收页（绑定 + 实时接收 + 后台通知）
├── js/
│   ├── scheduler.js 排程引擎（纯函数：90 天排程、升级链、时区锚点平移）
│   ├── platform.js  平台适配层（系统闹钟、配额守卫、Doze、通知渠道、系统侧对账）
│   ├── store.js     数据层（localStorage 持久化、打卡、漏服、补服、归档、导出）
│   ├── relay.js     家属协同连接层（默认不联网；失败如实返回）
│   ├── reminder.js  提醒调度引擎（自适应唤醒 + 通知/震动/全屏/家属分级）
│   └── app.js       界面层（渲染、交互、无障碍与焦点管理）
├── sw.js            Service Worker（离线缓存 + Web Push 接收）
├── tools/           UI 稿生成器
└── tests/           7 套测试

server/              家属协同中继（零依赖 Node；不部署则应用完全不联网）
├── relay.mjs        配对/绑定/上报/SSE 投递/L4 计时待办/持久化
├── push.mjs         Web Push 发送端（RFC 8291 加密 + RFC 8292 VAPID，零依赖）
└── tests/           端到端测试

native/              Capacitor 原生容器
├── android/         安卓工程（权限清单已写入、web 资源经脚本同步）
├── scripts/         www 白名单打包（与 sw.js ASSETS 互相校验）+ 清单补丁
└── tests/           打包与清单断言

prototype/           高保真可交互原型（单文件 HTML）
docs/                全部文档（01–10）
docs/ui/             UI 稿截图 + 清单
```

## 设计取舍与已知边界

诚实边界是这个项目的原则之一，这里只列最重要的几条（完整版见
[docs/04](docs/04-验收自检报告.md) §5 与 [docs/10](docs/10-优化与加固评估.md)）：

| 项 | 状态 |
|---|---|
| 浏览器后台提醒 | 页面关闭后浏览器不执行 JS，纯 PWA 无法到点弹提醒。安卓上经 `native/` 解决，业务代码零改动 |
| 家属通知的最后一跳 | 中继计时已实现并在局域网验证（患者确认即撤销，到点未撤销才推送，患者手机离线也照发）；经真实 FCM/APNs 的公网链路未验证 |
| L3 后台全屏强提醒 | 仅前台全屏生效；系统通知渠道的 15 分钟催办已交给系统托管。后台全屏需前台服务 |
| iOS 静音模式响铃 | 需向 Apple 单独申请 Critical Alerts 权限，未申请 |
| 数据加密 | localStorage 明文存储，正式版应迁移 SQLite + SQLCipher |
| 真机验证 | 熄屏/后台送达已在一台安卓真机实测通过；重启送达、iOS、读屏软件（TalkBack/VoiceOver）与真实老年用户测试未执行 |
| 中继安全 | 当前是可用的最小实现：无限流、无令牌吊销、CORS 全开，公网部署前必须按 docs/08 §六收紧 |
| 省电收益 | 自适应唤醒把 3 小时等待的唤醒次数从 10800 降到 54，数字是推算的，未用功耗仪实测 |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01](docs/01-PRD-产品需求文档.md) | PRD：产品需求、页面清单、交互流程 |
| [docs/02](docs/02-数据模型与数据库设计.md) | 数据模型与建表 SQL、ER 图 |
| [docs/03](docs/03-测试用例清单.md) | 测试用例清单（含边界与 993 项断言明细） |
| [docs/04](docs/04-验收自检报告.md) | 验收自检报告：哪些能信、哪些只是骨架 |
| [docs/05](docs/05-原生移植指南.md) | 原生移植指南（含构建坑） |
| [docs/06](docs/06-部署与上架指南.md) | 部署与上架说明、合规红线、发布检查单 |
| [docs/07](docs/07-关键页面UI稿.md) | 关键页面 UI 稿（12 张） |
| [docs/08](docs/08-家属协同服务端.md) | 家属协同服务端：接口、隐私边界、部署收紧清单 |
| [docs/09](docs/09-真机验收手册.md) | 真机验收手册：逐步骤可执行、带记录表 |
| [docs/10](docs/10-优化与加固评估.md) | 优化与加固评估：已修项与路线图 |

## 协议

[MIT](./LICENSE)
