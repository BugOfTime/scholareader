# ScholaReader

ScholaReader 是一个类似 Scholaread 的学术论文阅读应用。项目以 UI 为先：先把阅读体验做好，论文的分析、翻译和排版交给大模型（Claude 或 ChatGPT）完成。

A Scholaread-style academic paper reader. UI-first: the reading experience comes first, while paper analysis, translation and layout are delegated to an LLM (Claude or ChatGPT).

## 功能 / Features

- 文献库：拖入或点“添加文章”导入 PDF，卡片显示阅读进度
- 逐段对照阅读：每段原文下面是中文译文，可切换“对照 / 原文 / 译文”
- AI 排版和翻译：整篇论文一次交给同一个模型，修复 PDF 断行、分栏，按章节重新排版
- AI 总结：一句话总结、研究问题、方法、结果、局限
- 划词解释：选中文字，AI 结合所在段落用中文解释
- 引用：点 [12] 跳到参考文献，侧栏“引用”列出全部文献并能打开原文链接
- 三种 AI 接入方式，任选其一：
  - **ChatGPT 订阅**：通过 OpenAI 官方的 Codex 工具使用你的 ChatGPT 额度，不需要 API Key
  - **Claude API**：填 Anthropic API Key，PDF 直接交给 Claude 读取
  - **OpenAI API**：填 OpenAI API Key

## 在 Mac 上运行 / Run on macOS

需要 [Node.js](https://nodejs.org) 20 或更高版本。

```bash
git clone https://github.com/BugOfTime/scholareader.git
cd scholareader
npm install
npm start
```

### 用 ChatGPT 订阅（推荐）

```bash
brew install codex        # 或者：npm install -g @openai/codex
codex login               # 在浏览器里用 ChatGPT 账号登录
```

然后在 App 的“设置”里选“ChatGPT 订阅”，点“重新检测”，显示“已用 ChatGPT 账号登录”即可。App 不接触你的 ChatGPT 账号密码，登录状态保存在 Codex 自己的 `~/.codex` 里。

### 用 API Key

在“设置”里选 Claude API 或 OpenAI API，填入 Key，点“测试连接”。Key 只保存在本机，用系统钥匙串加密。

## 数据存放位置

`~/Library/Application Support/scholareader/`：`library.json`（文献列表）、`papers/`（PDF 和 AI 结果）、`settings.json`。

## 开发 / Development

```bash
npm test     # 离线测试：PDF 文字提取、Claude 请求格式、Codex 调用（用模拟服务，不消耗额度）
```

代码结构：`src/main/`（Electron 主进程：存储、AI 调用、Codex 调用），`src/renderer/`（界面）。

## License

[MIT](LICENSE)
