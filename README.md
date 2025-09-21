# DocsAnthropic2API 接入指南：基于 Docker 的实现

## 项目简介
本项目提供了一种简单、高效的方式通过 Docker 部署 DocsAnthropic2API 服务，并转换为 OpenAI 格式的 API。

## 支持模型
- claude-3-7-sonnet-20250219

## 获取方式

### 方法一：直接拉取镜像运行
#### 方式 A：Docker 命令
- **优点**：快速部署，开箱即用
- **步骤**：
```bash
docker run -it -d --name docsanthropic2api \
  -p 3000:3000 \
  -e API_KEY=your_api_key \
  -e PORT=3000 \
  -e INKEEP_AUTH_TOKEN=your_INKEEP_AUTH_TOKEN \
  yxmiler/docsanthropic2api:latest
```

#### 方式 B：Docker Compose
- **优点**：配置管理更简单，易于扩展
- **步骤**：
  1. 创建 `docker-compose.yml` 文件：
  ```yaml
  version: '3.8'
  services:
    docsanthropic2api:
      image: yxmiler/docsanthropic2api:latest
      container_name: docsanthropic2api
      ports:
        - "3000:3000"
      environment:
        - API_KEY=your_api_key
        - PORT=3000
        - INKEEP_AUTH_TOKEN=your_INKEEP_AUTH_TOKENe
      restart: unless-stopped
  ```
  
  2. 启动服务：
  ```bash
  docker-compose up -d
  ```

  3. 查看运行状态：
  ```bash
  docker-compose ps
  ```

  4. 停止服务：
  ```bash
  docker-compose down
  ```

### 方法二 使用deno快速搭建
以下是deno的代码，复制即用
```ts
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";

// 配置
const config = {
    PORT: 3000,
    API_KEY: 'sk-123456',
    INKEEP_CONFIG: {
        CHALLENGE_URL: 'https://api.inkeep.com/v1/challenge',
        CHAT_URL: 'https://api.inkeep.com/v1/chat/completions',
        DEFAULT_AUTH_TOKEN: '8f9c3d77d99a05677fd5bdf7a1f4fc1a6e65ce12aabe65cf',
        DEFAULT_REFERER: 'https://docs.claude.com/',
        DEFAULT_ORIGIN: 'https://docs.claude.com'
    },
    modelMapping: {
        'claude-3-7-sonnet-20250219': 'inkeep-qa-expert'
    }
};

// 类型定义
interface TextContent {
    type: 'text';
    text: string;
}

interface ImageContent {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: string;
    };
}

type ContentPart = TextContent | ImageContent;

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
}

interface ChatCompletionRequest {
    messages: Message[];
    model?: string;
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
}

interface InkeepResponse {
    choices: Array<{
        message?: { content: string };
        delta?: { content?: string };
        finish_reason?: string;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

// 挑战破解类
class InkeepChallenge {
    /**
     * 使用高效的算法
     */
    static async solveChallengeOptimized(algorithm: string, challenge: string, maxnumber: number, salt: string): Promise<number> {
        const encoder = new TextEncoder();
        const batchSize = 1000;
        
        // 预计算盐值的编码
        const saltBuffer = encoder.encode(salt);
        
        for (let start = 0; start <= maxnumber; start += batchSize) {
            const end = Math.min(start + batchSize - 1, maxnumber);
            const promises = [];
            
            for (let number = start; number <= end; number++) {
                // 直接构建完整的数据缓冲区
                const numberStr = number.toString();
                const numberBuffer = encoder.encode(numberStr);
                const fullBuffer = new Uint8Array(saltBuffer.length + numberBuffer.length);
                fullBuffer.set(saltBuffer);
                fullBuffer.set(numberBuffer, saltBuffer.length);
                
                promises.push({
                    number,
                    hashPromise: crypto.subtle.digest('SHA-256', fullBuffer)
                });
            }
            
            // 等待所有哈希计算完成
            const results = await Promise.all(promises.map(p => p.hashPromise));
            
            // 检查结果
            for (let i = 0; i < results.length; i++) {
                const hashArray = Array.from(new Uint8Array(results[i]));
                const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                if (hash === challenge) {
                    return promises[i].number;
                }
            }
        }
        
        return -1;
    }

    /**
     * 解决 Inkeep 的工作量证明挑战
     */
    static async solveChallenge(): Promise<string | null> {
        try {
            const response = await fetch(config.INKEEP_CONFIG.CHALLENGE_URL, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                    'origin': config.INKEEP_CONFIG.DEFAULT_ORIGIN,
                    'referer': config.INKEEP_CONFIG.DEFAULT_REFERER,
                }
            });

            if (!response.ok) {
                throw new Error(`获取挑战失败: ${response.status} ${response.statusText}`);
            }

            const challengeData = await response.json();
            const { algorithm, challenge, maxnumber, salt } = challengeData;

            const startTime = Date.now();
            const solutionNumber = await this.solveChallengeOptimized(algorithm, challenge, maxnumber, salt);
            const endTime = Date.now();

            if (solutionNumber === -1) {
                throw new Error('破解挑战失败，未能找到正确的 number。');
            }

            const payload = { number: solutionNumber, ...challengeData };
            const jsonString = JSON.stringify(payload);
            const encoder = new TextEncoder();
            const uint8Array = encoder.encode(jsonString);
            
            let binary = '';
            uint8Array.forEach(byte => {
                binary += String.fromCharCode(byte);
            });
            
            return btoa(binary);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] 破解挑战时出错:`, error);
            return null;
        }
    }
}

