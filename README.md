# Saltline 双人对战

保留原版单人任务、生存模式和难度选项，新增无需注册的双人邀请房间。双方准备后开始，先获得 10 次击杀者获胜。

## 本地运行

需要 Node.js 22 或更新版本：

```sh
cd multiplayer
npm ci
npm test
npm start
```

打开 http://127.0.0.1:8787 。本机地址用于开发测试；部署到公网后，房间页会生成可发给朋友的邀请链接。

## 部署

仓库包含 Render 免费实例配置 `render.yaml`。服务同时托管游戏页面和 WebSocket 后端，比赛状态由服务器结算。

详细玩法、部署、地图导出与验证说明见 [multiplayer/README.md](multiplayer/README.md)。

原游戏参考来源：[realcodebear/saltline-fable-5.2](https://github.com/realcodebear/saltline-fable-5.2)。原版源码中的作者说明和署名保持不变。

人物已按战术三视图重构，并统一为以中轴线镜像生成的身体与装备系统：连续褶皱曲面、蒙皮裤管、弧面盔甲、贴合躯干的背心/肩带、等间距五联弹匣袋及鞋楦式靴面。裤腰跟随骨盆，护膝跟随裤管变形，左右肩、腿和装备共享尺寸参数。保留当前持枪、步态、换弹、受击与倒地功能。PAC-9 直接复用原枪资产，双臂继续使用原 Fh 几何、原握持点和独立骨架；第三人称袖子采用独立材质。

完整源码分析、文件结构、可选 GLB/glTF 导入约定、LOD 预算与限制见 [TACTICAL_SOLDIER.md](TACTICAL_SOLDIER.md)。在 multiplayer 目录运行 `npm run check-soldier` 生成 25 张彩色/白模正交截图及对称、握持、动作验收报告（位于 `multiplayer/test-artifacts/soldier-symmetry/`）；`npm run check-soldier-gltf` 验证可选导入接口；`npm run soldier-lab` 批量评审动作。

当前默认身体为程序化模型；归正评审姿势对称，实际持枪/换弹按左右手职责驱动。专业雕刻、烘焙和手工贴图资产可通过文档中的可选 GLB/glTF 接口接入。
