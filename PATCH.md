# 本地补丁：工作台状态镜像到宿主侧

基于上游 `Aisland-SJL/dsh-worktable` **v0.5.1**，本地版本号 `0.5.3-local.5`。

本版调整预览页 CSP 的 `frame-src`，允许沙箱内的 HTTP、HTTPS、blob 和 data 子框架，修复内层页签空白；页面仍处于不允许同源访问的沙箱中。关联需求：REQ-20261119-0004。

## 为什么打这个补丁

桌面端宿主启动参数写死 `--port 0`（`@deepseek-ai/dsh-slark-desktop-host` 的
`windows-startup.js`：`--profile web --no-open --host 127.0.0.1 --port 0`），每次启动端口随机。
而工作台把项目/布局/绑定存在 localStorage（`dsh.worktable.projects.v1`、`dsh.worktable.view.v1`），
媒体存 IndexedDB —— 浏览器按「来源」隔离存储，端口一变就是另一个空库。
现象：新建的工作台，重启后消失。

## 改了什么

1. `01_content/src/index.ts`：新增路由 `GET/POST /api/worktable/state`
   - 文件位置：`<DSH_HOME>/worktable-state.json`（走 `resolveDshHomeSafe()`）
   - GET 读回；POST **先读旧文件、按 key 合并、再原子写入**（`.tmp-<pid>-<ts>` → rename）
   - 走宿主既有鉴权（`requestRejection`），与 `/api/worktable/file` 等私有路由一致
2. `01_content/src/client/hostState.ts`（新增）：宿主镜像的读/写、400ms 防抖合并、退避重试
3. `01_content/src/client/index.tsx`：
   - `loadView` / `loadProjects` 抽出 `normalizeView` / `normalizeProjects`，本地存档与宿主镜像共用校验
   - `persistView` / `persistProjects` 额外写 `dsh.worktable.savedAt.v1` 并把状态排进宿主镜像
   - 挂载时拉宿主镜像，只有 `updatedAt > 本地 savedAt` 才回填，避免旧镜像盖掉刚改的内容
   - `pagehide` / `beforeunload` 立即冲刷

## 两条数据安全约束（0.5.2-local.6 补的，来自真实事故）

事故：拖了一下面板（只改了 `view`），客户端 POST 的半截状态把整个文件替换，`projects` 被抹掉；
紧接着重启，客户端读宿主失败又用空状态覆盖了一次。

1. **写入按 key 合并**：服务端读旧文件再 `{ ...previous, ...incoming }`，只带 `view` 的写入不会伤到 `projects`。
2. **读不到就不写**：`loadHostState()` 带退避重试（0/300/700/1200/2000/3000ms）。
   返回 `{ reachable: false }` 时调用 `staysReadOnly()`，**整场会话都不写镜像** ——
   宁可这次只在本地，也不拿空状态覆盖。
3. hydration 成功后 `markHydrated(权威内容)` **整体替换**待写队列。
   事故根因：首屏「控制室自愈」effect 早于异步恢复跑完，把空项目塞进队列；
   旧实现只是合并队列，那份空值留了下来，恢复后 0.5 秒就被写回。必须整体替换。
4. 宿主镜像不比本地新时**不主动落盘**，等用户真的改动再写。

`logs/worktable-state.log` 只在异常时记一行（鉴权被拒 / 项目数量变少），正常保存不写，可长期保留。

改动这三条时注意：`hydrated` 为 false 期间 `queueHostSave` 只累积不发送，这是首屏默认值的闸门，别去掉。

## 覆盖范围

- 覆盖：项目、布局、绑定、项目文件夹、视图/外观设置
- **不覆盖**：图库媒体（照片）仍在 IndexedDB，换端口照样丢

## 兼容声明

`0.2.0-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.5 || 0.2.2-alpha.2`

宿主不在这个范围里时，`dsh plugin add` 会直接拒绝并回滚。换宿主版本要同步改
`package.json` 的 `engines.dsh`**和**`dsh.compatibility.dsh` / `dshReleases`，三处一起改。

## 构建 / 安装

```powershell
cd 01_content
npm install
npm run build          # lib/index.js + lib/client.js
npm pack               # 产出 dsh-worktable-<version>.tgz（7 文件，无 .map）
```

发到 Gitea Release 后（`xiaoqu/dsh-worktable`）：

```powershell
dsh plugin --profile web add "https://gitea.ququclean.com/xiaoqu/dsh-worktable/releases/download/v<version>/dsh-worktable.tgz"
```

装完必须**完全退出宿主再重开**。

**注意**：升级到新版本时，别先删旧 Release —— profile 里还指着旧地址，pnpm 解析依赖会 404。
正确顺序是：先装新版（profile 依赖换成新地址）→ 再把旧 Release 删掉。

## 升级官方版时的注意

上游出 0.5.2 及以上时，本地补丁会被覆盖，需要把上面的改动重新合并到新版本再打包。
如果上游自己解决了「桌面端随机端口 + localStorage」，这个补丁就可以直接丢掉。

## 版本历史

| 版本 | 内容 |
| --- | --- |
| 0.5.2-local.1 | 状态镜像首版；只声明兼容到 0.2.1-rc.5 |
| 0.5.2-local.2 | 兼容声明加入 DSH 0.2.2-alpha.2（宿主升级后安装被拒） |
| 0.5.2-local.6 | 修数据安全：写入按 key 合并 + 读不到不写，修复空状态覆盖镜像 |
| 0.5.3-local.1 | REQ-20261117-0013：单标签窗格隐藏标签栏（原只对控制室生效），关闭入口移到窗格标题条，标题改显示当前标签名 |
| 0.5.3-local.2 | REQ-20261117-0013：收起态 rail 限制 8 个图标，其余进「⋯」菜单（原先四类全平铺无上限） |
| 0.5.3-local.3 | REQ-20261117-0013：状态文件路径改为优先取本机 `03_local/local.json` 的 `cloudStatePath`（指向独立 git 仓），恢复「云状态 + git 历史」；客户端兼容旧 ISO 串形态的 updatedAt |
| 0.5.3-local.4 | REQ-20261117-0013：恢复主题桥（0.5.x 线缺失 `src/theme.ts`、`/theme.js` 路由与产物 HTML 自动注入）；修 dshell.css 写死 `color-scheme: dark`；正文字体改走 `--dsw-font-family` |
