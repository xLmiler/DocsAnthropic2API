import express from 'express';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import cors from 'cors';
import dotenv from 'dotenv';

// 配置加载
dotenv.config();

// 配置常量
const CONFIG = {
    API: {
        BASE_URL: "wss://api.inkeep.com/graphql",
        API_KEY: process.env.API_KEY || "sk-123456",
        SYSTEM_MESSAGE: process.env.SYSTEM_MESSAGE || null
    },
    MODELS: {
        'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
    },
    SERVER: {
        PORT: process.env.PORT || 3000,
        BODY_LIMIT: '5mb'
    },
    DEFAULT_HEADERS: {
        'Host': 'api.inkeep.com',
        'Connection': 'Upgrade',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.72 Safari/537.36',
        'Upgrade': 'websocket',
        'Origin': 'https://docs.anthropic.com',
        'Sec-WebSocket-Version': '13',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
        'Sec-WebSocket-Protocol': 'graphql-transport-ws'
    }
};

// AI API 客户端类
class AiApiClient {
    constructor(modelId) {
        this.modelId = CONFIG.MODELS[modelId];
        if (!this.modelId) {
            throw new Error(`不支持的模型: ${modelId}`);
        }
    }

    // 处理消息内容
    processMessageContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n');
        }
        return typeof content === 'object' ? content.text || null : null;
    }

    // 转换消息格式
    async transformMessages(request) {
        let systemMessageList = [];
        let systemMergeMode = false;
        let closedSystemMergeMode = false;

        const contextMessages = await request.messages.reduce(async (accPromise, current) => {
            const acc = await accPromise;
            const currentContent = this.processMessageContent(current.content);

            if (currentContent === null) return acc;

            const currentMessageRole = current.role === "system" || current.role === "user" ? "Human" : "Assistant";

            // 系统消息处理逻辑
            if (current.role === "system") {
                if (!closedSystemMergeMode) {
                    systemMergeMode = true;
                    const lastSystemMessage = systemMessageList[systemMessageList.length - 1];

                    if (!lastSystemMessage) {
                        systemMessageList.push(currentContent);
                    } else {
                        systemMessageList[systemMessageList.length - 1] = `${lastSystemMessage}\n${currentContent}`;
                    }
                    return acc;
                }
            }

            // 关闭系统消息合并模式
            if (current.role !== "system" && systemMergeMode) {
                systemMergeMode = false;
                closedSystemMergeMode = true;
            }

            // 消息合并逻辑
            const previousMessage = acc[acc.length - 1];
            const newMessage = `${currentMessageRole}: ${currentContent}`;

            if (!previousMessage || previousMessage.startsWith(currentMessageRole)) {
                return previousMessage
                    ? [...acc.slice(0, -1), `${previousMessage}\n${currentContent}`]
                    : [...acc, newMessage];
            }

            return [...acc, newMessage];
        }, Promise.resolve([]));

        return {
            contextMessages: contextMessages.join('\n'),
            systemMessage: systemMessageList.join('\n')
        };
    }
}

// 响应处理类
class ResponseHandler {
    // 流式响应处理
    static async handleStreamResponse(responseContent, model, res) {
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
        }

        res.write(`data: ${JSON.stringify({
            id: uuidv4(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                delta: { content: responseContent },
                finish_reason: null
            }]
        })}\n\n`);
    }

    // 普通响应处理
    static async handleNormalResponse(userMessage, responseContent, model, res) {
        res.json({
            id: uuidv4(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: responseContent
                },
                finish_reason: "stop"
            }],
            usage: {
                prompt_tokens: userMessage.length,
                completion_tokens: responseContent.length,
                total_tokens: userMessage.length + responseContent.length
            }
        });
    }
}

// WebSocket工具类
class WebSocketUtils {
    static activeConnections = new Set(); // 跟踪活跃连接
    static TIMEOUT = 5 * 60 * 1000; // 5分钟超时时间
    static MAX_CONNECTIONS = 10; // 最大并发连接数

