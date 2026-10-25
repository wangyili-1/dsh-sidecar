# 验证记录

日期：2026-10-25（Asia/Shanghai）。本地 Windows 11、Node.js 24.11.1、DeepSeek Harness 0.1.2-rc.1；DSH 官方固定版本源码提交为 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。运行原生 Web 客户端插件，使用 DSH 已有的认证连接及模型配置。

## 真实并发与取消

通过已安装 DSH 的 Session Controller 创建专用主、侧会话并进行真实模型调用。主任务执行短暂等待，侧聊同时回复；随后再次启动主任务和侧聊，只取消侧聊。

| 检查 | 结果 |
| --- | --- |
| 主、侧会话使用不同 ID | 通过 |
| 收到 `SIDE_DONE` 时主任务仍运行 | 通过 |
| 主任务随后完成并回复 `MAIN_DONE_A` | 通过 |
| 停止侧聊前主任务仍运行 | 通过 |
| 停止侧聊后主任务仍运行 | 通过 |
| 被指定的侧聊停止 | 通过 |
| 主任务最终完成并回复 `MAIN_DONE_B` | 通过 |

这次运行开始于 18:15:54，结束于 18:16:38。脱敏后的时间、检查和公开回复保存在 [acceptance.json](docs/acceptance.json)，不含凭据、请求头或模型推理。该记录验证会话运行与取消隔离，不宣称是文件系统隔离。

## 真实界面操作

在原生 DSH 中新建“DSH Sidecar 界面验收会话”，使用其真实文件和模型接口：

- 点击标题栏 Sidecar 后打开工作台；关闭后恢复原有工具详情。
- 文件面板读取 dsh-property-lab 的 humanize 原始报告，正确显示反例 `9007199254740993`，评估次数 146。
- 将报告加入上下文包并发送。侧聊实际回复中包含正确的输入、实际值 `9,007,199,254,740,992` 和期望值 `9,007,199,254,740,993`。
- 手动运行 `Write-Output 'SIDECAR_TERMINAL_OK 中文'`，获得完整中英文输出，退出码为 0。
- 在沙箱 iframe 中打开本机 HTTP 静态页面，显示 `SIDECAR_BROWSER_OK`。测试页面源码为 [preview.html](docs/preview.html)。
- 打开“送回主任务”预览，编辑内容并确认排队；原主会话收到补充并回复 `MAIN_UI_OK`。

![真实 DSH 网页预览及回传结果](docs/browser-preview.jpg)

上图保留初次功能验收时的样式。随后将界面调整为 DSH 原生黑灰风格，复用 `--dsw-*` 主题变量；实际检查了文件、命令、侧聊及回传预览，浏览器控制台无错误。当前外观见 [主界面](docs/sidecar-demo.jpg) 和 [回传弹窗](docs/neutral-dialog.jpg)。本次为外观调整，未再次调用模型执行并发验收。

截图来自实际运行的 DSH，验收时设置桌面视口以完整呈现双栏；没有使用生成式图片或模拟聊天替换结果。

## 自动化覆盖

最终 `npm test`：**34 项通过，0 失败、0 跳过**，用时约 2.43 秒。覆盖原生槽位开关及恢复、RPC 错误与取消信号、启动器版本及路径、跨主会话所有权、事件流与历史去重、上下文持久化、目录穿越及链接逃逸、文件与输出限额、中文命令输出、并发命令停止、大整数及 null 反例、终端句柄恢复、长消息预览及标题持久化。

`npm run build` 生成可加载的 Host 和 Web 客户端包；打包清单排除 `.local/`、运行日志、凭据和 node_modules。GitHub Actions 已提供 Windows/Linux × Node 22/24 的配置，尚未发布此仓库，因此不宣称远端 CI 已执行。

Windows 的 `Start-Sidecar.cmd -Doctor` 实际运行通过，自动找到已安装的 Node 和 DSH，退出码为 0。启动脚本只为当前 PowerShell 进程设置执行策略，不修改系统策略。

## 重跑真实验收（可选）

普通启动及 `npm test` 不调用模型。`scripts/acceptance-plugin.mjs` 是显式启用的 Windows 实机验收插件，会创建专用会话、调用已配置的模型并执行短暂 PowerShell 等待。先构建，然后为 DSH 准备额外 overlay（把路径改成自己的绝对路径）：

```json
[
  {
    "insert": [
      {
        "id": "sidecar-acceptance",
        "name": "file:///C:/path/to/dsh-sidecar/scripts/acceptance-plugin.mjs",
        "config": {
          "run": true,
          "defaultCwd": "C:/path/to/test-workspace",
          "mainWaitSeconds": 15,
          "timeoutMs": 120000
        }
      }
    ]
  }
]
```

用匹配版本 DSH CLI 的 `--profile web --patch PATH_TO_OVERLAY --host 127.0.0.1 --port 4092 --no-open` 启动；结果写入本项目 `.local/acceptance-latest.json`。模型延迟、网络、工具审批及额度可能使验收失败，应保留真实失败记录。正常 Sidecar 启动不加载此插件。

## 已知边界

- 首版适配 0.1.2-rc.1；新版本需要重新验证接口。GUI 实测平台为 Windows，其他平台尚未做真实 DSH 验收。
- 建议在普通桌面浏览器宽窗口使用；DSH 原有布局在很窄的嵌入预览窗口会隐藏右侧详情。
- 侧聊与主任务共享磁盘工作区。默认只分析是提示约定，模型权限由 DSH 执行，手动命令台使用本机用户权限。
- 命令台为非 PTY，每条命令从工作区启动；不支持交互式输入、全屏终端程序或保留上一条命令的 shell 状态。
- 命令限时 120 秒，保留输出上限 256 KiB。关闭和重开面板可恢复当前页中的命令句柄；整页刷新不恢复句柄，未完成的后台命令仍受超时限制。服务停止会清理自己的命令。
- 网页预览受网站嵌入策略限制；只发送用户明确提供的 URL 和片段，不能自动抓取任意跨域网页。
- Property Lab 摘要支持原始单报告及 `report` / `result` 包装；其他合集仅展示 JSON 原文。评估次数包含生成和收缩，不能当作不同输入数量。
