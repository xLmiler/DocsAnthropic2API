import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';
import cors from 'cors';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();
// 配置常量
const CONFIG = {
    MODELS: {
        'grok-latest': 'grok-latest',
        'grok-latest-image': 'grok-latest',
        'grok-latest-search': 'grok-latest'
    },
    API: {
        BASE_URL: "https://grok.com",
        API_KEY: process.env.API_KEY || "sk-123456",
        SSO_TOKEN: null,//登录时才有的认证cookie,这里暂时用不到，之后可能需要
        SIGNATURE_COOKIE: null,
        PICGO_KEY: process.env.PICGO_KEY || null //想要生图的话需要填入这个PICGO图床的key
    },
    SERVER: {
        PORT: process.env.PORT || 3000,
        BODY_LIMIT: '5mb'
    },
    RETRY: {
        MAX_ATTEMPTS: 1,//重试次数
        DELAY_BASE: 1000 // 基础延迟时间（毫秒）
    },
    ISSHOW_SEARCH_RESULTS: process.env.ISSHOW_SEARCH_RESULTS === 'true',//是否显示搜索结果,默认关闭
    CHROME_PATH: process.env.CHROME_PATH || "/usr/bin/chromium"//chrome路径
};

// 请求头配置
const DEFAULT_HEADERS = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'content-type': 'text/plain;charset=UTF-8',
    'Connection': 'keep-alive',
    'origin': 'https://grok.com',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'baggage': 'sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c'
};

class Utils {
    static async extractGrokHeaders() {
        console.log("开始提取头信息");
        try {
            // 启动浏览器
            const browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                executablePath: CONFIG.CHROME_PATH
            });

            const page = await browser.newPage();
            await page.goto('https://grok.com/', { waitUntil: 'networkidle0' });

            // 获取所有 Cookies
            const cookies = await page.cookies();
            const targetHeaders = ['x-anonuserid', 'x-challenge', 'x-signature'];
            const extractedHeaders = {};
            // 遍历 Cookies
            for (const cookie of cookies) {
                // 检查是否为目标头信息
                if (targetHeaders.includes(cookie.name.toLowerCase())) {
                    extractedHeaders[cookie.name.toLowerCase()] = cookie.value;
                }
            }
            // 关闭浏览器
            await browser.close();
            // 打印并返回提取的头信息
            console.log('提取的头信息:', JSON.stringify(extractedHeaders, null, 2));
            return extractedHeaders;

        } catch (error) {
            console.error('获取头信息出错:', error);
            return null;
        }
    }
    static async get_signature() {
        if (CONFIG.API.SIGNATURE_COOKIE) {
            return CONFIG.API.SIGNATURE_COOKIE;
        }
        console.log("刷新认证信息");
        let retryCount = 0;
        while (retryCount < CONFIG.RETRY.MAX_ATTEMPTS) {
            let headers = await Utils.extractGrokHeaders();
            if (headers) {
                console.log("获取认证信息成功");
                CONFIG.API.SIGNATURE_COOKIE = { cookie: `x-anonuserid=${headers["x-anonuserid"]}; x-challenge=${headers["x-challenge"]}; x-signature=${headers["x-signature"]}` };
                return CONFIG.API.SIGNATURE_COOKIE;
            }
            retryCount++;
            if (retryCount >= CONFIG.RETRY.MAX_ATTEMPTS) {
                throw new Error(`获取认证信息失败!`);
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY.DELAY_BASE * retryCount));
        }
    }
    static async handleError(error, res) {
        // 如果是500错误且提供了原始请求函数，尝试重新获取签名并重试
        if (String(error).includes("status: 500")) {
            try {
                await Utils.get_signature();
                if (CONFIG.API.SIGNATURE_COOKIE) {
                    return res.status(500).json({
                        error: {
                            message: `${retryError.message}已重新刷新认证信息，请重新对话`,
                            type: 'server_error',
                            param: null,
                            code: retryError.code || null
                        }
                    });
                } else {
                    return res.status(500).json({
                        error: {
                            message: "认证信息获取失败",
                            type: 'server_error',
                            param: null,
                            code: null
                        }
                    });
                }
            } catch (retryError) {
                console.error('重试失败:', retryError);
                return res.status(500).json({
                    error: {
                        message: `${retryError.message},认证信息获取失败`,
                        type: 'server_error',
                        param: null,
                        code: retryError.code || null
                    }
                });
            }
        }

        // 其他错误直接返回
        res.status(500).json({
            error: {
                message: error.message,
                type: 'server_error',
                param: null,
                code: error.code || null
            }
        });
    }
    static async organizeSearchResults(searchResults) {
        // 确保传入的是有效的搜索结果对象
        if (!searchResults || !searchResults.results) {
            return '';
        }

        const results = searchResults.results;
        const formattedResults = results.map((result, index) => {
            // 处理可能为空的字段
            const title = result.title || '未知标题';
            const url = result.url || '#';
            const preview = result.preview || '无预览内容';

            return `\r\n<details><summary>资料[${index}]: ${title}</summary>\r\n${preview}\r\n\n[Link](${url})\r\n</details>`;
        });
        return formattedResults.join('\n\n');
    }
}


