# Cursor 集成

将 tokenhop 与 Cursor IDE 集成,通过 tokenhop 的智能路由系统转发你的 AI 请求。

## 前置要求

- 已安装 Cursor IDE
- Cursor Pro 账户(使用自定义 API endpoint 必需)
- tokenhop 可通过公网 HTTPS 访问(见下文“将 tokenhop 暴露给 Cursor”)
- 来自 tokenhop 仪表盘的 API key

## ⚠️ 重要说明

> **必须使用公网 URL**:Cursor 会从自己的服务器发送请求,因此无法访问 `localhost`。请为你自己的 tokenhop 实例提供一个公网 HTTPS URL,例如仪表盘 **Endpoint** 页面提供的 Cloudflare tunnel 或 Tailscale Funnel URL,或部署在 VPS 上的实例。tokenhop 不提供托管网关。

> **必须有 Cursor Pro**:此功能需要 Cursor Pro 账户才能使用自定义 API endpoint。

## 设置

### 1. 打开 Cursor 设置

1. 打开 Cursor IDE
2. 进入 **Settings**(Cmd/Ctrl + ,)
3. 导航到 **Models** 部分

### 2. 启用 OpenAI API

1. 找到 **OpenAI API key** 选项
2. 启用开关以激活自定义 API 配置

### 3. 配置 Base URL

将 base URL 设为你的 tokenhop 实例的公网 URL,并在末尾加上 `/v1`:

```
https://<your-tokenhop-host>/v1
```

**步骤:**

1. 在 Models 设置中找到 **Base URL** 字段
2. 输入:`https://<your-tokenhop-host>/v1`
3. 点击 **Save**

### 4. 添加 API Key

1. 在 **API Key** 字段中输入你的 tokenhop API key
2. 可在 tokenhop 仪表盘 **Settings → API Keys** 中找到 API key
3. 点击 **Save**

### 5. 添加自定义模型

1. 点击 **View All Models** 按钮
2. 点击 **Add Custom Model**
3. 输入 tokenhop 配置中的模型名(例如 `gpt-4`、`claude-opus-4-5` 等)
4. 点击 **Add**

### 6. 选择模型

1. 在 Cursor 聊天界面,点击模型选择下拉菜单
2. 从列表中选择你的自定义模型
3. 开始在 Cursor 中使用 tokenhop!

## 配置示例

你的 Cursor 设置应如下所示:

```
OpenAI API: ✓ 已启用
Base URL: https://<your-tokenhop-host>/v1
API Key: sk-xxxxxxxxxxxxxxxx
Custom Models: gpt-4, claude-opus-4-5, gemini-2.0-flash
```

## 可用模型

你可以使用 tokenhop 仪表盘中配置的任意模型。常见示例:

| 模型名              | 提供商    | 描述              |
| ------------------- | --------- | ----------------- |
| `gpt-4`             | OpenAI    | GPT-4 Turbo       |
| `gpt-4o`            | OpenAI    | GPT-4 Optimized   |
| `claude-opus-4-5`   | Anthropic | Claude Opus 4.5   |
| `claude-sonnet-4-5` | Anthropic | Claude Sonnet 4.5 |
| `gemini-2.0-flash`  | Google    | Gemini 2.0 Flash  |

## 使用

### 聊天界面

1. 打开 Cursor 聊天(Cmd/Ctrl + L)
2. 从下拉菜单中选择模型
3. 通过 tokenhop 与 AI 对话

### 内联代码生成

1. 在编辑器中选中代码
2. 按 Cmd/Ctrl + K
3. 输入 prompt
4. Cursor 会通过 tokenhop 生成代码

### 代码解释

1. 在编辑器中选中代码
2. 按 Cmd/Ctrl + L
3. 询问 "Explain this code"
4. 通过 tokenhop 获得 AI 驱动的解释

## 故障排除

### "Invalid API Key" 错误

1. 在 tokenhop 仪表盘中确认 API key
2. 确保复制了包含 `sk-` 前缀在内的完整 key
3. 检查 API key 是否过期
4. 尝试重新生成 API key

### "Model Not Found" 错误

1. 确认模型名与 tokenhop 配置完全一致
2. 检查 tokenhop 仪表盘中提供商连接是否激活
3. 确认连接的提供商中包含该模型
4. 尝试使用完整模型名(例如用 `openai/gpt-4` 代替 `gpt-4`)

### 连接问题

1. 确认 Base URL 是你的 tokenhop 公网 URL 并加上 `/v1`(例如 `https://<your-tokenhop-host>/v1`)
2. 在浏览器中或用 `curl` 打开该 URL 的 `/v1/models`,确认它能从公网访问
3. 确认你的隧道(Cloudflare 或 Tailscale Funnel)或服务器仍在运行
4. 若启用了 VPN 或代理,尝试关闭

### Localhost 无法使用

> **请记住**:Cursor 不支持 localhost endpoint。请按下文所述将你的本地 tokenhop 实例暴露到公网,并使用该公网 URL。

## 将 tokenhop 暴露给 Cursor

如果你在本地运行 tokenhop 并希望搭配 Cursor 使用:

1. 打开 tokenhop 仪表盘 → **Endpoint**
2. 启用 **Cloudflare tunnel**(`*.trycloudflare.com` URL)或 **Tailscale Funnel**(需要已安装并登录 Tailscale)
3. 复制该公网 URL,并在末尾加上 `/v1` 后作为 Cursor 中的 Base URL
4. 开启 **Require API key**,确保只有你的 key 可以使用该公网 URL

或者,将 tokenhop 部署在带有公网域名和 HTTPS 的服务器上(参见[Cloud(VPS/Docker)](/zh-CN/deployment/cloud)),或将其置于你自己的反向代理或隧道之后。

## 最佳实践

1. **使用模型别名**:为常用模型在 tokenhop 中创建简短别名
2. **监控使用**:在 tokenhop 仪表盘查看用量统计和成本
3. **轮换 API Keys**:为安全起见定期轮换 API key
4. **测试模型**:尝试不同模型,找到最适合你场景的那个
