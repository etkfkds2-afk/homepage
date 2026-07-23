import { buildSummary, normalizeText, stripNumbering, validateThreeLineSummary } from './news-summary.js';

function numbers(value) {
  return new Set((String(value || '').match(/\d+(?:[.,]\d+)*(?:%|원|명|건|년|월|일|시|분)?/g) || []).map(v => v.replace(/,/g, '')));
}

function numbersGrounded(summary, source) {
  const allowed = numbers(source);
  return [...numbers(summary)].every(value => allowed.has(value));
}

function normalizeAiAnswer(value) {
  const text = normalizeText(value).replace(/^```[^\n]*\n?|```$/g, '');
  const lines = text.split('\n').map(stripNumbering).filter(Boolean).slice(0, 3);
  return lines.map((line, index) => `${index + 1}) ${line}`).join('\n');
}

export async function makeBestSummary(env, { title = '', rawSummary = '', body = '' } = {}) {
  const source = normalizeText(body || rawSummary).slice(0, 9000);
  if (!source) return '';

  if (env?.AI && source.length >= 300) {
    const prompt = `당신은 한국어 뉴스 편집자다. 아래 원문에 명시된 사실만 사용해 정확히 3줄로 요약하라.

절대 규칙:
- 각 줄은 서로 다른 핵심 사실 하나만 담은 완전한 한국어 문장으로 쓴다.
- 각 줄은 25~120자이며 자연스러운 서술형 종결어미로 끝낸다.
- 제목을 그대로 반복하지 않는다.
- 추측, 평가, 배경지식, 원문에 없는 숫자·인물·기관을 만들지 않는다.
- 기자명, 이메일, 송고시간, 광고, 구독, 제보, 추천기사, 관련기사, 포털 UI, 사진 설명을 넣지 않는다.
- 말줄임표와 문장 조각을 쓰지 않는다.
- 출력은 "1) 문장", "2) 문장", "3) 문장" 세 줄뿐이다.

제목: ${title}
원문:
${source}`;
    try {
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt,
        max_tokens: 480,
        temperature: 0.1,
        top_p: 0.85
      });
      const aiSummary = normalizeAiAnswer(result?.response || result?.result?.response || '');
      if (validateThreeLineSummary(aiSummary, title) && numbersGrounded(aiSummary, `${title}\n${source}`)) return aiSummary;
    } catch {}
  }

  const extractive = buildSummary({ title, rawSummary, body: source });
  return validateThreeLineSummary(extractive, title) ? extractive : '';
}