// 工具类
class MessageUtils {
    /**
     * 提取文本内容，忽略图片
     */
    static extractTextContent(content: string | ContentPart[]): string {
        if (typeof content === 'string') {
            return content;
        }
        
        // 只保留text类型的内容，忽略image_url类型
        const textParts = content
            .filter((part): part is TextContent => part.type === 'text')
            .map(part => part.text);
        
        return textParts.join('\n');
    }

    /**
     * 将消息转换为大写role前缀格式的字符串
     */
    static convertMessagesToString(messages: Message[]): string {
        const messageParts: string[] = [];
        
        for (const message of messages) {
            const textContent = this.extractTextContent(message.content);
            if (textContent.trim()) {
                const rolePrefix = message.role.toUpperCase();
                messageParts.push(`${rolePrefix}: ${textContent}`);
            }
        }
        
        return messageParts.join('\n');
    }
    
    /**
     * 转换OpenAI消息格式为Inkeep格式
     */
    static convertToInkeepFormat(messages: Message[], params: any = {}): any {
        // 将所有消息转换为一个字符串，放在user role中
        const combinedMessage = this.convertMessagesToString(messages);
        
        const inkeepMessages = [{
            role: 'user',
            content: combinedMessage
        }];

        return {
            model: params.model,
            messages: inkeepMessages,
            temperature: params.temperature || 0.7,
            top_p: params.top_p || 1,
            max_tokens: params.max_tokens || 4096,
            frequency_penalty: params.frequency_penalty || 0,
            presence_penalty: params.presence_penalty || 0,
            stream: params.stream || false
        };
    }
    
    /**
     * 转换Inkeep响应为OpenAI格式
     */
    static convertFromInkeepFormat(inkeepResponse: InkeepResponse, model: string): any {
        let content = 'No response';
        
        try {
            const rawContent = inkeepResponse.choices[0]?.message?.content;
            if (rawContent) {
                // 尝试解析content中的JSON
                const parsedContent = JSON.parse(rawContent);
                content = parsedContent.content || rawContent;
            }
        } catch (error) {
            // 如果JSON解析失败，使用原始内容
            content = inkeepResponse.choices[0]?.message?.content || 'No response';
        }
        
        // 构造标准格式
        return {
            id: 'chatcmpl-' + Math.random().toString(36).substr(2, 9),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content
                },
                finish_reason: inkeepResponse.choices[0]?.finish_reason || 'stop'
            }],
            usage: {
                prompt_tokens: inkeepResponse.usage?.prompt_tokens || 0,
                completion_tokens: inkeepResponse.usage?.completion_tokens || 0,
                total_tokens: inkeepResponse.usage?.total_tokens || 0
            }
        };
    }
}

