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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
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

          const currentMessageRole = current.role === "system" ? "USER" : current.role.toUpperCase();

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
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let index = 0;
      while (index < responseContent.length) {
          const chunkSize = Math.floor(Math.random() * (30 - 16)) + 15;
          const chunk = responseContent.slice(index, index + chunkSize);
          
          res.write(`data: ${JSON.stringify({
              id: uuidv4(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null
              }]
          })}\n\n`);
          
          index += chunkSize;
          await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
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
  // 生成WebSocket密钥
  static generateWebSocketKey() {
      return randomBytes(16).toString('base64');
  }

  // 创建WebSocket客户端
  static createWebSocketClient(requestPayload) {
      return new Promise((resolve, reject) => {
          const websocketKey = this.generateWebSocketKey();
          const ws = new WebSocket(CONFIG.API.BASE_URL, 'graphql-transport-ws', {
              headers: {
                  ...CONFIG.DEFAULT_HEADERS,
                  'Sec-WebSocket-Key': websocketKey,
              }
          });

          let responseContent = '';
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
                      }
                      break;
                  case 'complete':
                      isComplete = true;
                      ws.close();
                      resolve(responseContent);
                      break;
              }
          });

          ws.on('error', (err) => {
              console.error('WebSocket错误:', err);
              reject(err);
          });

          ws.on('close', (code, reason) => {
              console.log('请求完毕，关闭连接');
              if (!isComplete) {
                  reject(new Error('WebSocket closed unexpectedly'));
              }
          });
      });
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
                  context: requestPayload.systemMessage,
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

      ws.send(JSON.stringify(subscribeMessage));
  }

  // 处理聊天响应
  static async handleChatResponse(message) {
      if (message.payload && message.payload.data) {
          const chatResult = message.payload.data.newSessionChatResult;
          if (chatResult && chatResult.isEnd == true && chatResult.message) {
              return chatResult.message.content;
          }
      }
      return null;
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
app.get('/hf/v1/models', (req, res) => {
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
app.post('/hf/v1/chat/completions', async (req, res) => {
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

      const responseContent = await WebSocketUtils.createWebSocketClient(requestPayload);

      if (stream) {
          await ResponseHandler.handleStreamResponse(responseContent, model, res);
      } else {
          await ResponseHandler.handleNormalResponse(userMessage, responseContent, model, res);
      }
  } catch (error) {
      console.error('处理请求时发生错误:', error);
      res.status(500).json({ error: "内部服务器错误", details: error.message });
  }
});

// 404处理
app.use((req, res) => {
  res.status(404).json({ message: "请使用正确请求路径" });
});

// 启动服务器
app.listen(CONFIG.SERVER.PORT, () => {
  console.log(`服务器运行在 http://localhost:${CONFIG.SERVER.PORT}`);
});
