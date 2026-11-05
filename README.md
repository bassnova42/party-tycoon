# 环球大富翁

掷骰子绕地球跑圈，买下国家盖房子，别人踩到就交过路费，把对手全部收到破产。

浏览器里玩的多人大富翁，68 格棋盘、48 个国家。三种玩法：

- **聚会模式** `/party`：电脑接电视当大屏，每个人用自己的手机扫码当手柄（2–6 人，同一个 Wi-Fi）。手机上掷骰（按钮或摇一摇）、买地、盖房、挂牌卖地，大屏放动画和语音。
- **本地试玩** `/`：一台电脑轮流点。
- **在线版** `/online`：早期的大厅版本。

## 运行

需要 Node 18 以上。

```bash
npm install
npm start
```

打开终端里打印的地址。聚会模式下，手机要和电脑连同一个 Wi-Fi，扫大屏上的二维码进房。

语音播报可选：在项目根目录建 `.env`，写上 `GEMINI_API_KEY=...`，就会用 Gemini TTS；没有的话用浏览器自带的语音。

## 测试

```bash
node test/sim.mjs     # 300 局机器人对局，检查规则引擎
node test/party.mjs   # 聚会模式：进房、重连、确认、自动结束回合、挂牌抢购等
node test/e2e.mjs     # 在线版，需要先 npm start
```

## 文件

- `规则.md`：游戏规则，代码都从这里出发
- `技术方案.md`：结构和消息协议
- `passes/`：每一轮开发的说明
- `shared/engine.js`：纯规则引擎（服务器和浏览器共用）
- `party.js`：聚会模式的房间
- `public/`：大屏 `play.js`、手机 `phone.js`

## 素材

- 角色头像：[Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)（MIT），见 `public/avatars/LICENSE.txt`
- 国旗：[flag-icons](https://github.com/lipis/flag-icons)（MIT），见 `public/flags/LICENSE-flag-icons.txt`
- 二维码：[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）
