import express from 'express';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import cors from 'cors';
import dotenv from 'dotenv';

// 初始化环境变量
dotenv.config();

// 配置常量管理
class Config {
    static API = {
        BASE_URL: "wss://api.inkeep.com/graphql",
        API_KEY: process.env.API_KEY || "sk-123456",
        SYSTEM_MESSAGE: process.env.SYSTEM_MESSAGE || null,
        AUTH_TOKEN: 'Bearer ee5b7c15ed3553cd6abc407340aad09ac7cb3b9f76d8613a',
        ORG_ID: 'org_JfjtEvzbwOikUEUn',
        INTEGRATION_ID: 'clwtqz9sq001izszu8ms5g4om'
    };

    static MODELS = {
        'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022'
    };

    static SERVER = {
        PORT: process.env.PORT || 3000,
        BODY_LIMIT: '5mb',
        TIMEOUT: 5 * 60 * 1000,
        MAX_CONNECTIONS: 10
    };

    static WS_HEADERS = {
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
    };
}

// 日志工具类
class Logger {
    static getTimestamp() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    static info(message, ...args) {
        console.log(`[INFO ${this.getTimestamp()}] ${message}`, ...args);
    }

    static error(message, ...args) {
        console.error(`[ERROR ${this.getTimestamp()}] ${message}`, ...args);
    }

    static warn(message, ...args) {
        console.warn(`[WARN ${this.getTimestamp()}] ${message}`, ...args);
    }
}

// 消息处理工具类
class MessageUtils {
    static processContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n');
        }
        return typeof content === 'object' ? content.text || null : null;
    }

    static async getMessageDiff(prevContent, newContent) {
        return newContent.slice(prevContent.length);
    }
}

// AI API 客户端类
class AiApiClient {
    constructor(modelId) {
        this.modelId = Config.MODELS[modelId];
        if (!this.modelId) {
            throw new Error(`不支持的模型: ${modelId}`);
        }
    }

