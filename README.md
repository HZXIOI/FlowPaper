# FlowPaper

**中文** | [English](#english)

一款独立的桌面壁纸播放器，让你把任意视频设为应用的动态背景。

A standalone desktop wallpaper player that turns any video into a dynamic background for your apps.

### 下载 | Download

- **Windows x64**: [FlowPaper-v1.1.0-windows-x64.zip](https://github.com/HZXIOI/FlowPaper/releases/download/v1.1.0/FlowPaper-v1.1.0-windows-x64.zip) (137 MB)

---

## 中文

### 这是什么？

FlowPaper 是一个独立的桌面应用，让你把任意视频设为目标应用的背景。不用改代码、不用装插件，打开播放器、导入视频、一键应用即可。

### 功能

- 导入本地视频（MP4 / WebM / MOV / MKV / AVI）
- 自动截取视频帧作为封面缩略图
- 实时预览视频效果
- 一键应用背景
- 透明度自由调节（5% ~ 60%）
- 无需重启即可实时切换壁纸（首次需重启目标应用）
- 恢复目标应用默认界面
- 壁纸库文件夹管理，支持多视频
- 拖拽导入

### 使用方法

1. 下载并打开 FlowPaper
2. 点击「导入视频」或把视频文件拖入窗口
3. 在左侧视频库中选择要使用的视频
4. 调整「背景透明度」滑块
5. 点击「应用」
6. **首次使用需重启目标应用**，之后切换壁纸无需重启
7. 点击「恢复默认」可随时还原目标应用的原始界面

### 技术原理

播放器启动时会运行一个本地 HTTP 服务器（端口 9876），用于提供视频流。点击「应用」时，播放器会修改目标应用安装目录下的入口 HTML 文件，注入一个全屏 `<video>` 标签和 WebSocket 脚本。

- **首次应用**：注入 HTML + CSS，需要重启目标应用加载
- **后续切换**：通过 WebSocket 通知目标应用刷新视频源，实时切换
- **恢复默认**：从备份还原入口 HTML，删除注入的 CSS

### 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 打包
npm run build:installer
```

技术栈：Electron + React + TypeScript + Vite + WebSocket

### 兼容性说明

本软件的核心原理是通过修改 Electron 应用的入口 HTML 文件注入视频背景。**所有基于 Electron 框架开发的桌面应用都可以支持**，包括但不限于：

- **开发工具**：VS Code, Cursor, Windsurf, Codex, WebStorm, Figma
- **沟通协作**：飞书, 钉钉, Discord, Slack, Notion, Teams
- **娱乐休闲**：Spotify, 抖音, Bilibili, Obsidian, Telegram
- **实用工具**：Docker Desktop, Postman, GitKraken

**注意：目前仅 Trae 已完成适配，其他软件需要单独适配入口文件路径。** 欢迎社区贡献适配方案。

只需修改 `src/electron/main.ts` 中的 `DEFAULT_TRAE_PATH` 和目标 HTML 文件路径即可适配其他应用。

---

## English

### What is this?

FlowPaper is a standalone desktop application that lets you set any video as the background of a target app. No code changes, no plugins — just open the player, import a video, and apply with one click.

### Features

- Import local videos (MP4 / WebM / MOV / MKV / AVI)
- Auto-capture video frames as thumbnail covers
- Real-time video preview
- One-click apply background
- Adjustable opacity (5% ~ 60%)
- Instant wallpaper switching without restarting the target app (first use requires restart)
- Restore the target app's default interface
- Wallpaper library folder management with multi-video support
- Drag-and-drop import

### Usage

1. Download and open FlowPaper
2. Click "Import Video" or drag video files into the window
3. Select a video from the library on the left
4. Adjust the "Background Opacity" slider
5. Click "Apply"
6. **Restart the target app on first use** — after that, switching wallpapers requires no restart
7. Click "Restore Default" to revert the target app to its original interface at any time

### How It Works

The player runs a local HTTP server (port 9876) to serve video streams. When you click "Apply", the player modifies the target app's entry HTML file, injecting a fullscreen `<video>` tag and a WebSocket script.

- **First apply**: Injects HTML + CSS, requires a target app restart to load
- **Subsequent switches**: WebSocket notifies the target app to refresh the video source instantly
- **Restore default**: Restores the entry HTML from backup and removes injected CSS

### Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build installer
npm run build:installer
```

Tech stack: Electron + React + TypeScript + Vite + WebSocket

### Compatibility

The core principle is injecting video backgrounds by modifying the entry HTML file of Electron apps. **All Electron-based desktop applications are theoretically supported**, including but not limited to:

- **Dev Tools**: VS Code, Cursor, Windsurf, Codex, WebStorm, Figma
- **Communication**: Feishu, DingTalk, Discord, Slack, Notion, Teams
- **Entertainment**: Spotify, Douyin, Bilibili, Obsidian, Telegram
- **Utilities**: Docker Desktop, Postman, GitKraken

**Note: Currently only Trae has been adapted. Other software requires individual adaptation of entry file paths.** Community contributions for adaptations are welcome.

To adapt for other apps, simply modify `DEFAULT_TRAE_PATH` and the target HTML file path in `src/electron/main.ts`.

---

## License

MIT
