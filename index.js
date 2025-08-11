const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const redis = require('redis');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const redisClient = redis.createClient({
  url: 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        return new Error('Redis connection failed');
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redisClient.on('connect', () => {});

redisClient.on('ready', () => {});

async function connectRedis() {
  try {
    await redisClient.connect();
  } catch (error) {}
}

connectRedis();

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api', limiter);

const metrics = {
  requests: [],
  cacheHits: 0,
  cacheMisses: 0,
  totalRequests: 0,
  averageResponseTime: 0,
  streamingEnabled: true
};

const LLAMA_API_URL = 'http://localhost:11434/api/generate';

class ContextManager {
  constructor(maxTokens = 4000) {
    this.maxTokens = maxTokens;
    this.sessions = new Map();
  }

  getSessionContext(sessionId) {
    return this.sessions.get(sessionId) || [];
  }

  addToContext(sessionId, message, response) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }

    const context = this.sessions.get(sessionId);
    context.push({ role: 'user', content: message });
    context.push({ role: 'assistant', content: response });

    const totalTokens = context.reduce(
      (sum, msg) => sum + msg.content.length / 4,
      0
    );

    if (totalTokens > this.maxTokens) {
      context.splice(0, 2);
    }

    this.sessions.set(sessionId, context);
  }

  buildPrompt(sessionId, newMessage) {
    const context = this.getSessionContext(sessionId);
    let prompt = 'You are a helpful AI assistant. Be concise and helpful.\n';
    prompt +=
      'System: The following text is BACKGROUND CONTEXT from the conversation. Use it only to inform your reply — do NOT repeat, enumerate, or answer these previous Q/A verbatim unless the user explicitly asks you to.\n\n';

    if (context.length) {
      prompt += '=== CONTEXT START ===\n';
      for (const msg of context.slice(-6)) {
        prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${
          msg.content
        }\n`;
      }
      prompt += '=== CONTEXT END ===\n\n';
    }

    prompt += `User: ${newMessage}\nAssistant:`;
    return prompt;
  }

  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}

const contextManager = new ContextManager();

async function getCachedResponse(key) {
  try {
    if (!redisClient.isOpen) {
      return null;
    }
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    return null;
  }
}

async function setCachedResponse(key, response, ttl = 3600) {
  try {
    if (!redisClient.isOpen) {
      return;
    }
    await redisClient.setEx(key, ttl, JSON.stringify(response));
  } catch (error) {}
}

async function clearCache() {
  try {
    if (!redisClient.isOpen) {
      return false;
    }
    await redisClient.flushDb();
    return true;
  } catch (error) {
    return false;
  }
}

function generateCacheKey(message) {
  return `llm_response:${Buffer.from(message).toString('base64').slice(0, 50)}`;
}

async function callLlamaAPI(prompt, streaming = false) {
  try {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt provided');
    }

    const requestData = {
      model: 'llama2:7b-chat',
      prompt: prompt,
      stream: streaming,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 500,
        stop: ['\n\nUser:', '\n\nHuman:']
      }
    };

    const response = await axios.post(LLAMA_API_URL, requestData, {
      responseType: streaming ? 'stream' : 'json',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    });

    if (response.status !== 200) {
      throw new Error(
        `Ollama API returned status ${response.status}: ${
          response.data?.error || 'Unknown error'
        }`
      );
    }

    return response;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error(
        'Cannot connect to Ollama server. Make sure Ollama is running on localhost:11434'
      );
    } else if (error.code === 'ENOTFOUND') {
      throw new Error(
        'Ollama server not found. Check if the service is running.'
      );
    } else if (error.code === 'ECONNABORTED') {
      throw new Error(
        'Request timeout. The model is taking too long to respond.'
      );
    }
    throw new Error(`LLaMA API Error: ${error.message}`);
  }
}

io.on('connection', (socket) => {
  socket.on('chat_message', async (data) => {
    const startTime = Date.now();
    const {
      message,
      sessionId = socket.id,
      useCache = true,
      useStreaming = true
    } = data;

    metrics.totalRequests++;

    try {
      let response = '';
      let cacheHit = false;

      if (useCache) {
        const cacheKey = generateCacheKey(message);
        const cachedResponse = await getCachedResponse(cacheKey);

        if (cachedResponse) {
          response = cachedResponse.response;
          cacheHit = true;
          metrics.cacheHits++;

          if (useStreaming) {
            const words = response.split(' ');
            for (let i = 0; i < words.length; i++) {
              socket.emit('chat_response_chunk', {
                chunk: words.slice(0, i + 1).join(' '),
                isComplete: i === words.length - 1,
                metadata: { cached: true, sessionId }
              });
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } else {
            socket.emit('chat_response', {
              response,
              metadata: { cached: true, sessionId }
            });
          }
        } else {
          metrics.cacheMisses++;
        }
      } else {
        metrics.cacheMisses++;
      }

      if (!cacheHit) {
        const prompt = contextManager.buildPrompt(sessionId, message);

        if (useStreaming) {
          const apiResponse = await callLlamaAPI(prompt, true);
          let responseBuffer = '';

          apiResponse.data.on('data', (chunk) => {
            try {
              const chunkStr = chunk.toString();
              responseBuffer += chunkStr;

              const lines = responseBuffer.split('\n');
              responseBuffer = lines.pop() || '';

              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const data = JSON.parse(line.trim());

                    if (data.response) {
                      response += data.response;

                      socket.emit('chat_response_chunk', {
                        chunk: response,
                        isComplete: !!data.done,
                        metadata: { cached: false, sessionId }
                      });
                    }

                    if (data.done) {
                      if (useCache && response) {
                        const cacheKey = generateCacheKey(message);
                        setCachedResponse(cacheKey, { response });
                      }
                      contextManager.addToContext(sessionId, message, response);
                    }
                  } catch (parseError) {}
                }
              }
            } catch (error) {}
          });

          apiResponse.data.on('end', () => {
            if (response && !socket.disconnected) {
              socket.emit('chat_response_chunk', {
                chunk: response,
                isComplete: true,
                metadata: { cached: false, sessionId }
              });
            }
          });

          apiResponse.data.on('error', (error) => {
            socket.emit('chat_error', {
              error: 'Streaming error: ' + error.message,
              sessionId
            });
          });
        } else {
          const apiResponse = await callLlamaAPI(prompt, false);
          response = apiResponse.data.response;

          socket.emit('chat_response', {
            response,
            metadata: { cached: false, sessionId }
          });

          if (useCache) {
            const cacheKey = generateCacheKey(message);
            setCachedResponse(cacheKey, { response });
          }

          contextManager.addToContext(sessionId, message, response);
        }
      }

      const endTime = Date.now();
      const responseTime = endTime - startTime;

      metrics.requests.push({
        timestamp: new Date().toISOString(),
        responseTime,
        cached: cacheHit,
        streaming: useStreaming,
        messageLength: message.length,
        responseLength: response.length,
        sessionId
      });

      const totalTime = metrics.requests.reduce(
        (sum, req) => sum + req.responseTime,
        0
      );
      metrics.averageResponseTime = totalTime / metrics.requests.length;

      socket.emit('metrics_update', {
        responseTime,
        cached: cacheHit,
        totalRequests: metrics.totalRequests,
        cacheHitRate: (
          (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)) *
          100
        ).toFixed(2),
        averageResponseTime: metrics.averageResponseTime.toFixed(0)
      });
    } catch (error) {
      console.error('Chat error:', error.message);
      socket.emit('chat_error', {
        error: error.message,
        sessionId
      });
    }
  });

  socket.on('clear_context', (data) => {
    const { sessionId = socket.id } = data;
    contextManager.clearSession(sessionId);
    socket.emit('context_cleared', { sessionId });
  });

  socket.on('get_metrics', () => {
    socket.emit('metrics_data', {
      ...metrics,
      cacheHitRate: (
        (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)) *
        100
      ).toFixed(2),
      recentRequests: metrics.requests.slice(-10)
    });
  });

  socket.on('disconnect', () => {});
});

app.get('/api/health', async (req, res) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      llama: false,
      redis: false
    },
    details: {}
  };

  try {
    try {
      await axios.get('http://localhost:11434/api/tags', {
        timeout: 5000,
        validateStatus: (status) => status === 200
      });
      healthCheck.services.llama = true;
      healthCheck.details.llama = 'Connected';
    } catch (error) {
      healthCheck.services.llama = false;
      healthCheck.details.llama = `Error: ${error.message}`;
    }

    try {
      if (redisClient.isOpen) {
        const redisHealth = await redisClient.ping();
        healthCheck.services.redis = redisHealth === 'PONG';
        healthCheck.details.redis =
          redisHealth === 'PONG' ? 'Connected' : 'Failed to ping';
      } else {
        healthCheck.services.redis = false;
        healthCheck.details.redis = 'Not connected';
      }
    } catch (error) {
      healthCheck.services.redis = false;
      healthCheck.details.redis = `Error: ${error.message}`;
    }

    const allHealthy = Object.values(healthCheck.services).every(
      (service) => service === true
    );
    healthCheck.status = allHealthy ? 'healthy' : 'degraded';

    const statusCode = allHealthy ? 200 : 503;
    res.status(statusCode).json(healthCheck);
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/metrics', (req, res) => {
  res.json({
    ...metrics,
    cacheHitRate: (
      (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)) *
      100
    ).toFixed(2),
    uptime: process.uptime()
  });
});

app.post('/api/cache/clear', async (req, res) => {
  try {
    const cleared = await clearCache();
    if (cleared) {
      metrics.cacheHits = 0;
      metrics.cacheMisses = 0;

      res.json({
        status: 'success',
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'error',
        message: 'Failed to clear cache - Redis not connected',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: `Cache clear failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId, useCache = true } = req.body;

  if (!message || typeof message !== 'string') {
    return res
      .status(400)
      .json({ error: 'Message is required and must be a string' });
  }

  if (message.length > 10000) {
    return res
      .status(400)
      .json({ error: 'Message too long. Maximum 10,000 characters allowed.' });
  }

  if (sessionId && typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'SessionId must be a string' });
  }

  const startTime = Date.now();

  try {
    let response = '';
    let cacheHit = false;

    if (useCache) {
      const cacheKey = generateCacheKey(message);
      const cachedResponse = await getCachedResponse(cacheKey);

      if (cachedResponse && cachedResponse.response) {
        response = cachedResponse.response;
        cacheHit = true;
        metrics.cacheHits++;
      } else {
        metrics.cacheMisses++;
      }
    } else {
      metrics.cacheMisses++;
    }

    if (!cacheHit) {
      const prompt = contextManager.buildPrompt(sessionId, message);
      const apiResponse = await callLlamaAPI(prompt, false);

      if (!apiResponse.data || !apiResponse.data.response) {
        throw new Error('Invalid response from Ollama API');
      }

      response = apiResponse.data.response;

      if (useCache && response) {
        const cacheKey = generateCacheKey(message);
        setCachedResponse(cacheKey, { response });
      }

      contextManager.addToContext(sessionId, message, response);
    }

    const responseTime = Date.now() - startTime;
    metrics.totalRequests++;

    res.json({
      response,
      metadata: {
        cached: cacheHit,
        responseTime,
        sessionId: sessionId || 'anonymous'
      }
    });
  } catch (error) {
    console.error('API error:', error.message);
    const responseTime = Date.now() - startTime;

    res.status(500).json({
      error: error.message,
      metadata: {
        responseTime,
        sessionId: sessionId || 'anonymous'
      }
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
