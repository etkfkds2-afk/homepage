import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestGet } from '../functions/api/news/articles.js';

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

test('브라우저는 방문자 ID를 저장·조회 API에 함께 보낸다', async () => {
  const html = await readFile(new URL('../newsbrief.html', import.meta.url), 'utf8');
  assert.match(html, /localStorage\.getItem\(USER_KEY\)/);
  assert.match(html, /'x-news-user':userId/);
  assert.match(html, /data-view="hidden"/);
  assert.match(html, /data-action="unhide"/);
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

test('바둑 목록은 요약 대기 기사도 제목 목록으로 반환한다', async () => {
  const pending = {
    id: 10, url_key: 'pending', url: 'https://example.com/pending',
    title: '전국 청소년 바둑대회가 다음 달 서울에서 열린다', source: 'TEST', press: '테스트일보',
    category: '바둑', published_at: '2026-07-24T01:00:00Z', fetched_at: '2026-07-24T01:00:00Z',
    summary: '', summary_quality: 'none', image_url: '', saved: 0
  };
  const env = { DB: {
    batch: async () => [],
    prepare(sql) {
      return { bind() { return this; }, async all() { return { results: sql.includes('SELECT a.id') ? [pending] : [] }; } };
    }
  } };
  const response = await onRequestGet({ request: new Request('https://example.com/api/news/articles?category=%EB%B0%94%EB%91%91&include_pending=1'), env });
  const data = await response.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].summary_pending, 1);
  assert.equal(data.items[0].summary, '');
});