class GrokApiClient {
    constructor(modelId) {
        if (!CONFIG.MODELS[modelId]) {
            throw new Error(`不支持的模型: ${modelId}`);
        }
        this.modelId = CONFIG.MODELS[modelId];
    }

    processMessageContent(content) {
        if (typeof content === 'string') return content;
        return null;
    }
    // 获取图片类型
    getImageType(base64String) {
        let mimeType = 'image/jpeg';
        if (base64String.includes('data:image')) {
            const matches = base64String.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
            if (matches) {
                mimeType = matches[1];
            }
        }
        const extension = mimeType.split('/')[1];
        const fileName = `image.${extension}`;

        return {
            mimeType: mimeType,
            fileName: fileName
        };
    }

    async uploadBase64Image(base64Data, url) {
        try {
            // 处理 base64 数据
            let imageBuffer;
            if (base64Data.includes('data:image')) {
                imageBuffer = base64Data.split(',')[1];
            } else {
                imageBuffer = base64Data
            }
            const { mimeType, fileName } = this.getImageType(base64Data);
            let uploadData = {
                rpc: "uploadFile",
                req: {
                    fileName: fileName,
                    fileMimeType: mimeType,
                    content: imageBuffer
                }
            };
            console.log("发送图片请求");
            // 发送请求
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    ...CONFIG.DEFAULT_HEADERS,
                    ...CONFIG.API.SIGNATURE_COOKIE
                },
                body: JSON.stringify(uploadData)
            });

            if (!response.ok) {
                console.error(`上传图片失败,状态码:${response.status},原因:${response.error}`);
                return '';
            }

            const result = await response.json();
            console.log('上传图片成功:', result);
            return result.fileMetadataId;

        } catch (error) {
            console.error('上传图片失败:', error);
            return '';
        }
    }

    async prepareChatRequest(request) {

        if (request.model === 'grok-latest-image' && !CONFIG.API.PICGO_KEY) {
            throw new Error(`该模型需要配置PICGO图床密钥!`);
        }
        var todoMessages = request.messages;
        if (request.model === 'grok-latest-image' || request.model === 'grok-latest-search') {
            todoMessages = Array.isArray(todoMessages) ? [todoMessages[todoMessages.length - 1]] : [todoMessages];;
        }
        let fileAttachments = [];
        let messages = '';
        let lastRole = null;
        let lastContent = '';
        let search = false;

        const processImageUrl = async (content) => {
            if (content.type === 'image_url' && content.image_url.url.includes('data:image')) {
                const imageResponse = await this.uploadBase64Image(
                    content.image_url.url,
                    `${CONFIG.API.BASE_URL}/api/rpc`
                );
                return imageResponse;
            }
            return null;
        };

        for (const current of todoMessages) {
            const role = current.role === 'assistant' ? 'assistant' : 'user';
            let textContent = '';
            // 处理消息内容
            if (Array.isArray(current.content)) {
                // 处理数组内的所有内容
                for (const item of current.content) {
                    if (item.type === 'image_url') {
                        // 如果是图片且是最后一条消息，则处理图片
                        if (current === todoMessages[todoMessages.length - 1]) {
                            const processedImage = await processImageUrl(item);
                            if (processedImage) fileAttachments.push(processedImage);
                        }
                        textContent += (textContent ? '\n' : '') + "[图片]";//图片占位符
                    } else if (item.type === 'text') {
                        textContent += (textContent ? '\n' : '') + item.text;
                    }
                }
            } else if (typeof current.content === 'object' && current.content !== null) {
                // 处理单个对象内容
                if (current.content.type === 'image_url') {
                    // 如果是图片且是最后一条消息，则处理图片
                    if (current === todoMessages[todoMessages.length - 1]) {
                        const processedImage = await processImageUrl(current.content);
                        if (processedImage) fileAttachments.push(processedImage);
                    }
                    textContent += (textContent ? '\n' : '') + "[图片]";//图片占位符
                } else if (current.content.type === 'text') {
                    textContent = current.content.text;
                }
            } else {
                // 处理普通文本内容
                textContent = this.processMessageContent(current.content);
            }
            // 添加文本内容到消息字符串
            if (textContent) {
                if (role === lastRole) {
                    // 如果角色相同，合并消息内容
                    lastContent += '\n' + textContent;
                    messages = messages.substring(0, messages.lastIndexOf(`${role.toUpperCase()}: `)) +
                        `${role.toUpperCase()}: ${lastContent}\n`;
                } else {
                    // 如果角色不同，添加新的消息
                    messages += `${role.toUpperCase()}: ${textContent}\n`;
                    lastContent = textContent;
                    lastRole = role;
                }
            } else if (current === todoMessages[todoMessages.length - 1] && fileAttachments.length > 0) {
                // 如果是最后一条消息且有图片附件，添加空消息占位
                messages += `${role.toUpperCase()}: [图片]\n`;
            }
        }

        if (fileAttachments.length > 4) {
            fileAttachments = fileAttachments.slice(0, 4); // 最多上传4张
        }

        messages = messages.trim();

        if (request.model === 'grok-latest-search') {
            search = true;
        }
        return {
            message: messages,
            modelName: this.modelId,
            disableSearch: false,
            imageAttachments: [],
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            fileAttachments: fileAttachments,
            enableImageStreaming: false,
            imageGenerationCount: 1,
            toolOverrides: {
                imageGen: request.model === 'grok-latest-image',
                webSearch: search,
                xSearch: search,
                xMediaSearch: search,
                trendsSearch: search,
                xPostAnalyze: search
            }
        };
    }
}

