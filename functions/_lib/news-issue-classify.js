const CLASSIFY_MODEL = 'claude-sonnet-5';
const WORKERS_AI_CLASSIFY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const INSTRUCTIONS = `당신은 한국 뉴스 데스크의 편집자다. 아래 번호 매긴 기사 제목·요약 목록을 보고, 실제로 같은 사건(같은 대회의 같은 경기, 같은 발표, 같은 사고 등)을 다루는 기사끼리 묶어 "이슈"를 만든다.

규칙:
- 서로 다른 대회, 다른 라운드, 다른 인물, 다른 사건의 기사는 절대 같은 이슈로 묶지 않는다.
- 정말로 같은 사건을 다루는 기사가 2건 이상 있을 때만 이슈로 만든다. 관련 기사가 없는 단독 기사는 결과에서 제외한다.
- 같은 번호를 두 이슈에 중복으로 넣지 않는다.
- 이슈 제목은 8~18자 내외의 자연스러운 한국어 명사구로 쓴다. 어색한 번역투, 따옴표, 특수기호를 쓰지 않는다.
  예시: "신진서 삼성화재배 우승", "한국기원 정기이사회 개최", "이세돌 은퇴 이후 근황"
- 반드시 아래 JSON 배열 형식으로만 응답한다. 다른 설명, 주석, 마크다운 코드블록은 절대 쓰지 않는다.

출력 형식: [{"title":"이슈 제목","indices":[0,3,7]}]`;

function buildListing(articles) {
  return articles.map((item, index) => {
    const date = String(item.published_at || item.fetched_at || '').slice(0, 10);
    const summary = String(item.summary || '').replace(/\n/g, ' ').slice(0, 80);
    return `${index}. [${date}] ${item.title}${summary ? ` — ${summary}` : ''}`;
  }).join('\n');
}

function stripFences(value) {
  return String(value || '').replace(/```(?:json)?/gi, '').trim();
}

function extractJsonArray(text) {
  const stripped = stripFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function toGroups(parsed, articles) {
  if (!Array.isArray(parsed)) return [];
  const used = new Set();
  const groups = [];
  for (const entry of parsed) {
    const title = String(entry?.title || '').trim().slice(0, 40);
    const indices = Array.isArray(entry?.indices)
      ? [...new Set(entry.indices)].filter(i => Number.isInteger(i) && i >= 0 && i < articles.length && !used.has(i))
      : [];
    if (!title || indices.length < 2) continue;
    indices.forEach(i => used.add(i));
    groups.push({ title, url_keys: indices.map(i => articles[i].url_key) });
  }
  const leftover = articles.map((_, i) => i).filter(i => !used.has(i));
  if (leftover.length) {
    groups.push({ title: '기타', url_keys: leftover.map(i => articles[i].url_key), misc: true });
  }
  return groups;
}

async function classifyWithWorkersAi(env, articles) {
  const result = await env.AI.run(WORKERS_AI_CLASSIFY_MODEL, {
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: buildListing(articles) }
    ],
    max_tokens: 4096,
    temperature: 0
  });
  const text = result?.response || result?.result?.response || '';
  const parsed = extractJsonArray(text);
  if (!parsed) throw new Error(`Cloudflare AI 응답을 JSON으로 해석하지 못했습니다: ${text.slice(0, 300)}`);
  return toGroups(parsed, articles);
}

async function classifyWithAnthropic(env, articles) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 8000,
      system: INSTRUCTIONS,
      messages: [{ role: 'user', content: buildListing(articles) }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Anthropic API ${response.status}`);
  }
  const text = (payload?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
  const parsed = extractJsonArray(text);
  if (!parsed) throw new Error('Anthropic 응답을 JSON으로 해석하지 못했습니다.');
  return toGroups(parsed, articles);
}

export async function classifyIssues(env, articles) {
  if (!articles.length) return { groups: [], provider: 'none' };
  // Prefer the free Cloudflare model; fall back to Anthropic only if it
  // errors, so a bad day for the free model doesn't silently drop the
  // daily rebuild.
  if (env?.AI) {
    try {
      return { groups: await classifyWithWorkersAi(env, articles), provider: 'workers-ai' };
    } catch (error) {
      if (!env?.ANTHROPIC_API_KEY) throw error;
    }
  }
  if (env?.ANTHROPIC_API_KEY) return { groups: await classifyWithAnthropic(env, articles), provider: 'anthropic' };
  return { groups: [], provider: 'none' };
}
