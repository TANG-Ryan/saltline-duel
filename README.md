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