class MessageProcessor {
    static createChatResponse(message, model, isStream = false) {
        const baseResponse = {
            id: `chatcmpl-${uuidv4()}`,
            created: Math.floor(Date.now() / 1000),
            model: model
        };

        if (isStream) {
            return {
                ...baseResponse,
                object: 'chat.completion.chunk',
                choices: [{
                    index: 0,
                    delta: {
                        content: message
                    }
                }]
            };
        }

        return {
            ...baseResponse,
            object: 'chat.completion',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: message
                },
                finish_reason: 'stop'
            }],
            usage: null
        };
    }
}

// 中间件配置
const app = express();
app.use(express.json({ limit: CONFIG.SERVER.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: CONFIG.SERVER.BODY_LIMIT }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// API路由
app.get('/v1/models', (req, res) => {
    res.json({
        object: "list",
        data: Object.keys(CONFIG.MODELS).map((model, index) => ({
            id: model,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "xai",
        }))
    });
});

app.post('/v1/chat/completions', async (req, res) => {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (authToken !== CONFIG.API.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const makeRequest = async () => {
        if (!CONFIG.API.SIGNATURE_COOKIE) {
            await Utils.get_signature();
        }
        const grokClient = new GrokApiClient(req.body.model);
        const requestPayload = await grokClient.prepareChatRequest(req.body);
        //创建新对话        
        const newMessageReq = await fetch(`${CONFIG.API.BASE_URL}/api/rpc`, {
            method: 'POST',
            headers: {
                ...DEFAULT_HEADERS,
                ...CONFIG.API.SIGNATURE_COOKIE
            },
            body: JSON.stringify({
                rpc: "createConversation",
                req: {
                    temporary: false
                }
            })
        });
        if (!newMessageReq.ok) {
            throw new Error(`上游服务请求失败! status: ${newMessageReq.status}`);
        }

        // 获取响应文本
        const responseText = await newMessageReq.json();
        const conversationId = responseText.conversationId;
        console.log("会话ID:conversationId", conversationId);
        if (!conversationId) {
            throw new Error(`创建会话失败! status: ${newMessageReq.status}`);
        }
        //发送对话
        const response = await fetch(`${CONFIG.API.BASE_URL}/api/conversations/${conversationId}/responses`, {
            method: 'POST',
            headers: {
                "accept": "text/event-stream",
                "baggage": "sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
                "content-type": "text/plain;charset=UTF-8",
                "Connection": "keep-alive",
                ...CONFIG.API.SIGNATURE_COOKIE
            },
            body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
            throw new Error(`上游服务请求失败! status: ${response.status}`);
        }
        if (req.body.stream) {
            await handleStreamResponse(response, req.body.model, res);
        } else {
            await handleNormalResponse(response, req.body.model, res);
        }
    }
    try {
        await makeRequest();
    } catch (error) {
        CONFIG.API.SIGNATURE_COOKIE = null;
        await Utils.handleError(error, res);
    }
});

async function handleStreamResponse(response, model, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const stream = response.body;
        let buffer = '';

        stream.on('data', async (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('data: ')) {
                    const data = trimmedLine.substring(6);
                    
                    if(data === "[DONE]"){
                        console.log("流结束");
                        res.write('data: [DONE]\n\n');
                        return res.end();
                    };
                    try {
                        if(!data.trim())continue;
                        const linejosn = JSON.parse(data);
                        if (linejosn?.error?.name === "RateLimitError") {
                            var responseData = MessageProcessor.createChatResponse(`${linejosn.error.name},请重新对话`, model, true);
                            fs.unlinkSync(path.resolve(process.cwd(), 'signature.json'));
                            CONFIG.API.SIGNATURE_COOKIE = null;
                            console.log("认证信息已删除");
                            res.write(`data: ${JSON.stringify(responseData)}\n\n`);
                            res.write('data: [DONE]\n\n');
                            return res.end();
                        }
                        switch (model) {
                            case 'grok-latest-image':
                                if (linejosn.response === "modelResponse" && linejosn?.modelResponse?.generatedImageUrls) {
                                    const dataImage = await handleImageResponse(linejosn.modelResponse.generatedImageUrls);
                                    const responseData = MessageProcessor.createChatResponse(dataImage, model, true);
                                    res.write(`data: ${JSON.stringify(responseData)}\n\n`);   
                                }
                                break;
                            case 'grok-latest':
                                if (linejosn.response === "token") {
                                    const token = linejosn.token;
                                    if (token && token.length > 0) {
                                        const responseData = MessageProcessor.createChatResponse(token, model, true);
                                        res.write(`data: ${JSON.stringify(responseData)}\n\n`);
                                    }
                                }
                                break;
                            case 'grok-latest-search':
                                if (linejosn.response === "token") {
                                    const token = linejosn.token;
                                    if (token && token.length > 0) {
                                        const responseData = MessageProcessor.createChatResponse(token, model, true);
                                        res.write(`data: ${JSON.stringify(responseData)}\n\n`);
                                    }
                                }
                                if (linejosn.response === "webSearchResults" && CONFIG.ISSHOW_SEARCH_RESULTS) {
                                    const searchResults = await Utils.organizeSearchResults(linejosn.webSearchResults);
                                    const responseData = MessageProcessor.createChatResponse(`<think>\r\n${searchResults}\r\n</think>\r\n`, model, true);
                                    res.write(`data: ${JSON.stringify(responseData)}\n\n`);
                                }
                                break;
                        }
                    } catch (error) {
                        console.error('JSON解析错误:', error);
                    }
                }
            }
        });
    } catch (error) {
        console.error('处理响应错误:', error);
        res.write('data: [DONE]\n\n');
        res.end();
    }
}

async function handleNormalResponse(response, model, res) {
    let fullResponse = '';
    let imageUrl = '';

    try {
        const responseText = await response.text();
        const lines = responseText.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            let linejosn = JSON.parse(data);
            if (linejosn?.error?.name === "RateLimitError") {
                fullResponse = `${linejosn.error.name},请重新对话`;
                CONFIG.API.SIGNATURE_COOKIE = null;
                return res.json(MessageProcessor.createChatResponse(fullResponse, model));
            }
            switch (model) {
                case 'grok-latest-image':
                    if (linejosn.response === "modelResponse" && linejosn?.modelResponse?.generatedImageUrls) {
                        imageUrl = linejosn.modelResponse.generatedImageUrls;
                    }
                    break;
                case 'grok-latest':
                    if (linejosn.response === "token") {
                        const token = linejosn.token;
                        if (token && token.length > 0) {
                            fullResponse += token;
                        }
                    }
                    break;
                case 'grok-latest-search':
                    if (linejosn.response === "token") {
                        const token = linejosn.token;
                        if (token && token.length > 0) {
                            fullResponse += token;
                        }
                    }
                    if (linejosn.response === "webSearchResults" && CONFIG.ISSHOW_SEARCH_RESULTS) {
                        fullResponse += `\r\n<think>${await Utils.organizeSearchResults(linejosn.webSearchResults)}</think>\r\n`;
                    }
                    break;
            }
        }
        if (imageUrl) {
            const dataImage = await handleImageResponse(imageUrl);
            const responseData = MessageProcessor.createChatResponse(dataImage, model);
            res.json(responseData);
        } else {
            const responseData = MessageProcessor.createChatResponse(fullResponse, model);
            res.json(responseData);
        }
    } catch (error) {
        Utils.handleError(error, res);
    }
}
async function handleImageResponse(imageUrl) {
    //对服务器发送图片请求
    const MAX_RETRIES = 3;
    let retryCount = 0;
    let imageBase64Response;
    
    while (retryCount < MAX_RETRIES) {
        try {
            //发送图片请求获取图片
            imageBase64Response = await fetch(`https://assets.grok.com/${imageUrl}`, {
                method: 'GET',
                headers: {
                    ...DEFAULT_HEADERS,
                    ...CONFIG.API.SIGNATURE_COOKIE
                }
            });

            if (imageBase64Response.ok) {
                break; // 如果请求成功，跳出重试循环
            }

            retryCount++;
            if (retryCount === MAX_RETRIES) {
                throw new Error(`上游服务请求失败! status: ${imageBase64Response.status}`);
            }

            // 等待一段时间后重试（可以使用指数退避）
            await new Promise(resolve => setTimeout(resolve, CONFIG.API.RETRY_TIME * retryCount));

        } catch (error) {
            retryCount++;
            if (retryCount === MAX_RETRIES) {
                throw error;
            }
            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, CONFIG.API.RETRY_TIME * retryCount));
        }
    }

    const arrayBuffer = await imageBase64Response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const formData = new FormData();

    formData.append('source', imageBuffer, {
        filename: 'new.jpg',
        contentType: 'image/jpeg'
    });
    const formDataHeaders = formData.getHeaders();
    const responseURL = await fetch("https://www.picgo.net/api/1/upload", {
        method: "POST",
        headers: {
            ...formDataHeaders,
            "Content-Type": "multipart/form-data",
            "X-API-Key": CONFIG.API.PICGO_KEY
        },
        body: formData
    });
    if (!responseURL.ok) {
        return "生图失败，请查看图床密钥是否设置正确"
    } else {
        const result = await responseURL.json();
        return `![image](${result.image.url})`
    }
}

// 404处理
app.use((req, res) => {
    res.status(200).send('api运行正常');
});

// 启动服务器
app.listen(CONFIG.SERVER.PORT, () => {
    console.log(`服务器已启动，监听端口: ${CONFIG.SERVER.PORT}`);
});