import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';
import cors from 'cors';

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Inkeep API 配置
const INKEEP_CONFIG = {
    CHALLENGE_URL: 'https://api.inkeep.com/v1/challenge',
    CHAT_URL: 'https://api.inkeep.com/v1/chat/completions',
    DEFAULT_AUTH_TOKEN: process.env.INKEEP_AUTH_TOKEN || null,
    DEFAULT_REFERER: 'https://docs.anthropic.com/',
    DEFAULT_ORIGIN: 'https://docs.anthropic.com'
};

// 全局配置
const config = {
    // 自定义的API Key从环境变量加载
    API_KEY: process.env.API_KEY || 'sk-123456',
    
    // 模型映射配置
    modelMapping: {
        'claude-3-7-sonnet-20250219': 'inkeep-qa-expert'
    }
};

// 挑战破解类
class InkeepChallenge {
    /**
     * 根据指定的算法和数据计算哈希值
     * @param {string} algorithm - 哈希算法 (例如 'SHA-256')
     * @param {string} data - 要哈希的数据
     * @returns {string} - 十六进制格式的哈希字符串
     */
    static calculateHash(algorithm, data) {
        const hashAlgorithm = algorithm.toLowerCase().replace('-', '');
        return crypto.createHash(hashAlgorithm).update(data).digest('hex');
    }

    /**
     * 解决 Inkeep 的工作量证明挑战
     * @returns {Promise<string|null>} - Base64 编码后的解决方案字符串，如果失败则返回 null
     */
    static async solveChallenge() {
        try {
            console.log(`[${new Date().toISOString()}] 正在获取 Inkeep 挑战...`);
            
            const response = await fetch(INKEEP_CONFIG.CHALLENGE_URL, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                    'origin': INKEEP_CONFIG.DEFAULT_ORIGIN,
                    'referer': INKEEP_CONFIG.DEFAULT_REFERER,
                }
            });

            if (!response.ok) {
                throw new Error(`获取挑战失败: ${response.status} ${response.statusText}`);
            }

            const challengeData = await response.json();
            const { algorithm, challenge, maxnumber, salt } = challengeData;

            console.log(`[${new Date().toISOString()}] 挑战获取成功，正在计算解决方案...`);
            const startTime = Date.now();

            let solutionNumber = -1;
            for (let number = 0; number <= maxnumber; number++) {
                const dataToHash = salt + number;
                if (this.calculateHash(algorithm, dataToHash) === challenge) {
                    solutionNumber = number;
                    break;
                }
            }
            
            const endTime = Date.now();

            if (solutionNumber === -1) {
                throw new Error('破解挑战失败，未能找到正确的 number。');
            }

            console.log(`[${new Date().toISOString()}] 挑战破解成功! Number: ${solutionNumber}, 耗时: ${endTime - startTime}ms`);

            const payload = { number: solutionNumber, ...challengeData };
            const jsonString = JSON.stringify(payload);
            return Buffer.from(jsonString).toString('base64');

        } catch (error) {
            console.error(`[${new Date().toISOString()}] 破解挑战时出错:`, error);
            return null;
        }
    }
}

// 工具类
class MessageUtils {
    /**
     * 提取消息中的文本内容
     * @param {string|Array} content 消息内容
     * @returns {string} 提取的文本内容
     */
    static extractTextContent(content) {
        if (typeof content === 'string') {
            return content;
        }
        
        if (Array.isArray(content)) {
            return content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('');
        }
        
        return '';
    }

    /**
     * 转换消息为格式化字符串
     * @param {Array} messages OpenAI格式的消息数组
     * @returns {string} 格式化的消息字符串
     */
    static convertMessagesToFormattedString(messages) {
        if (!messages || messages.length === 0) return '';
        
        const formattedMessages = [];
        
        for (const message of messages) {
            const role = message.role.toUpperCase();
            const textContent = this.extractTextContent(message.content);
            
            if (textContent.trim()) {
                formattedMessages.push(`${role}: ${textContent}`);
            }
        }
        
        return formattedMessages.join('\n');
    }
    
    /**
     * 转换OpenAI消息格式为Inkeep格式
     * @param {Array} messages 消息数组
     * @param {Object} params 其他参数
     * @returns {Object} Inkeep API格式的请求体
     */
    static convertToInkeepFormat(messages, params = {}) {
        // 将所有消息转换为一个格式化字符串
        const formattedContent = this.convertMessagesToFormattedString(messages);
        
        // 构建单个user消息
        const inkeepMessages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: formattedContent
                    }
                ]
            }
        ];
        
        return {
            model: params.model || 'inkeep-context-expert',
            messages: inkeepMessages,
            temperature: params.temperature || 0.7,
            top_p: params.top_p || 1,
            max_tokens: params.max_tokens || 2048,
            frequency_penalty: params.frequency_penalty || 0,
            presence_penalty: params.presence_penalty || 0,
            stream: params.stream || false
        };
    }
    
    /**
     * 转换Inkeep响应为OpenAI格式
     * @param {Object} inkeepResponse Inkeep API的响应
     * @param {string} model 模型名称
     * @returns {Object} OpenAI格式的响应
     */
    static convertFromInkeepFormat(inkeepResponse, model) {
        // 构造标准格式
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
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: inkeepResponse.usage?.prompt_tokens || 0,
                completion_tokens: inkeepResponse.usage?.completion_tokens || 0,
                total_tokens: inkeepResponse.usage?.total_tokens || 0
            }
        };
    }
}

