import { isRejectedTitle, normalizeText, validateThreeLineSummary } from '../../_lib/news-summary.js';
import { makeBestSummary } from '../../_lib/news-ai-summary.js';
import {
  canonicalUrl, ensureNewsDb, isCollectorAuthorized, json, sha256
} from '../../_lib/news-db.js';

const SEARCHES = [
  ['바둑', '바둑 대회 프로기사'],
  ['정치', '정치 주요 뉴스'], ['경제', '경제 주요 뉴스'], ['사회', '사회 주요 뉴스'],
  ['생활/문화', '생활 문화 주요 뉴스'], ['세계', '세계 주요 뉴스'],
  ['IT/과학', 'IT 과학 주요 뉴스']
];

const BADUK_SEARCHES = [
  '바둑', '바둑 대회', '한국기원', '프로바둑 대회', '바둑리그', '여자바둑리그',
  '신진서 대국', '최정 바둑', '세계 바둑대회', '아마추어 바둑대회',
  '어린이 바둑대회', '청소년 바둑대회', '지역 바둑대회', '생활체육 바둑대회'
];

const GENERIC_TITLES = new Set(['이 시각 주요 뉴스', '오늘의 주요 뉴스', '주요 뉴스', '뉴스 브리핑']);

const BODY_JUNK = /(?:무단전재|재배포\s*금지|저작권자|구독|로그인|회원가입|제보|관련기사|추천뉴스|많이\s*본\s*뉴스|기사제공|기자\s*[A-Z0-9._%+-]+@|기사의?\s*본문\s*내용|글자\s*크기|인쇄하기|공유하기)/i;

function classify(category, title, body = '') {
  const titleText = String(title || '');
  const bodyText = String(body || '').slice(0, 800);
  const text = `${titleText} ${bodyText}`;
  if (/(?:바둑|대국|기전|한국기원|신진서|최정\s*9단|카타고)/i.test(titleText)) return '바둑';
  const rules = [
    ['사회', /(?:폭행|살인|사망|숨진|경찰|검찰|법원|사건|사고|성매매|성범죄|조폭|검거|재판|수사|학교|교사|학생)/],
    ['경제', /(?:증시|주가|금리|환율|기업|투자|금융|부동산|아파트|원유|산업|수출|매출|순이익)/],
    ['정치', /(?:대통령|국회|국회의원|민주당|국민의힘|선거|정당|총리|장관|외교부|정부\s*정책)/],
    ['IT/과학', /(?:인공지능|\bAI\b|반도체|과학|로봇|스마트폰|소프트웨어|클라우드|우주)/i],
    ['세계', /(?:미국|중국|일본|러시아|이란|유럽|중동|트럼프|해외|국제사회)/],
    ['생활/문화', /(?:여행|축제|문화|영화|공연|음식|건강|날씨|관광|스포츠)/],
  ];
  return rules.find(([, pattern]) => pattern.test(titleText))?.[0]
    || rules.find(([, pattern]) => pattern.test(bodyText))?.[0]
    || (/(?:바둑|대국|기전|한국기원|신진서|카타고)/i.test(text) ? '바둑' : category);
}

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
}

function cleanBody(value) {
  const lines = normalizeText(value).split(/\n+/).map(line => line.trim()).filter(line =>
    line.length >= 12 && !BODY_JUNK.test(line) && !/^\s*(?:사진|영상|그래픽|ADVERTISEMENT)\s*[=:]/i.test(line)
  );
  return lines.join('\n').slice(0, 16000);
}

function findArticleBodies(value, found = []) {
  if (!value || found.length > 30) return found;
  if (Array.isArray(value)) {
    for (const item of value) findArticleBodies(item, found);
  } else if (typeof value === 'object') {
    if (typeof value.articleBody === 'string') found.push(value.articleBody);
    for (const child of Object.values(value)) findArticleBodies(child, found);
  }
  return found;
}

function cleanTitle(value) {
  return stripHtml(value)
    .replace(/\s*[-|–—]\s*[^-|–—]{1,30}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function pressFromTitle(value) {
  const text = stripHtml(value);
  return cleanPressName(text.match(/\s[-|–—]\s([^\-|–—]{1,30})$/u)?.[1] || '');
}

function cleanPressName(value) {
  return stripHtml(value)
    .replace(/\s+(?:[-|–—]|·)\s+(?:[^\n]{2,})$/u, '')
    .replace(/\s*(?:대한민국|울산)\s*(?:최초|최고)[^\n]*$/u, '')
    .trim()
    .slice(0, 40);
}

function parseDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

function articleSource(url, discovery = '', press = '') {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.endsWith('naver.com')) return 'NAVER';
    if (host.endsWith('daum.net')) return 'DAUM';
    if (host.endsWith('google.com')) return 'GOOGLE';
    return cleanPressName(press) || host;
  } catch { return cleanPressName(press) || discovery || '기타'; }
}

