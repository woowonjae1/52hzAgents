const https = require('https');
const http = require('http');
const { exec } = require('child_process');

class AgentRunner {
  constructor(store, broadcaster) {
    this.store = store;
    this.broadcaster = broadcaster;
  }

  async handleUserMessage(event) {
    const payload = event.payload || {};
    const content = (payload.content || '').trim();
    const channelTarget = event.target || 'channel/general';
    const channelName = channelTarget.replace(/^channel\//, '');

    // Skip empty or non-human messages
    if (!content || !event.source || !event.source.startsWith('human:')) {
      return;
    }

    // Determine target agent (default to deepseek or master agent)
    let agentName = 'deepseek';
    if (content.startsWith('@claude')) agentName = 'claude';
    else if (content.startsWith('@gemini')) agentName = 'gemini';
    else if (content.startsWith('@ollama')) agentName = 'ollama';

    // Broadcast composing indicator
    this.broadcaster.broadcastComposing(channelName, agentName);

    // Check if the prompt is asking for local bash/git inspection
    if (content.startsWith('/git') || content.startsWith('/status')) {
      this.handleLocalGitCommand(channelTarget, agentName);
      return;
    }

    // Check for API Keys in env
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (agentName === 'deepseek' && deepseekKey) {
      await this.callOpenAICompatible({
        channelTarget,
        agentName,
        apiKey: deepseekKey,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        userPrompt: content,
      });
      return;
    }

    if (agentName === 'claude' && anthropicKey) {
      await this.callAnthropic({
        channelTarget,
        agentName,
        apiKey: anthropicKey,
        userPrompt: content,
      });
      return;
    }

    if (openaiKey) {
      await this.callOpenAICompatible({
        channelTarget,
        agentName,
        apiKey: openaiKey,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        userPrompt: content,
      });
      return;
    }

    // Check if local Ollama is active
    const hasOllama = await this.checkOllama();
    if (hasOllama && (agentName === 'ollama' || (!deepseekKey && !openaiKey))) {
      await this.callOllama({
        channelTarget,
        agentName: 'ollama',
        userPrompt: content,
      });
      return;
    }

    // Default friendly assistant fallback
    const welcomeResponse = `🤖 **52hzAgents 本地引擎已就绪**\n\n已收到您的消息：\n> "${content}"\n\n**当前状态：**\n- 运行环境：精简原生 Node.js / Electron 引擎（已剥离外部 Go 及后台常驻进程）\n- 本地工作区：\`52hz\`\n- 活跃频道：\`#${channelName}\`\n\n**接入大模型：**\n您可以在系统环境变量中配置 \`DEEPSEEK_API_KEY\`、\`ANTHROPIC_API_KEY\` 或 \`OPENAI_API_KEY\`，或启动本地 **Ollama** (\`localhost:11434\`)，即可直接进行多 Agent 对话与本地代码协同。`;

    setTimeout(() => {
      const responseEvent = this.store.addEvent({
        type: 'workspace.message.posted',
        source: `52hz:${agentName}`,
        target: channelTarget,
        payload: {
          content: welcomeResponse,
          sender_name: agentName.toUpperCase(),
          sender_type: 'agent',
        },
        metadata: {
          model: 'embedded-assistant',
        },
      });
      this.broadcaster.broadcast(responseEvent);
    }, 400);
  }

  handleLocalGitCommand(channelTarget, agentName) {
    exec('git status --short && git branch --show-current', { cwd: process.cwd() }, (err, stdout, stderr) => {
      const output = err ? stderr || err.message : stdout || 'Working tree clean';
      const responseEvent = this.store.addEvent({
        type: 'workspace.message.posted',
        source: `52hz:${agentName}`,
        target: channelTarget,
        payload: {
          content: `📊 **Git Status 本地检查结果：**\n\`\`\`bash\n${output}\n\`\`\``,
          sender_name: agentName.toUpperCase(),
          sender_type: 'agent',
        },
      });
      this.broadcaster.broadcast(responseEvent);
    });
  }

  checkOllama() {
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:11434/api/tags', (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  callOllama({ channelTarget, agentName, userPrompt }) {
    return new Promise((resolve) => {
      const postData = JSON.stringify({
        model: 'llama3:latest',
        prompt: userPrompt,
        stream: false,
      });

      const req = http.request(
        'http://127.0.0.1:11434/api/generate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const text = json.response || 'No response from Ollama';
              const responseEvent = this.store.addEvent({
                type: 'workspace.message.posted',
                source: `52hz:${agentName}`,
                target: channelTarget,
                payload: {
                  content: text,
                  sender_name: 'Ollama Local',
                  sender_type: 'agent',
                },
              });
              this.broadcaster.broadcast(responseEvent);
            } catch (_) {}
            resolve();
          });
        }
      );
      req.on('error', () => resolve());
      req.write(postData);
      req.end();
    });
  }

  callOpenAICompatible({ channelTarget, agentName, apiKey, baseUrl, model, userPrompt }) {
    return new Promise((resolve) => {
      try {
        const u = new URL(`${baseUrl}/chat/completions`);
        const postData = JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a helpful coding assistant in 52hzAgents Studio.' },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
        });

        const client = u.protocol === 'https:' ? https : http;
        const req = client.request(
          u,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'Content-Length': Buffer.byteLength(postData),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const reply = json.choices?.[0]?.message?.content || 'No response generated';
                const responseEvent = this.store.addEvent({
                  type: 'workspace.message.posted',
                  source: `52hz:${agentName}`,
                  target: channelTarget,
                  payload: {
                    content: reply,
                    sender_name: agentName.toUpperCase(),
                    sender_type: 'agent',
                  },
                });
                this.broadcaster.broadcast(responseEvent);
              } catch (_) {}
              resolve();
            });
          }
        );
        req.on('error', () => resolve());
        req.write(postData);
        req.end();
      } catch (_) {
        resolve();
      }
    });
  }

  callAnthropic({ channelTarget, agentName, apiKey, userPrompt }) {
    return new Promise((resolve) => {
      try {
        const postData = JSON.stringify({
          model: 'claude-3-7-sonnet-20250219',
          max_tokens: 4096,
          messages: [{ role: 'user', content: userPrompt }],
        });

        const req = https.request(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(postData),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const text = json.content?.[0]?.text || 'No response from Claude';
                const responseEvent = this.store.addEvent({
                  type: 'workspace.message.posted',
                  source: `52hz:${agentName}`,
                  target: channelTarget,
                  payload: {
                    content: text,
                    sender_name: 'Claude 3.7 Sonnet',
                    sender_type: 'agent',
                  },
                });
                this.broadcaster.broadcast(responseEvent);
              } catch (_) {}
              resolve();
            });
          }
        );
        req.on('error', () => resolve());
        req.write(postData);
        req.end();
      } catch (_) {
        resolve();
      }
    });
  }
}

module.exports = { AgentRunner };
