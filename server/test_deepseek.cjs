const rawAsr = "现在是开始录。如果用的，我就主要的活动还有说是指的企业除了主品商品之外，他的业务获得的。就前面的例子当那个上司他把货卖了一定不是主营。他的业务收入体现在本上，人认为利润表和核心力非常是不是这在比他业务还包括技术转带高、产的出高物的运等这些工业性劳务数都叫起止收入是主营一部分呢是以企业的业务既主要的用，而且我们情况他是企业投资利润利息他的减去资损是一个收益的大概上来讲，主要的来源设降的几。那么一部不理解几个人说你怎么。那我们来数一下你的议程呃，业程我们能包含以及go超市进行销售，样的一基本的一程。采购的销售之下，又包括干蔗作作业比业务更小概念，可以称是一个做一个动连结成了业务这项动得完成。所以实际上是可业务流程一步的真的那如果我记得去大看你的业务能由弱作业每作业增值了增的作业会带来。容量首这。满足衡量收入也是以业务运行行汇报。在这样情况下。";

const prompt = `你是一个中文语音转写纠错助手。以下是通过语音识别得到的中文文本，存在同音错字、断句混乱等问题。请修正错别字、合并重复、补全残缺句子、添加适当标点，使其通顺易读。不要改变原意、不要添加原文没有的内容。直接输出润色后的文本。

原文：
${rawAsr}`;

const t0 = Date.now();
const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
  method: "POST",
  headers: { "Authorization": "Bearer sk-qicxnbhecpgogryvzdptrokovoqienbngawzbzdnluyhaphh", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B", messages: [{ role: "user", content: prompt }], max_tokens: 2000 }),
});
const data = await res.json();
const text = data?.choices?.[0]?.message?.content || "";
const reasoning = data?.choices?.[0]?.message?.reasoning_content || "";
console.log("耗时:", Date.now() - t0, "ms");
if (reasoning) console.log("思考过程:", reasoning.substring(0, 200), "...");
console.log("结果:", text);