    // 生成WebSocket密钥
    static generateWebSocketKey() {
        return randomBytes(16).toString('base64');
    }
    static getMessageDiff(prevContent, newContent) {
        return newContent.slice(prevContent.length);
    }
    // 创建WebSocket客户端
    static async createWebSocketClient(requestPayload, stream = false, res = null) {
        // 检查当前连接数是否达到上限
        if (this.activeConnections.size >= this.MAX_CONNECTIONS) {
            throw new Error(`当前连接数已达到上限 (${this.MAX_CONNECTIONS})，请稍后重试！`);
        }

        let timeoutId;
        let ws;

        try {
            return await new Promise((resolve, reject) => {
                const websocketKey = this.generateWebSocketKey();
                ws = new WebSocket(CONFIG.API.BASE_URL, 'graphql-transport-ws', {
                    headers: {
                        ...CONFIG.DEFAULT_HEADERS,
                        'Sec-WebSocket-Key': websocketKey,
                    }
                });

                // 添加到活跃连接集合
                this.activeConnections.add(ws);
                console.log(`当前活跃连接数: ${this.activeConnections.size}/${this.MAX_CONNECTIONS}`);

                // 设置超时处理
                timeoutId = setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                    this.activeConnections.delete(ws);
                    console.log(`连接超时，当前活跃连接数: ${this.activeConnections.size}/${this.MAX_CONNECTIONS}`);
                    reject(new Error('WebSocket连接超时（5分钟）'));
                }, this.TIMEOUT);

                let responseContent = '';
                let prevContent = '';
                let isComplete = false;

                ws.on('open', () => {
                    console.log('WebSocket连接已建立');
                    const connectionInitMessage = {
                        type: 'connection_init',
                        payload: {
                            headers: {
                                Authorization: 'Bearer ee5b7c15ed3553cd6abc407340aad09ac7cb3b9f76d8613a'
                            }
                        }
                    };
                    ws.send(JSON.stringify(connectionInitMessage));
                });

                ws.on('message', async (data) => {
                    const message = data.toString();
                    const parsedMessage = JSON.parse(message);

                    switch (parsedMessage.type) {
                        case 'connection_ack':
                            console.log('WebSocket连接请求中');
                            this.sendChatSubscription(ws, requestPayload);
                            break;
                        case 'next':
                            const chatResponse = await this.handleChatResponse(parsedMessage);
                            if (chatResponse) {
                                responseContent = chatResponse;

                                if (stream && res) {
                                    const diff = this.getMessageDiff(prevContent, responseContent);
                                    if (diff) {
                                        console.log(diff);
                                        await ResponseHandler.handleStreamResponse(diff, "claude-3-5-sonnet-20241022", res);
                                        prevContent = responseContent;
                                    }
                                }
                            }
                            break;
                        case 'complete':
                            isComplete = true;
                            if (stream && res) {
                                res.write('data: [DONE]\n\n');
                                res.end();
                            }
                            ws.close();
                            resolve(responseContent);
                            break;
                        case 'error':
                            console.error('WebSocket错误:', parsedMessage.payload[0].message);
                            ws.close();
                            reject(new Error(`WebSocket错误: ${parsedMessage.payload[0].message}`));
                            break;
                    }
                });

                ws.on('error', (err) => {
                    console.error('WebSocket错误:', err);
                    clearTimeout(timeoutId);
                    this.activeConnections.delete(ws);
                    console.log(`连接错误，当前活跃连接数: ${this.activeConnections.size}/${this.MAX_CONNECTIONS}`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                    reject(err);
                });

                ws.on('close', (code, reason) => {
                    console.log('请求完毕，关闭连接');
                    clearTimeout(timeoutId);
                    this.activeConnections.delete(ws);
                    console.log(`连接关闭，当前活跃连接数: ${this.activeConnections.size}/${this.MAX_CONNECTIONS}`);
                    if (!isComplete) {
                        reject(new Error('WebSocket closed unexpectedly'));
                    }
                });
            });
        } catch (error) {
            clearTimeout(timeoutId);
            if (ws) {
                this.activeConnections.delete(ws);
                console.log(`发生错误，当前活跃连接数: ${this.activeConnections.size}/${this.MAX_CONNECTIONS}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
            throw error;
        }
    }

    // 发送聊天订阅
    static sendChatSubscription(ws, requestPayload) {
        const subscribeMessage = {
            id: uuidv4(),
            type: 'subscribe',
            payload: {
                variables: {
                    messageInput: requestPayload.contextMessages,
                    messageContext: null,
                    organizationId: 'org_JfjtEvzbwOikUEUn',
                    integrationId: 'clwtqz9sq001izszu8ms5g4om',
                    chatMode: 'AUTO',
                    context: requestPayload.systemMessage || CONFIG.API.SYSTEM_MESSAGE,
                    messageAttributes: {},
                    includeAIAnnotations: false,
                    environment: 'production'
                },
                extensions: {},
                operationName: 'OnNewSessionChatResult',
                query: `subscription OnNewSessionChatResult($messageInput: String!, $messageContext: String, $organizationId: ID!, $integrationId: ID, $chatMode: ChatMode, $filters: ChatFiltersInput, $messageAttributes: JSON, $tags: [String!], $workflowId: String, $context: String, $guidance: String, $includeAIAnnotations: Boolean!, $environment: String) {
                    newSessionChatResult(
                        input: {messageInput: $messageInput, messageContext: $messageContext, organizationId: $organizationId, integrationId: $integrationId, chatMode: $chatMode, filters: $filters, messageAttributes: $messageAttributes, tags: $tags, workflowId: $workflowId, context: $context, guidance: $guidance, environment: $environment}
                    ) {
                        isEnd
                        sessionId
                        message {
                            id
                            content
                        }
                        __typename
                    }
                }`
            }
        };
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(subscribeMessage));
        }
    }

    // 处理聊天响应
    static async handleChatResponse(message) {
        if (message.payload && message.payload.data) {
            const chatResult = message.payload.data.newSessionChatResult;
            if (chatResult && chatResult.message) {
                return chatResult.message.content;
            }
        }
        return null;
    }

    // 获取当前活跃连接数
    static getActiveConnectionsCount() {
        return this.activeConnections.size;
    }
}

// 创建Express应用
const app = express();

// 中间件配置
app.use(express.json({ limit: CONFIG.SERVER.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: CONFIG.SERVER.BODY_LIMIT }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));


// 获取模型列表路由
app.get('/v1/models', (req, res) => {
    res.json({
        object: "list",
        data: [{
            id: "claude-3-5-sonnet-20241022",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "claude",
        }]
    });
});

// 聊天完成路由
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream } = req.body;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (authToken !== CONFIG.API.API_KEY) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const apiClient = new AiApiClient(req.body.model);
        const requestPayload = await apiClient.transformMessages(req.body);

        const userMessage = messages.reverse().find(message => message.role === 'user')?.content;
        if (!userMessage) {
            return res.status(400).json({ error: "缺失用户消息" });
        }

        const responseContent = await WebSocketUtils.createWebSocketClient(requestPayload, stream, stream ? res : null);

        if (!stream) {
            await ResponseHandler.handleNormalResponse(userMessage, responseContent, model, res);
        }
    } catch (error) {
        console.error('处理请求时发生错误:', error);
        res.status(500).json({ error: "内部服务器错误，请查询日志记录！", details: error.message });
    }
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ message: "服务创建成功运行中，请根据规则使用正确请求路径" });
});

// 启动服务器
app.listen(CONFIG.SERVER.PORT, () => {
    console.log(`服务器运行在 http://localhost:${CONFIG.SERVER.PORT}`);
});
