# DocsAnthropic2API 接入指南：基于 Hugging Face Spaces 的实现

## 项目简介
本项目提供了一种简单、高效的方式通过 Hugging Face Spaces 访问 DocsAnthropic2API 服务,并且转换为openAI格式。

## 支持模型
- claude-3-5-sonnet-20241022
## 获取方式

### 方法一：GitHub 仓库部署
- **地址**：[DocsAnthropic2API](https://github.com/xLmiler/DocsAnthropic2API)
- **优点**：独立部署，降低被封风险
- **步骤**：
  1. 克隆仓库或者下载仓库文件
  2. 在 Hugging Face 创建空间为docker，并且上传文件
  3. 部署项目

### 方法二：直接复制空间
- **地址**：[ClaudeService](https://huggingface.co/spaces/yxmiler/ClaudeService)
- **优点**：快速部署，开箱即用

## 配置说明

### 环境变量
- `API_KEY`：鉴权密钥
- **默认值**：`sk-123456`
- **建议**：使用自定义密钥增强安全性

## 请求逻辑

### 消息处理
- **System 消息**：
  - 首次连续 System 消息会合并
  - 后续 System 消息自动转换为 User 消息
- **User/Assistant 消息**：自动合并
- **请求格式类型**：openAI格式

### 上下文特点
- **注意**：当前实现的上下文为伪造上下文，可能存在一定程度的降智

## API 接口
 - 根据抱脸用户名和项目名字构建请求url: https://用户名-项目名字.hf.space/hf/v1
## 获取模型列表
```
curl https://用户名-项目名字.hf.space/hf/v1/models 
```
## 聊天请求
```
curl https://用户名-项目名字.hf.space/hf/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer YOUR_API_KEY" \
-d '{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user", 
      "content": "Hello, can you help me?"
    }
  ]
}'
```

### 响应处理
- **当前支持响应**：流式和非流，
- **性能**：流式响应为非流进行模拟流式，可能略慢于非流式请求

### 使用建议
- 建议使用自定义 API Key
- 注意上下文限制，大概为50k左右
- 延迟略高

## 注意事项
⚠️ 本项目仅供学习和研究目的，请遵守相关使用条款。
