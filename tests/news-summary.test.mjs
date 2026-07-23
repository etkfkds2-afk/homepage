import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, isJunkLine, sanitizeStoredSummary, validateThreeLineSummary } from '../functions/_lib/news-summary.js';

test('포털 자동요약 안내와 UI 문장을 제거한다', () => {
  const summary = buildSummary({
    title: '정부가 새 정책을 발표했다',
    rawSummary: '기사 제목과 주요 문장을 기반으로 자동 요약한 결과입니다.\n음성으로 듣기 번역 베타 타임톡',
    body: '정부는 23일 새 정책의 세부 내용을 공개했다. 지원 대상은 다음 달부터 확대된다. 관계 부처는 현장 의견을 추가로 수렴할 계획이다.'
  });
  assert.equal(summary.split('\n').length, 3);
  assert.doesNotMatch(summary, /자동\s*요약|음성으로 듣기|타임톡/);
});

test('제목 복붙과 중복 문장을 요약에 넣지 않는다', () => {
  const summary = buildSummary({
    title: '한국 대표팀이 결승에 진출했다',
    rawSummary: '한국 대표팀이 결승에 진출했다. 한국 대표팀이 결승에 진출했다.',
    body: '대표팀은 준결승에서 두 점 차 승리를 거뒀다. 결승전은 오는 일요일 서울에서 열린다.'
  });
  assert.equal(summary.split('\n').length, 2);
  assert.doesNotMatch(summary, /한국 대표팀이 결승에 진출했다/);
});

test('짧은 정상 기사는 억지로 세 줄을 만들지 않는다', () => {
  const result = sanitizeStoredSummary({
    title: '지역 축제가 주말에 열린다',
    body: '지역 축제는 토요일 오전 시민공원에서 개막한다.'
  });
  assert.equal(result.lineCount, 1);
  assert.equal(result.quality, 'short');
});

test('연락처·저작권·해시태그 라인을 잡음으로 판정한다', () => {
  assert.equal(isJunkLine('▶ 제보 전화 02-1234-5678'), true);
  assert.equal(isJunkLine('저작권자 © 뉴스 무단전재 및 재배포 금지'), true);
  assert.equal(isJunkLine('#정치 #경제 #오늘의뉴스'), true);
});

test('편집국 메타와 잘린 문장을 요약에서 제외한다', () => {
  const summary = buildSummary({
    title: '아시아 주요 현안',
    rawSummary: '편집국 July 23, 2026 완독 약 5 분 소요\n물류 센터 피격으로 직원들이 부상당했고...\n현지 정부는 피해 현황을 조사하고 있다고 밝혔다.'
  });
  assert.equal(summary, '1) 현지 정부는 피해 현황을 조사하고 있다고 밝혔다.');
});

test('오염되거나 세 줄이 아닌 요약은 저장을 거부한다', () => {
  assert.equal(validateThreeLineSummary('1) 정상적인 첫 문장이다.\n2) 정상적인 둘째 문장이다.\n3) updateLiveOnAirNews()', '제목'), false);
  assert.equal(validateThreeLineSummary('1) 한 줄뿐인 요약 문장으로 저장하면 안 된다.', '제목'), false);
  assert.equal(validateThreeLineSummary('1) 정부는 지원 정책의 세부 기준을 오늘 공개했다.\n2) 지원 대상은 다음 달부터 전국으로 확대될 예정이다.\n3) 관계 부처는 현장 의견을 반영해 후속 대책을 마련한다.', '새 지원 정책 발표'), true);
});

test('해설성 문장과 깨진 따옴표를 거부한다', () => {
  assert.equal(validateThreeLineSummary("1) 이번 행사의 진짜 관전 포인트다.\n2) 바둑판에 제3의 언어가 더해진 셈이다.\n3) 주최사는 프로그램을 제공했다고 밝혔다.", '행사'), false);
  assert.equal(validateThreeLineSummary("1) 협회는 아시아 각국의 현안을 정리했다고 밝혔다.\n2) 한국'엄마와 아빠 대신 보호자를 권고했다.\n3) 교육청은 논란 이후 권고안을 철회했다고 밝혔다.", '교육청 권고'), false);
});
