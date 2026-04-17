# PDF Reader AI

一个本地运行的 PDF 阅读助手：**阅读 → 选中 → AI 总结 → 加入知识库 → 随时基于上下文对话**。

## ✨ 功能

- 📄 打开桌面上的任意 PDF（例如 `WaveCrest.pdf`），使用 PDF.js 在浏览器内阅读，保留原版排版
- ✂️ 选中任意段落/句子后弹出浮动工具栏：
  - **📝 总结**：调用 LLM 提炼要点并保存到知识库
  - **⭐ 加入知识库**：直接收藏（不调用 LLM）
  - **💬 问 AI**：把选中的内容作为上下文，切到对话面板向 AI 提问
- 📚 **知识库**：按页码展示所有标注片段及其 AI 摘要，点击卡片可跳转回 PDF 对应页并高亮
- 💬 **对话**：与文档聊天，AI 会综合
  1. 你已经标注的知识片段（最近 20 条）
  2. 你**当前正在看的这一页的原文**
  3. 历史对话
  来回答，像一个私人的知识库助手
- ⚙️ 支持 **OpenAI** 和任意 **OpenAI 兼容接口**（DeepSeek、通义、Kimi、Ollama、本地 vLLM 网关……），在设置里切换
- 💾 全部数据持久化到本地 SQLite (`data/app.db`)，PDF 存到 `data/pdfs/`，不向任何第三方上传你的文件

## 🚀 快速开始

```bash
cd pdf-reader-ai
bash run.sh
```

首次运行会自动创建 `.venv` 虚拟环境并安装依赖，然后在 `http://127.0.0.1:8765` 启动服务。

浏览器打开后：
1. 右上角 **⚙** 填入 API Key / Base URL / Model
2. 点 **＋ 打开 PDF** 上传一个 PDF（比如桌面上的 `WaveCrest.pdf`）
3. 开始阅读，选中文字即可看到浮动工具栏

## 🧱 目录结构

```
pdf-reader-ai/
├── backend/
│   ├── main.py        # FastAPI 路由
│   ├── storage.py     # SQLite 持久化
│   └── llm.py         # OpenAI 兼容客户端封装
├── static/
│   ├── index.html     # 前端入口（PDF.js via CDN）
│   ├── styles.css
│   └── app.js         # 阅读器 + 选区工具栏 + 知识库 + 对话
├── data/
│   ├── app.db         # 运行后自动创建
│   └── pdfs/          # 上传的 PDF 按 hash 去重存储
├── requirements.txt
├── run.sh
└── README.md
```

## 🔧 推荐模型

| 场景 | 推荐 |
| --- | --- |
| 追求最高质量 | `gpt-4o` / `gpt-4.1` |
| 性价比平衡 | `gpt-4o-mini` |
| OpenAI 兼容 | `deepseek-chat` / `qwen-plus` / 任何 `/v1/chat/completions` 端点 |
| 完全本地 | Ollama + `qwen2.5:14b`（Base URL 填 `http://localhost:11434/v1`） |

## 🛠️ 常见问题

- **总结失败 / 对话失败**：先确认设置里 API Key 已保存，Base URL 正确（注意要带 `/v1`）。
- **PDF 文字选不了**：说明该 PDF 是扫描图，没有文字层。可先用 OCR 工具（如 ocrmypdf）处理。
- **文件存在哪**：所有 PDF 以内容 hash 为前缀存放在 `data/pdfs/`，换台机器只要拷贝整个 `data/` 即可迁移。
- **数据清理**：直接删除 `data/app.db` 和 `data/pdfs/` 即可重置。
