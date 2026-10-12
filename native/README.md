# 药准时 · 原生容器（Capacitor）

## 这个目录解决什么问题

`app/` 是零依赖 PWA，双击 `index.html` 就能用。但浏览器有一个**无法绕过的限制**：
页面关闭后不执行 JavaScript，所以提醒只能在应用处于打开状态时触发。

对普通工具这无所谓，对用药提醒是致命的——用户设了闹钟、关掉应用、然后漏服药。
产品的验收标准里有两条硬指标（"手机重启后仍能响铃""应用被杀后仍能响铃"），
在纯 Web 技术路线上**不可能通过**。

这个目录把 `app/` 原封不动地装进原生容器，并把触发时刻交给操作系统：

| | 浏览器（PWA） | 原生容器（本目录） |
|---|---|---|
| 调度主体 | 页面内的 `setInterval` | Android `AlarmManager` / iOS `UNNotificationRequest` |
| 应用被关闭 | ✗ 不响 | ✓ 照常响 |
| 设备重启 | ✗ 不响 | ✓ 自动恢复（Android 靠开机广播） |
| 需要改业务代码 | — | **零改动**，`app/js/` 一行都不用改 |

之所以选 Capacitor 而不是重写 Flutter：`app/js/scheduler.js` 与 `platform.js` 都是
平台无关的纯函数模块，Capacitor 让这套逻辑原样复用；重写则要把 1000+ 行 UI 代码
全部重来，而收益并不在 UI 上。

## 前置条件

- Node ≥ 18
- **Android Studio**（含 Android SDK、JDK）→ 构建 Android；**或者不装它**，见下面的命令行方案
- **Xcode ≥ 15**（仅 macOS）→ 构建 iOS

> **已实测：不装 Android Studio 也能编出 APK**（2026-10-11 在本机完成）。
> 命令行工具链清单与镜像配置：
>
> | 组件 | 版本 | 来源 |
> |---|---|---|
> | JDK | Temurin **21**（Capacitor 通知插件的 toolchain 要求 21，17 不够） | 清华 Adoptium 镜像 |
> | cmdline-tools | 13114758 | 腾讯云镜像 `mirrors.cloud.tencent.com/AndroidSDK/` |
> | platform / build-tools | android-36 r02 + build-tools **35.0.0**（AGP 8.13 默认要求）与 36.0.0 | 腾讯云镜像 |
> | Gradle 8.14.3 | wrapper `distributionUrl` 指向腾讯镜像 | `gradle/wrapper/gradle-wrapper.properties` |
> | Maven 依赖 | 阿里云镜像（`~/.gradle/init.d/mirrors.gradle` 全局替换官方仓库） | 本机配置，不进工程 |
>
> 注意：`dl.google.com` 与 Maven Central 在国内网络下 **HEAD 探测通但实际吞吐不可用**
> （~3KB/s），所以全部走镜像；`build-tools` 的 zip 解出目录名是内部代号
> （`android-15`/`android-16`），要手动改名成 `35.0.0`/`36.0.0` 并手写 `licenses/` 哈希。
> 编译：`JAVA_HOME=<jdk21> ANDROID_HOME=<sdk> ./gradlew assembleDebug`
> → `app/build/outputs/apk/debug/app-debug.apk`（4.2MB，已用 `aapt dump badging` 核验）。

## 构建步骤

```bash
cd native
npm install
#   注：本机实测 npm 官方源不通（registry.npmjs.org 无响应）时改用镜像：
#   npm install --registry=https://registry.npmmirror.com

# 1) 生成原生工程（只需要做一次）
npm run android:add          # 产出 native/android/
# npm run ios:add            # 产出 native/ios/（仅 macOS）
#   ⚠️ 本仓库**已经生成过 native/android/**（随仓库提交）。
#      该目录已存在时请跳过这一步——重复执行会报 "android platform already exists"。
#      那就直接从第 2 步开始。

# 2) 补齐"提醒必达"所需的权限声明（可重复执行，幂等）
npm run patch:android
npm run patch:check          # 校验用；缺权限会以退出码 1 报错

# 3) 同步 Web 资源 + 原生插件
npm run sync                 # = sync-www.mjs + npx cap sync

# 4) 打开工程或直接跑
npm run open:android
npm run run:android
```

> **JDK 要求 21。** Gradle 需要 JDK 17+，而 `capacitor-local-notifications`
> 的 toolchain 明确要求 `languageVersion=21`，因此整条链要跑在 JDK 21 上
> （JDK 17 会在这一步报 `Cannot find a Java installation matching {languageVersion=21}`）。
> 其余要求：Android SDK（`compileSdk 36 / minSdk 24`）。
>
> 本机已完成 1~3 步、编译出 `app-debug.apk` 并在真机上验证熄屏/后台送达。
> 若 `npm run sync` 之后 Gradle 报 `Could not read script ... cordova.variables.gradle`，
> 见 [docs/10 §5](../docs/10-优化与加固评估.md)——那是 sync 删了临时垫片又没重建，
> 可从 `node_modules/@capacitor/cli/assets/` 下的 tar 模板恢复。

自检：

```bash
npm test                     # 131 项，覆盖清单补丁（权限 + 应用属性）、Capacitor 配置（混合内容）、www 同步与漂移锁
npm run www:check            # 检查 native/www 是否与 app/ 一致
```

## 第 2 步到底加了什么，为什么非加不可

