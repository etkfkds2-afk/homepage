import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestGet } from '../functions/api/news/articles.js';
import { isBadukRelevant } from '../functions/api/news/collect.js';

test('정기 수집은 기존 게시 기사를 비노출 상태로 강등하지 않는다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE news_articles SET summary='',summary_quality='none'/);
});

test('AI 호출은 일일 예산과 당일 차단 상태를 확인한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /DAILY_AI_CALL_LIMIT = 4/);
  assert.match(source, /ai_budget_day/);
  assert.match(source, /ai_blocked/);
});

test('Anthropic은 바둑 전용이며 평시·백필·누적 호출 상한을 적용한다', async () => {
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  const ai = await readFile(new URL('../functions/_lib/news-ai-summary.js', import.meta.url), 'utf8');
  assert.match(collector, /DAILY_ANTHROPIC_CALL_LIMIT = 12/);
  assert.match(collector, /BACKFILL_ANTHROPIC_CALL_LIMIT = 200/);
  assert.match(collector, /TOTAL_ANTHROPIC_CALL_LIMIT = 600/);
  assert.match(collector, /payload\.category === '바둑'/);
  assert.match(collector, /NEWSBRIEF_USE_ANTHROPIC === '1'/);
  assert.match(ai, /NEWSBRIEF_USE_ANTHROPIC === '1'/);
  assert.match(ai, /claude-haiku-4-5-20251001/);
});

test('현재 production은 Claude를 끄고 Cloudflare AI 우선으로 동작한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /NEWSBRIEF_USE_ANTHROPIC:\{type:"plain_text",value:"0"\}/);
  assert.match(collector, /Boolean\(env\.AI \|\| wantsAnthropic\)/);
});

test('이슈 식별은 제목의 대회·선수 조합을 사용하고 일반 단어를 배제한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  assert.match(source, /BADUK_NAMES/);
  assert.match(source, /(?:대회|리그|기전|컵|배|선수권|오픈)/);
  assert.match(source, /ISSUE_STOPWORDS/);
  assert.match(source, /RESULT_WORDS/);
  assert.match(source, /if \(category === '바둑'\)[\s\S]*return '';/);
});

test('홈 이슈 필터는 이슈 키의 카테고리와 동일한 기간을 재사용한다', async () => {
  const source = await readFile(new URL('../functions/api/news/articles.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(source, /issueCategory = issueKeyFilter\.split\('\|'\)\[0\]/);
  assert.match(source, /CATEGORIES\.has\(issueCategory\)/);
  assert.match(source, /const queryLimit = issueKeyFilter \? 900/);
  assert.match(page, /state\.issueKey&&state\.mode==='home'/);
  assert.match(page, /p\.set\('hours','168'\)/);
  assert.match(page, /startsWith\('바둑\|'/);
  assert.match(page, /p\.set\('view','latest'\)/);
});

test('화면은 이슈 목차와 기존 관련 보도 묶음을 함께 사용하되 중복 제목 목록을 만들지 않는다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /issuesPanel/);
  assert.match(html, /관련 기사 \$\{issue\.count\}건/);
  assert.match(html, /data-issue-key/);
  assert.match(html, /issue_key/);
  assert.match(html, /clearIssue/);
  assert.match(html, /state\.mode==='home'&&!state\.q&&!state\.issueKey/);
  assert.match(html, /relatedHtml\(x\)/);
  assert.doesNotMatch(html, /issueRelated/);
});

test('대량 백필은 CPU 제한을 피하도록 작은 묶음으로 처리한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(collector, /MAINTENANCE_BATCH_SIZE = 40/);
  assert.match(collector, /uniqueCandidates\.slice\(0, 8\)/);
  assert.match(collector, /repair \? 4 : \(backfill \? 4 : 3\)/);
  assert.match(workflow, /then runs=18/);
  assert.match(workflow, /seq 1 10/);
});

test('자동 수집과 화면 갱신은 3시간 주기로 동작한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '0 \*\/3 \* \* \*'/);
  assert.match(html, /setInterval\(\(\)=>load\(\{silent:true\}\),10800000\)/);
});

test('바둑 검색에 섞인 무관한 기사는 Claude 대상으로 분류하지 않는다', () => {
  assert.equal(isBadukRelevant('신진서, 카타고와 세 번째 대국', ''), true);
  assert.equal(isBadukRelevant('희망과 절망', '신진서 9단이 한국기원에서 바둑 인공지능 카타고와 대국했다.'), true);
  assert.equal(isBadukRelevant("tvN 드라마 응답하라 1988 다시보기", '박보검과 혜리가 출연한 가족 드라마가 시청률을 기록했다.'), false);
});

test('요약 실패 기사는 같은 날 반복 호출하지 않고 적게 시도한 순서로 순환한다', async () => {
  const source = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(source, /f\.last_attempt < datetime\('now','-20 hours'\)/);
  assert.match(source, /COALESCE\(f\.attempts,0\), COALESCE\(f\.last_attempt,'1970-01-01'\)/);
});

test('수동 한 달 백필만 대기 중인 요약을 강제 순환한다', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const collector = await readFile(new URL('../functions/api/news/collect.js', import.meta.url), 'utf8');
  assert.match(workflow, /backfill=1&force_retry=1/);
  assert.match(workflow, /repair=1&force_retry=1/);
  assert.match(collector, /forceRetry \? 1 : 0/);
});

test('숨김 목록은 현재 방문자의 숨긴 기사만 조회한다', async () => {
  let query = '';
  const env = { DB: {
    batch: async () => [],
    prepare(sql) {
      if (sql.includes('SELECT a.id')) query = sql;
      return { bind() { return this; }, async all() { return { results: [] }; } };
    }
  } };
  await onRequestGet({ request: new Request('https://example.com/api/news/articles?view=hidden', { headers: { 'x-news-user': 'visitor-a' } }), env });
  assert.match(query, /h\.url_key IS NOT NULL/);
});

test('브라우저는 방문자 ID를 저장·조회 API에 함께 보내고 삭제 UI만 제공한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.getItem\(USER_KEY\)/);
  assert.match(html, /'x-news-user':userId/);
  assert.doesNotMatch(html, /data-view="hidden"/);
  assert.doesNotMatch(html, /data-action="unhide"/);
  assert.match(html, /data-action="hide">삭제/);
  assert.match(html, /기사를 삭제했습니다/);
});

test('D1 UTC 시각 문자열을 UTC로 해석한다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /replace\(' ','T'\).*Z/);
});

test('보조 공급자 장애 중 신규 기사가 등록되면 경고만 남긴다', async () => {
  const script = await readFile(new URL('../scripts/google-news-discovery.mjs', import.meta.url), 'utf8');
  assert.match(script, /::warning::/);
  assert.match(script, /if \(!Number\(payload\.inserted \|\| 0\)\) process\.exitCode = 2/);
});
