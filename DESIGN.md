# 设计系统 v2 — 暗色玻璃拟态

> 实验工作区（E:\wallpaper-redesign）。目标：科技感 + 舒适感的桌面 UI 全量重写。
> 组件逻辑（React hooks / IPC）零改动，只动样式与布局结构。

## 视觉原则

| 维度 | 方案 |
|---|---|
| 底色 | 深空近黑 `#05070d` → `#0d1322` 亮度阶梯 |
| 环境氛围 | `.app::before` 三组径向光晕（青 9% / 靛 8% / 底光）+ `.app::after` 42px 细网格（mask 径向渐隐） |
| 玻璃 | `rgba(255,255,255,0.04)` 底 + `blur(22px) saturate(1.35)` + 顶部 1px 内高光 |
| 点缀色 | 青 `#22d3ee` → 靛 `#818cf8` 渐变（`--accent-grad`），克制使用 |
| 圆角 | 8 / 14 / 20 / 26px（比旧版整体放大，更柔和） |
| 阴影 | 低对比 + 大模糊（`0 24px 60px rgba(0,0,0,0.42)`），避免生硬 |
| 动效 | `cubic-bezier(0.22, 1, 0.36, 1)` 柔和缓出，140/240/380ms 三档 |
| 语义色 | success `#34d399` / warning `#fbbf24` / danger `#f87171` |

## 文件结构

- `base.css` — 设计令牌（:root）+ 全局（背景氛围、滚动条、顶栏、搜索、按钮、进度、容器）
- `sidebar.css` — 玻璃侧栏（目录 active 左侧青色发光条、网络入口玻璃卡、资源/隐私对话框玻璃）
- `gallery.css` — 玻璃视频卡片（hover 抬升 + 顶部青色光带、选中青色光晕、播放圆钮渐变、卡片菜单玻璃）
- `player.css` — 沉浸播放器（舞台保持纯黑、控制条/播放列表/菜单玻璃化）
- `settings.css` / `dock-downloads-ai.css` / `analysis.css` — token 化 + 容器玻璃化
- `light 主题` — 新体系浅色变体（`--glass-*` 反白），跟随用户设置

## 关键令牌（src/styles/base.css `:root`）

```css
--bg-primary: #05070d;  --bg-secondary: #090d17;  --bg-surface: #0d1322;
--glass-bg: rgba(255,255,255,0.04);
--glass-bg-strong: rgba(255,255,255,0.065);
--glass-border: rgba(255,255,255,0.08);
--glass-highlight: rgba(255,255,255,0.16);
--glass-blur: 22px;  --glass-saturate: 1.35;
--accent: #22d3ee;  --accent-2: #818cf8;
--accent-grad: linear-gradient(135deg, #22d3ee, #818cf8);
--radius-sm: 8px; --radius-md: 14px; --radius-lg: 20px; --radius-xl: 26px;
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
```

## 验证方式

Electron + `--remote-debugging-port=9222`，用 playwright-core 连 CDP 读取 computed style
断言（无视觉模型依赖）。已确认：侧栏/卡片/设置面板/播放器控制条玻璃效果全部生效。

## 后续待办

- [ ] 右侧 dock（下载中心/AI 搜索）手工走查细节
- [ ] 浅色主题细节打磨
- [ ] 低分辨率 / 窄窗口响应式检查
- [ ] 动画入场节奏统一（卡片 stagger）