function allowedCandidate(url, discovery) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (discovery === 'KAKAO') return host === 'v.daum.net' || host.endsWith('.news.daum.net') || host === 'news.daum.net';
    return !/(?:dcinside\.com|tistory\.com|blog\.naver\.com|cafe\.naver\.com|fmkorea\.com|theqoo\.net|ruliweb\.com|clien\.net|ppomppu\.co\.kr|instiz\.net|youtube\.com|namu\.wiki)$/i.test(host);
  } catch { return false; }
}

async function fetchArticleText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/Cloudflare' },
      cf: { cacheTtl: 300, cacheEverything: false }
    });
    if (!response.ok) return { body: '', image: '', press: '' };
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { body: '', image: '', press: '' };
    const html = (await response.text()).slice(0, 800000);
    const image = normalizeText(html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1] || '');
    const siteName = cleanPressName(html.match(/<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:site_name["']/i)?.[1] || '');
    let jsonBody = '';
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(match[1]);
        for (const found of findArticleBodies(data)) if (found.length > jsonBody.length) jsonBody = found;
      } catch {}
    }
    const articleStart = html.search(/<(?:article|div)[^>]+(?:id|class)=["'][^"']*(?:dic_area|article_view|article-body|newsct_article|article_body|articleBody|news_body|view_cont)[^"']*["'][^>]*>/i);
    const article = articleStart >= 0 ? html.slice(articleStart, Math.min(html.length, articleStart + 180000)) : '';
    const body = cleanBody(jsonBody || stripHtml(article
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')));
    return { body, image: /^https?:\/\//.test(image) ? image : '', press: siteName };
  } catch {
    return { body: '', image: '', press: '' };
  }
}

async function naverSearch(env, query, start = 1, display = 5) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 없습니다.');
  }
  const endpoint = new URL('https://openapi.naver.com/v1/search/news.json');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('display', String(Math.min(Math.max(display, 1), 100)));
  endpoint.searchParams.set('start', String(start));
  endpoint.searchParams.set('sort', 'date');
  const response = await fetch(endpoint, {
    headers: {
      'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET
    }
  });
  if (!response.ok) throw new Error(`Naver API ${response.status}`);
  return (await response.json()).items || [];
}

async function kakaoSearch(env, query, page = 1, size = 5) {
  if (!env.KAKAO_REST_API_KEY) return [];
  const endpoint = new URL('https://dapi.kakao.com/v2/search/web');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('size', String(Math.min(Math.max(size, 1), 50)));
  endpoint.searchParams.set('page', String(page));
  endpoint.searchParams.set('sort', 'recency');
  const response = await fetch(endpoint, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` } });
  if (!response.ok) throw new Error(`Kakao API ${response.status}`);
  return ((await response.json()).documents || []).map(doc => ({
    title: doc.title, link: doc.url, originallink: doc.url, description: doc.contents,
    pubDate: doc.datetime, thumbnail: doc.thumbnail || ''
  }));
}

function xmlText(block, tag) {
  return normalizeText((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

async function googleNewsSearch(query) {
  const endpoint = new URL('https://news.google.com/rss/search');
  endpoint.searchParams.set('q', `${query} when:30d`);
  endpoint.searchParams.set('hl', 'ko');
  endpoint.searchParams.set('gl', 'KR');
  endpoint.searchParams.set('ceid', 'KR:ko');
  let response = await fetch(endpoint, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/1.0', accept: 'application/rss+xml, application/xml;q=0.9' } });
  if (response.status >= 500) {
    response = await fetch(endpoint, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' } });
  }
  if (!response.ok) throw new Error(`Google News RSS ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 5).map(match => {
    const rawTitle = xmlText(match[1], 'title');
    const parts = rawTitle.split(/\s+-\s+/);
    const press = parts.length > 1 ? parts.pop() : '';
    return {
      title: parts.join(' - ') || rawTitle, link: xmlText(match[1], 'link'),
      originallink: xmlText(match[1], 'link'), description: xmlText(match[1], 'description'),
      pubDate: xmlText(match[1], 'pubDate'), press
    };
  });
}

async function popularPage(url, source) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 NewsBrief/1.0' } });
  if (!response.ok) return [];
  const bytes = await response.arrayBuffer();
  const declared = response.headers.get('content-type') || '';
  let html = new TextDecoder('utf-8').decode(bytes);
  if (/euc-?kr|ks_c_5601|cp949/i.test(declared) || (html.match(/�/g) || []).length >= 3) {
    html = new TextDecoder('euc-kr').decode(bytes);
  }
  const out = [], seen = new Set();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = normalizeText(match[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (href.startsWith('/')) href = new URL(href, url).toString();
    if (source === 'NAVER' && !/naver\.com\/(?:main\/ranking\/(?:read|rankingRead)\.naver|mnews\/article|article\/)/i.test(href)) continue;
    if (source === 'DAUM' && !/(?:v\.daum\.net\/v\/|news\.daum\.net\/)/i.test(href)) continue;
    const title = cleanTitle(match[2]);
    if (title.length < 8 || seen.has(href) || isRejectedTitle(title)) continue;
    seen.add(href); out.push({ href, title, rank: out.length + 1, source });
    if (out.length >= 30) break;
  }
  return out;
}

async function collectPopularity() {
  const pages = [
    ...[['100','정치'],['101','경제'],['102','사회'],['103','생활/문화'],['104','세계']]
      .map(([sid, category]) => [`https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`, 'NAVER', category]),
    ['https://news.daum.net/ranking/popular', 'DAUM', '기타']
  ];
  const rows = [];
  for (const [url, source, category] of pages) rows.push(...(await popularPage(url, source)).map(row => ({ ...row, category })));
  return rows;
}

async function collectArchivedTop(slot) {
  const rows = [];
  const baseOffset = (slot % 10) * 3;
  for (let extra = 0; extra < 3; extra += 1) {
    const date = new Date(Date.now() - (baseOffset + extra) * 86400000);
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
    for (const [sid, category] of [['100','정치'],['101','경제'],['102','사회'],['103','생활/문화'],['104','세계']]) {
      const url = `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}&date=${ymd}`;
      const top = (await popularPage(url, 'NAVER'))[0];
      if (top) rows.push({ category, source: 'NAVER', item: { title: top.title, link: top.href, originallink: top.href, description: '', pubDate: date.toISOString() } });
    }
  }
  return rows;
}

async function collect(env, { backfill = false } = {}) {
  const diagnostics = { mode: backfill ? 'backfill' : 'scheduled', retry_attempted: 0, retry_repaired: 0, samples: [] };
  let aiRetryRemaining = 1;
  let aiNewRemaining = 1;
  const summarize = async (payload, detail, purpose = 'new') => {
    const useAi = purpose === 'retry' ? aiRetryRemaining > 0 : aiNewRemaining > 0;
    if (useAi && purpose === 'retry') aiRetryRemaining -= 1;
    if (useAi && purpose !== 'retry') aiNewRemaining -= 1;
    return makeBestSummary(useAi ? env : { AI: undefined }, payload, detail);
  };
  const stored = await env.DB.prepare('SELECT id,title,summary,body_text,category FROM news_articles').all();
  for (const row of stored.results || []) {
    const fixedCategory = classify(row.category, row.title, row.body_text);
    if (fixedCategory !== row.category) await env.DB.prepare('UPDATE news_articles SET category=? WHERE id=?').bind(fixedCategory, row.id).run();
  }
  const mislabeled = await env.DB.prepare("SELECT id,url,source,press FROM news_articles WHERE source IN ('NAVER','KAKAO','GOOGLE')").all();
  for (const row of mislabeled.results || []) {
    if (row.source === 'KAKAO' && !allowedCandidate(row.url, 'KAKAO')) {
      await env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id).run();
    }
    const fixed = articleSource(row.url, row.source, row.press);
    if (fixed !== row.source) await env.DB.prepare('UPDATE news_articles SET source=? WHERE id=?').bind(fixed, row.id).run();
  }
  const poisoned = (stored.results || []).filter(row => GENERIC_TITLES.has(row.title) || isRejectedTitle(row.title) || !validateThreeLineSummary(row.summary, row.title));
  if (poisoned.length) await env.DB.batch(poisoned.map(row => env.DB.prepare("UPDATE news_articles SET summary='',summary_quality='none' WHERE id=?").bind(row.id)));
  const retryRows = await env.DB.prepare(`SELECT a.id,a.url_key,a.title,a.raw_summary,a.body_text FROM news_articles a
    LEFT JOIN news_summary_attempts f ON f.url_key=a.url_key
    WHERE a.summary_quality='none' AND length(a.body_text)>=300 AND COALESCE(f.attempts,0)<3
    ORDER BY CASE WHEN a.category='바둑' THEN 0 ELSE 1 END, a.fetched_at DESC LIMIT 16`).all();
  for (const row of retryRows.results || []) {
    if (isRejectedTitle(row.title)) continue;
    const detail = {};
    const repaired = await summarize({ title: row.title, rawSummary: row.raw_summary, body: row.body_text }, detail, 'retry');
    diagnostics.retry_attempted += 1;
    if (diagnostics.samples.length < 2) diagnostics.samples.push({ title: row.title, ...detail });
    if (validateThreeLineSummary(repaired, row.title)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE news_articles SET summary=?,summary_quality='full' WHERE id=?").bind(repaired, row.id),
        env.DB.prepare('DELETE FROM news_summary_attempts WHERE url_key=?').bind(row.url_key)
      ]);
      diagnostics.retry_repaired += 1;
    } else {
      await env.DB.prepare(`INSERT INTO news_summary_attempts(url_key,attempts,last_attempt) VALUES(?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(url_key) DO UPDATE SET attempts=attempts+1,last_attempt=CURRENT_TIMESTAMP`).bind(row.url_key).run();
    }
  }
  const candidates = [];
  const cursorKey = backfill ? 'history_cursor' : 'rotation_cursor';
  const cursorRow = await env.DB.prepare('SELECT value FROM news_state WHERE key=?').bind(cursorKey).first();
  const slot = Number(cursorRow?.value || 0);
  await env.DB.prepare('INSERT INTO news_state(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').bind(cursorKey).run();
  const backfillStart = backfill ? (slot % 10) * 100 + 1 : (slot % 100) * 10 + 1;
  const badukQuery = BADUK_SEARCHES[slot % BADUK_SEARCHES.length];
  const selectedSearches = backfill
    ? SEARCHES.filter(([category]) => category === '바둑')
    : SEARCHES;
  for (const [category, query] of selectedSearches) {
    const effectiveQuery = category === '바둑' ? (backfill ? '바둑' : badukQuery) : query;
    const start = backfill ? backfillStart : (category === '바둑' ? backfillStart : 1);
    const display = backfill ? 10 : 5;
    const items = await naverSearch(env, effectiveQuery, start, display);
    const take = backfill ? (category === '바둑' ? 5 : 2) : (category === '바둑' ? 2 : 1);
    for (const item of items.slice(0, take)) candidates.push({ category, item, source: 'NAVER' });
    try {
      const page = backfill ? (slot % 10) * 5 + 1 : (category === '바둑' ? (slot % 10) + 1 : 1);
      const kakaoItems = await kakaoSearch(env, effectiveQuery, page, backfill ? 10 : 5);
      for (const item of kakaoItems.slice(0, take)) candidates.push({ category, item, source: 'KAKAO' });
    } catch (error) {
      diagnostics.kakao_error = String(error?.message || error).slice(0, 120);
    }
  }
  if (backfill) {
    try {
      candidates.push(...await collectArchivedTop(slot));
      diagnostics.archive_candidates = candidates.length;
    } catch (error) {
      diagnostics.archive_error = String(error?.message || error).slice(0, 120);
    }
  }
  if (!backfill) try {
    for (const item of (await googleNewsSearch(badukQuery)).slice(0, 3)) candidates.push({ category: '바둑', item, source: 'GOOGLE' });
  } catch (error) {
    diagnostics.google_error = String(error?.message || error).slice(0, 120);
  }
  if (!backfill) try {
    const popular = await collectPopularity();
    diagnostics.popular_found = popular.length;
    for (const row of popular.filter(row => row.rank <= 2)) candidates.push({
      category: row.category,
      source: row.source,
      item: { title: row.title, link: row.href, originallink: row.href, description: '', pubDate: '' }
    });
    for (const row of popular) {
      const key = await sha256(canonicalUrl(row.href));
      await env.DB.prepare(`INSERT INTO news_popularity(url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(url_key) DO UPDATE SET
        score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(key, 101 - row.rank, row.rank, row.source).run();
      await env.DB.prepare(`INSERT INTO news_popular_items(title,url_key,score,rank,source,collected_at)
        VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(title) DO UPDATE SET
        url_key=excluded.url_key,score=excluded.score,rank=excluded.rank,source=excluded.source,collected_at=CURRENT_TIMESTAMP`)
        .bind(row.title, key, 101 - row.rank, row.rank, row.source).run();
    }
  } catch (error) {
    diagnostics.popular_error = String(error?.message || error).slice(0, 120);
  }

  const processCandidate = async ({ category, item, source }) => {
    const preferredUrl = source === 'NAVER' && /naver\.com\//i.test(item.link || '') ? item.link : (item.originallink || item.link);
    const url = canonicalUrl(preferredUrl);
    const title = cleanTitle(item.title);
    const publishedAt = parseDate(item.pubDate);
    if (!url || !title || GENERIC_TITLES.has(title) || isRejectedTitle(title) || !/^https?:\/\//.test(url)) return 0;
    if (!allowedCandidate(url, source)) return 0;
    if (publishedAt && Date.parse(publishedAt) < Date.now() - 30 * 86400000) return 0;
    const press = item.press || pressFromTitle(item.title);
    const urlKey = await sha256(url);
    const exists = await env.DB.prepare('SELECT id,image_url,summary_quality,raw_summary,body_text FROM news_articles WHERE url_key=?').bind(urlKey).first();
    if (exists) {
      if (!exists.image_url || exists.summary_quality !== 'full') {
        const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
        let article = await fetchArticleText(fetchUrl);
        if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
        const repaired = await summarize({ title, rawSummary: stripHtml(item.description) || exists.raw_summary, body: article.body || exists.body_text }, null, 'retry');
        const valid = validateThreeLineSummary(repaired, title);
        await env.DB.prepare(`UPDATE news_articles SET
          title=?,
          press=CASE WHEN ?<>'' THEN ? ELSE press END,
          image_url=CASE WHEN ?<>'' THEN ? ELSE image_url END,
          body_text=CASE WHEN ?<>'' THEN ? ELSE body_text END,
          summary=CASE WHEN ? THEN ? ELSE summary END,
          summary_quality=CASE WHEN ? THEN 'full' ELSE summary_quality END
          WHERE id=?`).bind(title, article.press, article.press, article.image, article.image, article.body, article.body, valid ? 1 : 0, repaired, valid ? 1 : 0, exists.id).run();
      }
      return 0;
    }

    const rawSummary = stripHtml(item.description);
    const fetchUrl = /^https?:\/\/(?:n\.)?news\.naver\.com\//i.test(item.link || '') ? item.link : url;
    let article = await fetchArticleText(fetchUrl);
    if (article.body.length < 300 && fetchUrl !== url) article = await fetchArticleText(url);
    const body = article.body;
    const finalCategory = classify(category, title, body || rawSummary);
    const summary = await summarize({ title, rawSummary, body });
    const validSummary = validateThreeLineSummary(summary, title);

    await env.DB.prepare(`
      INSERT INTO news_articles
        (url,url_key,title,source,press,category,published_at,raw_summary,body_text,summary,summary_quality,image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url_key) DO UPDATE SET
        title=excluded.title, press=excluded.press, category=excluded.category,
        published_at=excluded.published_at, raw_summary=excluded.raw_summary,
        body_text=CASE WHEN length(excluded.body_text)>length(news_articles.body_text) THEN excluded.body_text ELSE news_articles.body_text END,
        summary=CASE WHEN length(excluded.summary)>length(news_articles.summary) THEN excluded.summary ELSE news_articles.summary END,
        summary_quality=excluded.summary_quality
    `).bind(
      url, urlKey, title, articleSource(url, source, article.press || press), article.press || press, finalCategory, publishedAt, rawSummary,
      body, validSummary ? summary : '', validSummary ? 'full' : 'none', article.image
    ).run();
    return 1;
  };
  diagnostics.candidates = candidates.length;
  const inserted = (await Promise.all(candidates.map(processCandidate))).reduce((sum, value) => sum + value, 0);
  return { inserted, diagnostics };
}

export async function onRequestPost({ request, env }) {
  if (!isCollectorAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);
  let runId;
  try {
    await ensureNewsDb(env);
    await env.DB.prepare(`UPDATE news_runs SET finished_at=?,status='error',message='이전 수집이 비정상 종료됨'
      WHERE status='running' AND started_at < datetime('now','-10 minutes')`).bind(new Date().toISOString()).run();
    const started = new Date().toISOString();
    const run = await env.DB.prepare("INSERT INTO news_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(started).first();
    runId = run?.id;
    const backfill = new URL(request.url).searchParams.get('backfill') === '1';
    const result = await collect(env, { backfill });
    await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='ok',inserted_count=? WHERE id=?")
      .bind(new Date().toISOString(), result.inserted, runId).run();
    return json({ ok: true, ...result });
  } catch (error) {
    if (runId) {
      await env.DB.prepare("UPDATE news_runs SET finished_at=?,status='error',message=? WHERE id=?")
        .bind(new Date().toISOString(), String(error.message || error).slice(0, 500), runId).run();
    }
    return json({ ok: false, error: error.message }, 500);
  }
}
