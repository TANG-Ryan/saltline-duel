# Saltline 双人对战

原版单人任务保留。新增无需注册的双人房间：房主复制邀请链接，朋友加入，双方准备后开局；先击杀对手 10 次获胜。

## 本地运行

需要 Node.js 22 或更新版本。在终端执行：

~~~sh
cd /Users/ryan/FPS_War/Rebuild_Game/multiplayer
npm ci
npm test
npm start
~~~

打开 http://127.0.0.1:8787 。点击“双人对战”创建本机测试房间。若要在本机测试两人，请在两个独立浏览器或无痕窗口手动打开相同的房间地址，避免重连凭证混淆。回环地址会明确显示“本机测试房间”，不会让复制按钮把它当作互联网邀请。

本地 localhost 链接只能在自己的设备使用；让不同网络的朋友加入，需要下面的公网部署。原有单人入口仍可通过静态 HTTP 服务运行，不需要联机服务。

## 免费公网部署

本目录已提供锁定依赖的 package-lock.json；Rebuild_Game/render.yaml 提供 Render Blueprint 配置。将 **Rebuild_Game 目录作为你自己的部署仓库根目录**，在 Render 连接该仓库并创建 Blueprint；配置采用 Free 实例、新加坡区域、仓库根目录（rootDir: .）、npm --prefix multiplayer ci --omit=dev 构建、node multiplayer/server.mjs 启动和 /healthz 健康检查。部署不安装浏览器开发依赖。

如果你的仓库根目录是 FPS_War，请把 Blueprint 的 rootDir 改为 Rebuild_Game。应用需要同时访问 index.html 和 multiplayer 目录；不要把服务 rootDir 设为 multiplayer，因为 Render 不提供根目录之外的文件。

部署成功后，Render 会提供真实的 HTTPS 地址。用这个地址打开游戏后创建房间，邀请链接会自动使用同一公网地址，WebSocket 自动采用 WSS。此仓库不包含已部署的地址、平台账号、令牌或收费订阅，也不会自行升级套餐。

可选环境变量：

- PORT：监听端口，由 Render 自动提供；本地默认 8787。
- PUBLIC_ORIGIN：可选，填入实际公网 origin，例如 https://你的服务.onrender.com；留空时按请求地址生成邀请链接。自定义域名改变后需同步此值。
- NODE_VERSION：Blueprint 默认 22。

Render 免费实例空闲 15 分钟后会休眠，首次唤醒约需一分钟，且实例可能重启。界面会显示启动、断线和房间结束状态。比赛存在当前服务内存中，服务重启后需重新创建房间。

官方说明：https://render.com/docs/free 、https://render.com/docs/websocket

## 对战规则

- 最多两人；双方准备后倒计时 3 秒开始。
- 连续击杀计分，先到 10 分结束。环境伤害导致死亡不为对手加分。
- 被击败者 3 秒后复活；另一人保留位置与状态。
- 复活恢复 100 生命、30 发弹匣，提供 2 秒保护，开枪立即取消保护。
- 备用弹无限，仍需换弹；沿用原有移动、26 点枪伤、射速和回血规则。
- 联机关闭 AI 与任务进度。菜单或后台仅停止自己的操作，不暂停对手。
- 网络断开后本局冻结，30 秒内可用原浏览器凭证恢复；超时结束本局，不判最终胜者。
- 比赛结束后，双方都选择“再来一局”才会重新开始。

## 地图更新与检查

服务器只加载随代码发布的可信 shared/map.json，不接收玩家上传的碰撞数据。当前地图固定种子 4207，版本 saltline-port-2，哈希 fnv1a-7f744fbe，共 595 个碰撞盒、25 个安全出生点，已从本地实际游戏的高、低画质场景生成并核对。

本地原版 HTML 的单人任务、生存模式、难度和手枪功能保留。联机入口由服务器响应时注入，避免改写原版打包代码；联机统一使用 PAC-9，枪械呈现与服务器的换弹计时同步。

修改原地图后，在开发机器安装 Chromium 并重新导出、检查碰撞数据：

~~~sh
npx playwright install chromium
npm run export-map
npm run check-map
npm test
npm run smoke-browser
~~~

浏览器仅用于开发导出与核验地图，线上服务启动不运行浏览器。check-map 应验证低、高画质生成相同碰撞数据；有意改变碰撞时同时更新地图版本。

## 接口与测试

- POST /api/rooms：返回房间标识、邀请地址和创建者的个人重连凭证。
- GET /healthz：返回就绪状态、固定地图种子、版本和哈希。
- /ws：加入、准备、操作输入、立即停手、状态快照、战斗事件和重赛。
- 个人凭证保存在当前浏览器，邀请链接只携带房间标识。

npm test 包含纯模拟测试及真实 HTTP/WebSocket 集成测试。npm run smoke-browser 使用两个独立浏览器上下文核对创建房间、邀请加入、双方准备及操作停止；运行前安装 Chromium（npx playwright install chromium）。服务端以固定 60Hz 模拟、20Hz 广播快照；250 毫秒没有新操作时自动停止持续移动和开火。客户端无法提交伤害、比分、地图或角色位置作为结算依据。

发布验收还需在两台不同网络的设备完成一次实际对战，并检查键鼠、触屏、手柄和单人任务流程。自动测试通过不等同于已完成公网实机验收。

原游戏来源：https://github.com/realcodebear/saltline-fable-5.2 。原有作者说明和署名请继续保留。

## 当前验证状态

- 依赖已通过 npm ci 安装；48 项 Node 测试已实际运行并全部通过，包括真实 HTTP/WebSocket 房间、计分、复活、断线重连和本机地址不可误分享等回归检查。
- Playwright 真实双浏览器测试已通过：原 WebGL 场景加载、邀请加入、双方准备、移动同步、远端模型、菜单立即停火，以及原单人首页回归。
- 本地实际游戏高、低画质的地图导出核验已通过。浏览器测试截图位于 test-artifacts/browser-smoke（不进入部署包）。
- 既有公网测试入口：[SALTLINE 双人对战](https://saltline-duel.onrender.com/?multiplayer=1)。`main` 分支推送后由现有 Render 服务自动部署；不同网络的两台设备实机对战仍需玩家验证。
- 人物升级采用原 PAC-9 与原 Fh 双臂，增加统一对称、装备贴合、连续蒙皮与三层 LOD；源码分析及角色验收见仓库根目录 `TACTICAL_SOLDIER.md`。