    async transformMessages(request) {
        let systemMessageList = [];
        let systemMergeMode = false;
        let closedSystemMergeMode = false;

        const contextMessages = await request.messages.reduce(async (accPromise, current) => {
            const acc = await accPromise;
            const currentContent = MessageUtils.processContent(current.content);

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

// WebSocket 连接管理器
class WebSocketManager {
    static connections = new Set();

    static canAddConnection() {
        return this.connections.size < Config.SERVER.MAX_CONNECTIONS;
    }

    static addConnection(ws) {
        this.connections.add(ws);
        Logger.info(`新增连接，当前连接数: ${this.connections.size}/${Config.SERVER.MAX_CONNECTIONS}`);
    }

    static removeConnection(ws) {
        this.connections.delete(ws);
        Logger.info(`移除连接，当前连接数: ${this.connections.size}/${Config.SERVER.MAX_CONNECTIONS}`);
    }

    static getConnectionCount() {
        return this.connections.size;
    }
}

// WebSocket 客户端类
class WebSocketClient {
    constructor(requestPayload, stream = false, res = null) {
        this.requestPayload = requestPayload;
        this.stream = stream;
        this.res = res;
        this.ws = null;
        this.timeoutId = null;
        this.responseContent = '';
        this.prevContent = '';
        this.isComplete = false;
        this.streamComplete = false;
    }

    async connect() {
        if (!WebSocketManager.canAddConnection()) {
            throw new Error(`连接数已达上限 (${Config.SERVER.MAX_CONNECTIONS})`);
        }

        try {
            return await this.createConnection();
        } catch (error) {
            this.cleanup();
            throw error;
        }
    }

    createConnection() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(Config.API.BASE_URL, 'graphql-transport-ws', {
                headers: {
                    ...Config.WS_HEADERS,
                    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
                }
            });

            WebSocketManager.addConnection(this.ws);
            this.setupTimeout(reject);
            this.setupEventHandlers(resolve, reject);
        });
    }

    setupTimeout(reject) {
        this.timeoutId = setTimeout(() => {
            this.cleanup();
            reject(new Error('WebSocket连接超时'));
        }, Config.SERVER.TIMEOUT);
    }

    setupEventHandlers(resolve, reject) {
        this.ws.on('open', () => this.handleOpen());
        this.ws.on('message', async (data) => {
            await this.handleMessage(data, resolve, reject);
        });
        this.ws.on('error', (error) => this.handleError(error, reject));
        this.ws.on('close', () => this.handleClose(reject));
    }

    handleOpen() {
        Logger.info('WebSocket连接已建立');
        const connectionInitMessage = {
            type: 'connection_init',
            payload: {
                headers: {
                    Authorization: Config.API.AUTH_TOKEN
                }
            }
        };
        this.ws.send(JSON.stringify(connectionInitMessage));
    }

    async handleMessage(data, resolve, reject) {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'connection_ack':
                    Logger.info('WebSocket连接认证成功');
                    this.sendChatSubscription();
                    if (this.stream && this.res) {
                        this.setupStreamHeaders();
                    }
                    break;

                case 'next':
                    const chatResponse = await this.processChatResponse(message);
                    if (chatResponse) {
                        this.responseContent = chatResponse;
                        if (this.stream && this.res) {
                            const diff = await MessageUtils.getMessageDiff(this.prevContent, this.responseContent);
                            if (diff) {
                                await ResponseHandler.handleStreamResponse(
                                    diff,
                                    "claude-3-5-sonnet-20241022",
                                    this.res
                                );
                                this.prevContent = this.responseContent;
                            }
                        }
                    }
                    break;

                case 'complete':
                    this.isComplete = true;
                    if (this.stream && this.res) {
                        this.res.write('data: [DONE]\n\n');
                        this.res.end();
                        this.streamComplete = true;
                    }
                    this.ws.close();
                    resolve(this.responseContent);
                    break;

                case 'error':
                    const errorMessage = message.payload[0].message;
                    // 检查是否为内存相关错误,进行降级处理,不抛出错误   
                    if (errorMessage.includes('maxmemory') || errorMessage.includes('Cannot process')) {
                        Logger.warn('WebSocket警告:', errorMessage);
                        if (this.stream && this.res && !this.streamComplete) {
                            this.res.write('data: [DONE]\n\n');
                            this.res.end();
                            this.isComplete = true;
                            this.ws.close();
                        } else {
                            resolve(this.responseContent);
                            this.isComplete = true;
                            this.ws.close();
                        }
                    } else {
                        Logger.error('WebSocket错误:', errorMessage);
                        if (this.stream && this.res && !this.streamComplete) {
                            this.res.write('data: [DONE]\n\n');
                            this.res.end();
                        }
                        this.ws.close();
                        reject(new Error(`WebSocket错误: ${errorMessage}`));
                    }
                    break;
            }
        } catch (error) {
            Logger.error('处理消息错误:', error);
            reject(error);
        }
    }

    handleError(error, reject) {
        // 检查是否为内存相关错误,进行降级处理   
        if (error.includes('maxmemory') || error.includes('Cannot process')) {
            Logger.warn('WebSocket警告:', error);
            return;
        }
        // 其他错误正常处理
        Logger.error('WebSocket错误:', error);
        this.cleanup();
        reject(error);
    }

    handleClose(reject) {
        Logger.info('WebSocket连接关闭');
        this.cleanup();
        if (!this.isComplete) {
            reject(new Error('WebSocket意外关闭'));
        }
    }

    setupStreamHeaders() {
        this.res.setHeader('Content-Type', 'text/event-stream');
        this.res.setHeader('Cache-Control', 'no-cache');
        this.res.setHeader('Connection', 'keep-alive');
    }

    sendChatSubscription() {
        const subscribeMessage = {
            id: uuidv4(),
            type: 'subscribe',
            payload: {
                variables: {
                    messageInput: this.requestPayload.contextMessages,
                    messageContext: null,
                    organizationId: Config.API.ORG_ID,
                    integrationId: Config.API.INTEGRATION_ID,
                    chatMode: 'AUTO',
                    context: this.requestPayload.systemMessage || Config.API.SYSTEM_MESSAGE,
                    messageAttributes: {},
                    includeAIAnnotations: false,
                    environment: 'production'
                },
                extensions: {},
                operationName: 'OnNewSessionChatResult',
                query: "subscription OnNewSessionChatResult($messageInput: String!, $messageContext: String, $organizationId: ID!, $integrationId: ID, $chatMode: ChatMode, $filters: ChatFiltersInput, $messageAttributes: JSON, $tags: [String!], $workflowId: String, $context: String, $guidance: String, $includeAIAnnotations: Boolean!, $environment: String) {\n  newSessionChatResult(\n    input: {messageInput: $messageInput, messageContext: $messageContext, organizationId: $organizationId, integrationId: $integrationId, chatMode: $chatMode, filters: $filters, messageAttributes: $messageAttributes, tags: $tags, workflowId: $workflowId, context: $context, guidance: $guidance, environment: $environment}\n  ) {\n    isEnd\n    sessionId\n    message {\n      id\n      content\n      __typename\n      ... on BotMessage {\n        citations {\n          citationNumber\n          title\n          url\n          rootRecordId\n          rootRecordType\n          __typename\n        }\n        __typename\n      }\n    }\n    aiAnnotations @include(if: $includeAIAnnotations) {\n      shouldEscalateToSupport {\n        strict\n        standard\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}"
            }
        };

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(subscribeMessage));
        }
    }

    getChatSubscriptionQuery() {
        return `subscription OnNewSessionChatResult(
            $messageInput: String!, 
            $messageContext: String, 
            $organizationId: ID!, 
            $integrationId: ID, 
            $chatMode: ChatMode, 
            $filters: ChatFiltersInput, 
            $messageAttributes: JSON, 
            $tags: [String!], 
            $workflowId: String, 
            $context: String, 
            $guidance: String, 
            $includeAIAnnotations: Boolean!, 
            $environment: String
        ) {
            newSessionChatResult(
                input: {
                    messageInput: $messageInput, 
                    messageContext: $messageContext, 
                    organizationId: $organizationId, 
                    integrationId: $integrationId, 
                    chatMode: $chatMode, 
                    filters: $filters, 
                    messageAttributes: $messageAttributes, 
                    tags: $tags, 
                    workflowId: $workflowId, 
                    context: $context, 
                    guidance: $guidance, 
                    environment: $environment
                }
            ) {
                isEnd
                sessionId
                message {
                    id
                    content
                }
                __typename
            }
        }`;
    }

    async processChatResponse(message) {
        if (message.payload?.data?.newSessionChatResult?.message) {
            return message.payload.data.newSessionChatResult.message.content;
        }
        return null;
    }

    cleanup() {
        clearTimeout(this.timeoutId);
        if (this.ws) {
            WebSocketManager.removeConnection(this.ws);
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
        }
    }
}

