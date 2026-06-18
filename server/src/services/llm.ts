import { getEnv } from '../config.js';

export async function generateSummary(transcript: string): Promise<string> {
  return callLLM(`你是一个会议/课堂笔记助手。请严格基于以下原文做简洁摘要，只提取原文提到的内容，不要补充任何原文没有的信息。如果原文内容很少或为空，请如实说明。

原文：
${transcript}`);
}

export async function generateExamPoints(transcript: string): Promise<string> {
  return callLLM(`你是一个会议/课堂笔记助手。请严格基于以下原文提取要点，以简洁列表形式呈现。只提取原文明确提到的内容，不要臆测或补充。如果原文没有明确要点，请如实说明。

原文：
${transcript}`);
}

export async function generateMindMap(transcript: string): Promise<string> {
  return callLLM(`你是一个会议/课堂笔记助手。请严格基于以下原文生成思维导图JSON结构。只使用原文实际提到的内容，不要补充任何原文没有的信息。

格式要求：返回纯JSON，不要用markdown代码块包裹。

{
  "中心主题": "从原文提取的核心主题",
  "分支": [
    {
      "名称": "分支名称",
      "子节点": ["原文中实际提到的点"]
    }
  ]
}

如果原文内容很少，只需返回一个简单的结构，不要虚构分支。

原文：
${transcript}`);
}

export async function generateTags(transcript: string, summary: string): Promise<string> {
  if (!transcript && !summary) return '';
  const text = (summary || transcript).slice(0, 2000);
  const result = await callLLM(`从以下课堂笔记内容中提取 3-5 个主题标签。要求：
- 每个标签 2-6 字，名词性，能体现这节课讲的核心主题
- 用逗号分隔，只输出标签本身，不要解释、不要编号、不要 markdown
- 示例：导数,微积分,应用题,练习课

内容：
${text}`);
  return result
    .split(/[,，、\n]/)
    .map(t => t.trim().replace(/^[#•\-*\d.、]+/, '').replace(/[#•\-*]/g, '').trim())
    .filter(t => t.length >= 2 && t.length <= 12)
    .slice(0, 5)
    .join(',');
}

export async function generateTitleFromTranscript(transcript: string, summary: string): Promise<string> {
  const text = summary || transcript.slice(0, 800);
  if (!text) return '';
  const result = await callLLM(`为以下课堂笔记生成简短标题。要求：
- 10-20 字，体现这节课的核心主题
- 不要用书名号、引号、markdown 标记
- 只输出标题本身

内容：
${text}`);
  return result.trim().replace(/^["'「『《]|['"」』》]$/g, '').replace(/\*\*/g, '').replace(/^标题[：:]\s*/i, '').trim();
}

export async function askKnowledge(question: string, context: string): Promise<string> {
  return callLLM(`基于以下笔记内容回答问题。\n\n笔记：${context}\n\n问题：${question}`);
}

export async function classifyCourse(input: { title: string; summary: string; transcript: string; courses: Array<{ id: string; name: string; description: string }> }): Promise<string> {
  if (input.courses.length === 0) return '';
  const courseList = input.courses.map(c => `${c.id}\t${c.name}\t${c.description || ''}`).join('\n');
  const text = [input.title, input.summary, input.transcript.slice(0, 1200)].filter(Boolean).join('\n\n');
  const result = await callLLM(`根据笔记内容匹配最可能的课程。只返回课程ID；如果无法判断，返回空字符串。\n\n课程列表（ID\t名称\t描述）：\n${courseList}\n\n笔记内容：\n${text}`);
  const id = result.trim().replace(/^['"`]|['"`]$/g, '');
  return input.courses.some(c => c.id === id) ? id : '';
}

async function callLLM(prompt: string): Promise<string> {
  const env = getEnv();
  if (!env.LLM_API_KEY || !env.LLM_API_URL) {
    console.log('[LLM] No API configured, returning placeholder');
    return '';
  }

  const model = env.LLM_MODEL || 'mimo-v2.5-pro';

  const res = await fetch(env.LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    console.error('[LLM] API error:', res.status, await res.text());
    return '';
  }

  const data = await res.json() as Record<string, unknown>;
  const choice = (data.choices as Array<{ message: { content: string } }>)?.[0];
  return choice?.message?.content || '';
}
