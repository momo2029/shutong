import { getEnv } from '../config.js';

export async function generateSummary(transcript: string): Promise<string> {
  return callLLM('请对以下课堂文稿生成结构化摘要：\n\n' + transcript);
}

export async function generateExamPoints(transcript: string): Promise<string> {
  return callLLM('请从以下课堂内容中提取考试重点，以JSON列表返回：\n\n' + transcript);
}

export async function generateMindMap(transcript: string): Promise<string> {
  return callLLM('请将以下课堂内容生成思维导图JSON结构：\n\n' + transcript);
}

export async function askKnowledge(question: string, context: string): Promise<string> {
  return callLLM(`基于以下笔记内容回答问题。\n\n笔记：${context}\n\n问题：${question}`);
}

export async function classifyCourse(input: { title: string; summary: string; transcript: string; courses: Array<{ id: string; name: string; description: string }> }): Promise<string> {
  if (input.courses.length === 0) return '';
  const courseList = input.courses.map(c => `${c.id}\t${c.name}\t${c.description || ''}`).join('\n');
  const text = [input.title, input.summary, input.transcript.slice(0, 1200)].filter(Boolean).join('\n\n');
  const result = await callLLM(`根据笔记内容匹配最可能的课程。只返回课程ID；如果无法判断，返回空字符串。\n\n课程列表（ID\t名称\t描述）：\n${courseList}\n\n笔记内容：\n${text}`);
  const id = result.trim().replace(/^[\'"`]|[\'"`]$/g, '');
  return input.courses.some(c => c.id === id) ? id : '';
}

async function callLLM(prompt: string): Promise<string> {
  const env = getEnv();
  if (!env.LLM_API_KEY || !env.LLM_API_URL) {
    console.log('[LLM] No API configured, returning placeholder');
    return '';
  }

  const res = await fetch(env.LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }),
  });

  const data = await res.json() as Record<string, unknown>;
  const choice = (data.choices as Array<{ message: { content: string } }>)?.[0];
  return choice?.message?.content || '';
}