// 响应处理器
class ResponseHandler {
    /**
     * 处理流式响应
     */
    static async handleStreamResponse(inkeepResponse: Response, model: string): Promise<Response> {
        const responseId = 'chatcmpl-' + Math.random().toString(36).substr(2, 9);
        const timestamp = Math.floor(Date.now() / 1000);
        
        const readable = new ReadableStream({
            async start(controller) {
                try {
                    if (!inkeepResponse.body) {
                        controller.close();
                        return;
                    }

                    const decoder = new TextDecoder();
                    let buffer = '';

                    // 使用异步迭代器处理流
                    for await (const chunk of inkeepResponse.body) {
                        buffer += decoder.decode(chunk, { stream: true });
                        let lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.trim().startsWith('data: ')) {
                                const dataContent = line.trim().substring(6);
                                
                                if (dataContent === '[DONE]') {
                                    continue;
                                }

                                try {
                                    const jsonData = JSON.parse(dataContent);
                                    const content = jsonData.choices[0]?.delta?.content;
                                    
                                    if (content) {
                                        // 转换为OpenAI格式的流式响应
                                        const chunk = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: timestamp,
                                            model: model,
                                            choices: [{
                                                index: 0,
                                                delta: { content: content },
                                                finish_reason: null
                                            }]
                                        };
                                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                                    } else if (jsonData.choices[0]?.finish_reason) {
                                        // 发送结束事件
                                        const endChunk = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: timestamp,
                                            model: model,
                                            choices: [{
                                                index: 0,
                                                delta: {},
                                                finish_reason: jsonData.choices[0].finish_reason
                                            }]
                                        };
                                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                                    }
                                } catch (e) {
                                    // 忽略无法解析的JSON行
                                }
                            }
                        }
                    }

                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                    controller.close();
                    
                } catch (error) {
                    console.error('Stream response error:', error);
                    const errorChunk = {
                        error: {
                            message: (error as Error).message,
                            type: 'server_error'
                        }
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                    controller.close();
                }
            }
        });

        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }
    
    /**
     * 处理非流式响应
     */
    static async handleNonStreamResponse(inkeepResponse: Response, model: string): Promise<Response> {
        try {
            const responseData = await inkeepResponse.json();
            
            // 转换为OpenAI格式
            const openaiResponse = MessageUtils.convertFromInkeepFormat(responseData, model);
            
            return new Response(JSON.stringify(openaiResponse), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('Non-stream response error:', error);
            return new Response(JSON.stringify({ 
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    
    /**
     * 调用Inkeep API
     */
    static async callInkeepApi(requestData: any): Promise<Response> {
        try {
            // 获取挑战解决方案
            const challengeSolution = await InkeepChallenge.solveChallenge();
            if (!challengeSolution) {
                throw new Error('无法获取挑战解决方案');
            }

            const headers = { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                'Accept': 'application/json', 
                'Content-Type': 'application/json',
                'accept-language': 'zh-CN,zh;q=0.9',
                'authorization': `Bearer ${config.INKEEP_CONFIG.DEFAULT_AUTH_TOKEN}`, 
                'cache-control': 'no-cache',
                'origin': config.INKEEP_CONFIG.DEFAULT_ORIGIN,
                'pragma': 'no-cache',
                'referer': config.INKEEP_CONFIG.DEFAULT_REFERER,
                'x-inkeep-challenge-solution': challengeSolution,
            };

            const response = await fetch(config.INKEEP_CONFIG.CHAT_URL, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Inkeep API error: ${response.status} ${response.statusText} ${errorText}`);
            }

            return response;
            
        } catch (error) {
            throw new Error(`Inkeep API error: ${(error as Error).message}`);
        }
    }
}

// API Key验证
function authenticateApiKey(request: Request): boolean {
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    
    const apiKey = authHeader.substring(7);
    return config.API_KEY === apiKey;
}

// 错误响应
function errorResponse(status: number, message: string, type: string = 'invalid_request_error', code: string = 'invalid_parameter'): Response {
    return new Response(JSON.stringify({
        error: {
            message,
            type,
            code
        }
    }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 路由处理
async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }
    
    // 健康检查
    if (pathname === '/health') {
        return new Response(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            models: Object.keys(config.modelMapping).length,
            service: 'Inkeep API Proxy'
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // API Key验证
    if (!authenticateApiKey(request)) {
        return errorResponse(401, 'Missing or invalid authorization header', 'invalid_request_error', 'invalid_api_key');
    }
    
    // 聊天完成API
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
        try {
            const body: ChatCompletionRequest = await request.json();
            const {
                messages,
                model = 'claude-3-7-sonnet-20250219',
                stream = false,
                temperature,
                top_p: topP,
                max_tokens,
                frequency_penalty,
                presence_penalty,
                ...otherParams
            } = body;
            
            // 验证必需参数
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return errorResponse(400, 'Messages array is required and cannot be empty');
            }
            
            console.log(`[${new Date().toISOString()}] Chat completion request: model=${model}, stream=${stream}, messages=${messages.length}`);
            
            // 映射模型名称
            const inkeepModel = config.modelMapping[model] || 'inkeep-context-expert';
            
            // 构建请求参数
            const requestParams: any = {
                model: inkeepModel,
                stream: stream,
                ...otherParams
            };
            
            if (temperature !== undefined) requestParams.temperature = temperature;
            if (topP !== undefined) requestParams.top_p = topP;
            if (max_tokens !== undefined) requestParams.max_tokens = max_tokens;
            if (frequency_penalty !== undefined) requestParams.frequency_penalty = frequency_penalty;
            if (presence_penalty !== undefined) requestParams.presence_penalty = presence_penalty;
            
            // 转换为Inkeep API格式
            const inkeepRequest = MessageUtils.convertToInkeepFormat(messages, requestParams);
            console.log(JSON.stringify(inkeepRequest,null,2));
            
            console.log(`[${new Date().toISOString()}] Inkeep request prepared for model: ${inkeepModel}`);
            
            // 调用Inkeep API
            const inkeepResponse = await ResponseHandler.callInkeepApi(inkeepRequest);
            
            // 根据stream参数选择响应方式
            if (stream) {
                return await ResponseHandler.handleStreamResponse(inkeepResponse, model);
            } else {
                return await ResponseHandler.handleNonStreamResponse(inkeepResponse, model);
            }
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in chat completions:`, error);
            return errorResponse(500, 'Internal server error', 'server_error', 'internal_error');
        }
    }
    
    // 模型列表API
    if (pathname === '/v1/models' && request.method === 'GET') {
        try {
            const models = Object.keys(config.modelMapping).map(modelId => ({
                id: modelId,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'inkeep',
                permission: [
                    {
                        id: 'modelperm-' + Math.random().toString(36).substr(2, 9),
                        object: 'model_permission',
                        created: Math.floor(Date.now() / 1000),
                        allow_create_engine: false,
                        allow_sampling: true,
                        allow_logprobs: true,
                        allow_search_indices: false,
                        allow_view: true,
                        allow_fine_tuning: false,
                        organization: '*',
                        group: null,
                        is_blocking: false
                    }
                ],
                root: modelId,
                parent: null
            }));
            
            return new Response(JSON.stringify({
                object: 'list',
                data: models
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
            
        } catch (error) {
            console.error('Error in models endpoint:', error);
            return errorResponse(500, 'Internal server error', 'server_error', 'internal_error');
        }
    }
    
    // 404处理
    return errorResponse(404, `Unknown request URL: ${request.method} ${pathname}`, 'invalid_request_error', 'not_found');
}

// 启动服务器
serve(handleRequest, { port: config.PORT });
```



### 方法三：本地构建镜像
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
    -p 3000:3000 \
    -e API_KEY=your_api_key \
    -e PORT=3000 \
    -e INKEEP_AUTH_TOKEN=your_INKEEP_AUTH_TOKEN \
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
- `PORT`：服务监听端口，可以自行修改（默认3000）
- `INKEEP_AUTH_TOKEN`：抓包获取的对应密钥

## 请求逻辑

### 消息处理
- **System 消息**：
  - 自动转换为 User 消息
- **User/Assistant 消息**：自动合并
- **请求格式**：OpenAI 格式，支持所有openai参数

### 上下文特点
- **注意**：当前实现的上下文为伪造上下文，可能存在一定程度的降智

## API 接口

### 获取模型列表
```bash
curl http://localhost:3000/v1/models 
```

### 聊天请求
```bash
curl http://localhost:3000/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer YOUR_API_KEY" \
-d '{
  "model": "claude-3-7-sonnet-20250219",
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
- 注意上下文限制，大概为30次对话轮换
- 可能存在一定延迟

## 注意事项
⚠️ 本项目仅供学习和研究目的，请遵守相关使用条款。

## 常见问题
- 确保 Docker 已正确安装
- 检查端口是否被占用
- 验证 API KEY 是否正确配置