// 响应处理类
class ResponseHandler {
    static async handleStreamResponse(content, model, res) {
        const response = {
            id: uuidv4(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                delta: { content },
                finish_reason: null
            }]
        };

        res.write(`data: ${JSON.stringify(response)}\n\n`);
    }

    static async handleNormalResponse(userMessage, content, model, res) {
        const response = {
            id: uuidv4(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: content
                },
                finish_reason: "stop"
            }],
            usage: {
                prompt_tokens: userMessage.length,
                completion_tokens: content.length,
                total_tokens: userMessage.length + content.length
            }
        };

        res.json(response);
    }
}

// Express 应用配置
const app = express();

// 中间件配置
app.use(express.json({ limit: Config.SERVER.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: Config.SERVER.BODY_LIMIT }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 路由处理
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

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream } = req.body;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        if (authToken !== Config.API.API_KEY) {
            return res.status(401).json({ error: "未授权访问" });
        }

        const apiClient = new AiApiClient(model);
        const requestPayload = await apiClient.transformMessages(req.body); 
        const userMessage = messages.find(msg => msg.role === 'user')?.content;
        if (!userMessage) {
            return res.status(400).json({ error: "缺少用户消息" });
        }

        const wsClient = new WebSocketClient(requestPayload, stream, stream ? res : null);
        const responseContent = await wsClient.connect();

        if (!stream) {
            await ResponseHandler.handleNormalResponse(userMessage, responseContent, model, res);
        }
    } catch (error) {
        Logger.error('处理请求错误:', error);
        res.status(500).json({
            error: "服务器内部错误",
            message: error.message
        });
    }
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        message: "服务运行中，请使用正确的API路径"
    });
});

// 启动服务器
app.listen(Config.SERVER.PORT, () => {
    Logger.info(`服务器启动成功: http://localhost:${Config.SERVER.PORT}`);
});
