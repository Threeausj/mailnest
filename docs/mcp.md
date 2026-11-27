# MailNest MCP 接入

在 MailNest 中打开「设置 → 安全与 API」，复制 **MCP 服务器地址**。令牌类型选 **MCP 只读**，填写客户端名称并创建令牌。完整令牌只显示一次。

在客户端选择 **Streamable HTTP**，填写服务器地址和 Bearer 令牌。公网使用 HTTPS。例如，部署在 `mail.example.com` 时使用 `https://mail.example.com/api/v1/mcp`。如果客户端用 JSON 配置，可以参考以下常见格式，字段名以该客户端为准。

```json
{
  "mcpServers": {
    "mailnest": {
      "type": "http",
      "url": "https://mail.example.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer <你的 MCP 只读令牌>"
      }
    }
  }
}
```

客户端需支持对远程 MCP 服务发送自定义 `Authorization` 头。服务使用手动配置的 Bearer 令牌。撤销令牌后，后续请求立即失效。MCP 令牌与常规 API 令牌的使用范围独立。

| 工具 | 可用操作 |
| --- | --- |
| `list_accounts` | 列出已连接邮箱、状态及收件箱未读数 |
| `list_folders` | 根据 `accountId` 查看邮箱文件夹 |
| `search_messages` | 按主题、发件人或本地缓存正文搜索，可指定账号、文件夹、未读或星标和页码。省略关键词时列出邮件，默认合并收件箱，每页 20 封，最多 50 封 |
| `read_message` | 用搜索结果中的 `id` 作为 `messageId`，读取纯文本及附件元数据。每次最多 12,000 个字符，用 `nextOffset` 作为下次的 `offset` 继续读取。读取保留邮件的已读状态 |

邮箱和搜索结果来自 MailNest 同步缓存。读取正文优先使用本地缓存，缺失时按需读取 IMAP。传给客户端的邮件内容由客户端处理。

## 协议

端点为 `POST /api/v1/mcp`。支持按请求处理的 Streamable HTTP，包括使用 `initialize` 握手的客户端。每次请求携带 Bearer 令牌，POST 的 `Accept` 可同时包含 `application/json, text/event-stream`。独立 GET 流及 DELETE 会话请求返回 405。响应使用 `Cache-Control: no-store`。反向代理应保留 `Host` 和授权头。请求携带 `Origin` 时须与 `APP_URL` 一致。[MCP TypeScript SDK HTTP 文档](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard)

MCP 专用令牌可通过已登录会话发送 `POST /api/v1/tokens` 创建，参数为 `{"name":"我的 MCP 客户端","scope":"mcp-read"}`。列表和撤销沿用现有令牌接口。[API 文档](api.md)