`patch-native.mjs` 会往 `AndroidManifest.xml` 里补 6 条权限声明，并在
`<application>` 标签上补 `android:usesCleartextTraffic="true"`
（Android 9+ 默认禁止 App 明文 HTTP；局域网中继是 http://，
缺这条则家属协同在 App 内全部 failed to fetch——2026-10-11 真机联调实锤后
纳入补丁与测试锁）。**缺任何一条都不会报错，
只会让提醒静默地不准时**——这是用药提醒最危险的失败方式：

| 权限 | 适用版本 | 缺了会怎样 |
|---|---|---|
| `POST_NOTIFICATIONS` | Android 13+ | 通知一律不展示（13 起必须运行时申请） |
| `SCHEDULE_EXACT_ALARM` | Android 12+ | 提醒时刻不精确，被系统推迟到"大概那个时间段" |
| `RECEIVE_BOOT_COMPLETED` | 全部 | 重启后待触发提醒全部丢失 |
| `VIBRATE` | 全部 | 第 2、3 级提醒失去震动 |
| `WAKE_LOCK` | 全部 | Doze 模式下无法短暂唤醒投递 |
| `USE_FULL_SCREEN_INTENT` | Android 14+ | 锁屏全屏强提醒失效 |

**故意没有声明 `USE_EXACT_ALARM`**：Google Play 把它限制给"闹钟/日历类应用"专用，
用药提醒不在其列，声明了会**被拒审**。正确做法是声明 `SCHEDULE_EXACT_ALARM`，
再用 `LocalNotifications.checkExactNotificationSetting()` 查到真实状态、引导用户去开。
`app/js/platform.js` 的 `exactAlarmState()` 已实现这条链路。

## 两个容易踩的坑

**1. 精确闹钟是"应用内设置"里的独立开关，不是权限。**
Android 12+ 用户可以在「设置 → 应用 → 药准时 → 闹钟和提醒」里关掉它。
官方文档明确：一旦关闭，**系统会重启应用并删除所有已排的精确闹钟**。
所以应用启动后必须重新同步一次——`app.js` 的 `boot()` 里已经这样做。

**2. `allowWhileIdle` 有 9 分钟节流。**
官方文档写明它「每个应用每 9 分钟只能触发一次」。而升级链路的 L1→L2 间隔是 5 分钟，
若两级都加豁免，L2 会吃掉本该留给当天后续服药提醒的额度——为了一条催办，
牺牲了后面几条准时提醒，得不偿失。
所以代码里只给 L1 加豁免（见 `platform.js` 的 `allowWhileIdleFor()`）。

## 仍然做不到的两件事（如实说明）

| 能力 | 状态 | 原因与补齐路径 |
|---|---|---|
| L3 后台全屏强提醒 | ✗ | 需要 Android 前台服务（常驻通知）+ `USE_FULL_SCREEN_INTENT`。可做，但会常驻一条通知，需权衡后再决定 |
| L4 通知家属 | ✗ | 本地通知无法跨设备送达，必须接服务端推送（FCM / APNs）+ 账号体系 |

这两项不是被遗漏，是**已知的能力边界**，在 `docs/05-原生移植指南.md` 里有补齐方案。

## 目录结构

```
native/
├── capacitor.config.json   原生容器配置（appId / webDir / 通知图标与声音）
├── package.json            依赖与脚本
├── scripts/
│   ├── sync-www.mjs        把 app/ 的运行时文件按白名单复制到 www/，
│   │                       并用 app/sw.js 的 ASSETS 反查一次（漏打包 → 构建期失败）
│   └── patch-native.mjs    幂等地补 AndroidManifest 权限声明
├── tests/native.test.mjs   131 项测试
├── android/                已生成的安卓工程（`cap add android` 产出，随仓库提交）
├── ios/                    `cap add ios` 产出（仅 macOS，尚未生成）
└── www/                    生成物，不入版本库（见 .gitignore）
```

`www/` 由脚本生成：它只包含 `app/` 的运行时文件（**含家属端 `caregiver.html`**），
`app/tests/` 与 README 不会被打进安装包。

> **白名单为什么还要被反查？**
> `caregiver.html` 曾经漏在这里：家属端页面上线时更新了 `app/sw.js` 的 `ASSETS`，
> 却忘了改这份白名单，于是安装包里没有它——家属打开就是 404，
> 而患者端照样显示"家属协同已开启"。而 102 项测试全绿，因为**没人断言过这件事**。
> 现在 `sync-www.mjs` 会用 `sw.js` 的 `ASSETS` 反查打包结果，
> 缺任何一个都以**退出码 1** 失败。**两份清单只能留一份权威，另一份去查它。**

## 相关文档

| 文档 | 位置 |
|---|---|
| 原生移植方案（含真机验证清单） | `../docs/05-原生移植指南.md` |
| **部署与上架指南**（签名、Play/App Store 提审材料、隐私政策模板、合规红线、发布检查单） | `../docs/06-部署与上架指南.md` |
| 验收自检报告 | `../docs/04-验收自检报告.md` |
| PWA 内核说明 | `../app/README.md` |

> 本目录产出的是**已验证配置的骨架**，不是可安装包——本机没有 Android SDK / Xcode。
> 打包与提审的完整步骤（含 keystore 生成、`versionCode` 规则、商店文案与截图规格）
> 写在 `../docs/06-部署与上架指南.md`。
