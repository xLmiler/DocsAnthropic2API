# DocsAnthropic2API 接入指南：基于 Docker 的实现

## 项目简介
本项目提供了一种简单、高效的方式通过 Docker 部署 DocsAnthropic2API 服务，并转换为 OpenAI 格式的 API。

## 支持模型
- claude-3-5-sonnet-20241022

## 获取方式

### 方法一：直接拉取镜像运行
- **优点**：快速部署，开箱即用
- **步骤**：
```bash
docker run -it -d --name docsanthropic2api \
  -p 8080:8080 \
  -e API_KEY=your_api_key \
  -e PORT=8080 \
  -e SYSTEM_MESSAGE=your_system_message \
  yxmiler/docsanthropic2api:latest
```

### 方法二：本地构建镜像
- **优点**：可以自定义镜像，更灵活
- **步骤**：
  1. 克隆仓库或下载项目文件
  2. 构建镜像：
  ```bash
  docker build -t yourusername/docsanthropic2api .
  ```
  3. 运行容器：
  ```bash
  docker run -it -d --name docsanthropic2api \
    -p 8080:8080 \
    -e API_KEY=your_api_key \
    -e PORT=8080 \
    -e SYSTEM_MESSAGE=your_system_message \
    yourusername/docsanthropic2api
  ```  
### 方法三：Render部署
- **步骤**：
    1. fork本仓库
    2. 进入[Render官网](https://dashboard.render.com/web)
    3. 创建免费实例和自定义环境变量即可
    4. 分配的url即为请求url
## 配置说明

### 环境变量
- `API_KEY`：鉴权密钥
  - **默认值**：`sk-123456`
  - **建议**：使用自定义密钥增强安全性
- `PORT`：服务监听端口，可以自行修改（默认8080）
- `SYSTEM_MESSAGE`：默认的系统提示词，仅在没有使用system规则时生效，默认关闭，值为string类型，可以自行设置

## 请求逻辑

### 消息处理
- **System 消息**：
  - 首次连续 System 消息会合并
  - 后续 System 消息自动转换为 User 消息
- **User/Assistant 消息**：自动合并
- **请求格式**：OpenAI 格式
- **并行限制**：最高支持10

### 上下文特点
- **注意**：当前实现的上下文为伪造上下文，可能存在一定程度的降智

## API 接口

### 获取模型列表
```bash
curl http://localhost:8080/v1/models 
```

### 聊天请求
```bash
curl http://localhost:8080/v1/chat/completions \
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
- **支持响应**：支持真流式和非流式输出

### 使用建议
- 建议使用自定义 API Key
- 注意上下文限制，大概为50k左右
- 可能存在一定延迟

## 注意事项
⚠️ 本项目仅供学习和研究目的，请遵守相关使用条款。

## 常见问题
- 确保 Docker 已正确安装
- 检查端口是否被占用
- 验证 API KEY 是否正确配置