// API Key验证中间件
const authenticateApiKey = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
            error: { 
                message: 'Missing or invalid authorization header',
                type: 'invalid_request_error',
                code: 'invalid_api_key'
            }
        });
    }
    
    const apiKey = authHeader.substring(7);
    
    if (config.API_KEY !== apiKey) {
        return res.status(401).json({ 
            error: { 
                message: 'Invalid API key provided',
                type: 'invalid_request_error',
                code: 'invalid_api_key'
            }
        });
    }
    
    req.apiKey = apiKey;
    next();
};

// 响应处理器
class ResponseHandler {
    /**
     * 处理流式响应
     * @param {Object} res Express响应对象
     * @param {Object} inkeepResponse Inkeep API的响应流
     * @param {string} model 模型名称
     */
    static async handleStreamResponse(res, inkeepResponse, model) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        try {
            const responseId = 'chatcmpl-' + Math.random().toString(36).substr(2, 9);
            const timestamp = Math.floor(Date.now() / 1000);
            
            await new Promise((resolve, reject) => {
                let buffer = '';
                
                // 监听数据事件
                inkeepResponse.body.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    let lines = buffer.split('\n');
                    buffer = lines.pop(); // 保留最后一行可能不完整的数据

                    for (const line of lines) {
                        if (line.trim().startsWith('data: ')) {
                            const dataContent = line.trim().substring(6);
                            
                            if (dataContent === '[DONE]') {
                                res.write('data: [DONE]\n\n');
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
                                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
                                    res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
                                }
                            } catch (e) {
                                // 忽略无法解析的JSON行
                            }
                        }
                    }
                });

                inkeepResponse.body.on('end', () => {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    resolve();
                });

                inkeepResponse.body.on('error', (err) => {
                    console.error('Stream response error:', err);
                    const errorChunk = {
                        error: {
                            message: err.message,
                            type: 'server_error'
                        }
                    };
                    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                    res.end();
                    reject(err);
                });
            });
            
        } catch (error) {
            console.error('Stream response error:', error);
            const errorChunk = {
                error: {
                    message: error.message,
                    type: 'server_error'
                }
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.end();
        }
    }
    
    /**
     * 处理非流式响应
     * @param {Object} res Express响应对象
     * @param {Object} inkeepResponse Inkeep API的响应
     * @param {string} model 模型名称
     */
    static async handleNonStreamResponse(res, inkeepResponse, model) {
        try {
            const responseData = await inkeepResponse.json();
            
            // 转换为OpenAI格式
            const openaiResponse = MessageUtils.convertFromInkeepFormat(responseData, model);
            
            res.json(openaiResponse);
            
        } catch (error) {
            console.error('Non-stream response error:', error);
            res.status(500).json({ 
                error: {
                    message: 'Internal server error',
                    type: 'server_error',
                    code: 'internal_error'
                }
            });
        }
    }
    
    /**
     * 调用Inkeep API
     * @param {Object} requestData 请求数据
     * @returns {Object} API响应
     */
    static async callInkeepApi(requestData) {
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
                'authorization': `Bearer ${INKEEP_CONFIG.DEFAULT_AUTH_TOKEN}`, 
                'cache-control': 'no-cache',
                'origin': INKEEP_CONFIG.DEFAULT_ORIGIN,
                'pragma': 'no-cache',
                'referer': INKEEP_CONFIG.DEFAULT_REFERER,
                'x-inkeep-challenge-solution': challengeSolution,
            };

            const response = await fetch(INKEEP_CONFIG.CHAT_URL, {
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
            throw new Error(`Inkeep API error: ${error.message}`);
        }
    }
}

// 聊天完成API端点
app.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
    try {
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
        } = req.body;
        
        // 验证必需参数
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ 
                error: {
                    message: 'Messages array is required and cannot be empty',
                    type: 'invalid_request_error',
                    code: 'invalid_parameter'
                }
            });
        }
        
        console.log(`[${new Date().toISOString()}] Chat completion request: model=${model}, stream=${stream}, messages=${messages.length}`);
        
        // 映射模型名称
        const inkeepModel = config.modelMapping[model] || 'inkeep-context-expert';
        
        // 构建请求参数
        const requestParams = {
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
        
        console.log(`[${new Date().toISOString()}] Inkeep request prepared for model: ${inkeepModel}`);
        
        // 调用Inkeep API
        const inkeepResponse = await ResponseHandler.callInkeepApi(inkeepRequest);
        
        // 根据stream参数选择响应方式
        if (stream) {
            await ResponseHandler.handleStreamResponse(res, inkeepResponse, model);
        } else {
            await ResponseHandler.handleNonStreamResponse(res, inkeepResponse, model);
        }
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in chat completions:`, error);
        res.status(500).json({ 
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        });
    }
});

// 模型列表API端点
app.get('/v1/models', authenticateApiKey, (req, res) => {
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
        
        res.json({
            object: 'list',
            data: models
        });
        
    } catch (error) {
        console.error('Error in models endpoint:', error);
        res.status(500).json({ 
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        models: Object.keys(config.modelMapping).length,
        service: 'Inkeep API Proxy'
    });
});

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: {
            message: 'Internal server error',
            type: 'server_error',
            code: 'internal_error'
        }
    });
});

// 404处理
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: {
            message: `Unknown request URL: ${req.method} ${req.originalUrl}`,
            type: 'invalid_request_error',
            code: 'not_found'
        }
    });
});


if(INKEEP_CONFIG.DEFAULT_AUTH_TOKEN === null){
    console.log('请设置INKEEP_AUTH_TOKEN');
    process.exit(1);
}

// 启动服务器
app.listen(PORT, () => {
    console.log(`Inkeep API Proxy Server is running on port ${PORT}`);
});
