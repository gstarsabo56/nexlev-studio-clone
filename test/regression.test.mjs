import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sqlite from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  parseViewOrSubscriberCount,
  parseRelativePublishedDate,
  parseDurationSecondsStrict,
  classifyVideoContentType
} from '../src/core/parsers.mjs';

import {
  evaluateChannelVideosOutliers,
  classifyChannelHeuristic,
  buildHonestChannelRecord,
  simulateRpmScenario
} from '../src/core/metrics.mjs';

import {
  initSchema,
  upsertChannelAndVideos,
  authenticateUser,
  resolveUserFromToken,
  loadSecrets,
  updateSecrets
} from '../src/core/sqlite-repo.mjs';

import {
  deriveChannelStatsFromVideos,
  auditThumbnailAndTitle,
  generateVideoProductionOutline,
  getChannelDetail,
  createSwipeItem,
  updateSwipeItem,
  generateSwipeProductionBrief,
  saveSettingsAndSecrets,
  normalizeWorkflowStage
} from '../src/core/engine.mjs';

import {
  selectSeedsForMarket,
  markSeedAttemptStart,
  markSeedFailure,
  markSeedSuccess,
  updateCrawlerSchedule,
  crawlerState
} from '../src/core/crawler.mjs';

import {
  createNexlevServer
} from '../src/server.mjs';

import {
  handleRpcMessage
} from '../mcp-server/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_TMP_DIR = path.join(__dirname, '..', 'test-tmp');

function createIsolatedTestDb(name) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const sqlitePath = path.join(
    TEST_TMP_DIR,
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.sqlite`
  );
  const db = new sqlite.DatabaseSync(sqlitePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at, reconciliation_json) VALUES ('v2.0-honest-sqlite', ?, '{}')`
  ).run(new Date().toISOString());
  return db;
}

test('1. Multi-locale count parser parses 1B as 1_000_000_000, handles decimal separators, and returns unknown on unparsed units', () => {
  const b1 = parseViewOrSubscriberCount('1B views');
  assert.equal(b1.value, 1_000_000_000);
  assert.equal(b1.status, 'observed');

  const b12 = parseViewOrSubscriberCount('1.2B views');
  assert.equal(b12.value, 1_200_000_000);

  const de = parseViewOrSubscriberCount('1,2 Mio. Aufrufe', 'de');
  assert.equal(de.value, 1_200_000);
  assert.equal(de.status, 'observed');

  const ko = parseViewOrSubscriberCount('조회수 1.5억회', 'ko');
  assert.equal(ko.value, 150_000_000);

  const vn = parseViewOrSubscriberCount('2,5 Tr người đăng ký', 'vi');
  assert.equal(vn.value, 2_500_000);

  const grouped = parseViewOrSubscriberCount('1,234,567 views', 'en');
  assert.equal(grouped.value, 1_234_567);

  const unknownUnit = parseViewOrSubscriberCount('12 zillion views', 'en');
  assert.equal(unknownUnit.value, null);
  assert.equal(unknownUnit.status, 'unknown');

  const hidden = parseViewOrSubscriberCount('');
  assert.equal(hidden.value, null);
  assert.equal(hidden.status, 'unknown');
});

test('2. Relative published date parser handles FR, PT, NL and never defaults to 12 days on unknown input', () => {
  const refMs = Date.parse('2026-10-15T12:00:00.000Z');

  const fr = parseRelativePublishedDate('il y a 3 semaines', refMs);
  assert.equal(fr.status, 'derived');
  assert.equal(fr.ageDays, 21);

  const pt = parseRelativePublishedDate('há 2 meses', refMs);
  assert.equal(pt.status, 'derived');
  assert.equal(pt.ageDays, 60);

  const nl = parseRelativePublishedDate('5 dagen geleden', refMs);
  assert.equal(nl.status, 'derived');
  assert.equal(nl.ageDays, 5);

  const unparseable = parseRelativePublishedDate('en direct prochainement', refMs);
  assert.equal(unparseable.value, null);
  assert.equal(unparseable.ageDays, null);
  assert.equal(unparseable.status, 'unknown');
  assert.notEqual(unparseable.ageDays, 12);
});

test('3. deriveChannelStatsFromVideos([]) returns null/unknown instead of fabricating subscribers, age, or growth', () => {
  const emptyStats = deriveChannelStatsFromVideos([]);
  assert.equal(emptyStats.subscribers, null);
  assert.equal(emptyStats.subscribersStatus, 'unknown');
  assert.equal(emptyStats.videoCount, null);
  assert.equal(emptyStats.videoCountStatus, 'unknown');
  assert.equal(emptyStats.channelAgeMonths, null);
  assert.equal(emptyStats.channelAgeStatus, 'unknown');
  assert.equal(emptyStats.monthlyViews, null);
  assert.equal(emptyStats.growthRate30d, null);
  assert.equal(emptyStats.growthStatus, 'unknown');
});

test('4. Single-video channel has outlierRatio=null (insufficient_data) and renaming channel never changes outlier baseline', () => {
  const singleVideo = [
    {
      videoId: 'vid_single_1',
      title: 'Test Video 1',
      views: 150_000,
      durationMinutes: 10,
      contentType: 'long',
      publishedDaysAgo: 14
    }
  ];

  const recordNameA = buildHonestChannelRecord({
    channelId: 'UC_TEST_1',
    title: 'Alpha Channel Name',
    videos: singleVideo,
    minOutlierSampleSize: 3
  });
  const recordNameB = buildHonestChannelRecord({
    channelId: 'UC_TEST_1',
    title: 'Completely Renamed Channel ZZZ',
    videos: singleVideo,
    minOutlierSampleSize: 3
  });

  assert.equal(recordNameA.videos[0].outlierRatio, null);
  assert.equal(recordNameA.videos[0].outlierStatus, 'insufficient_data');
  assert.equal(recordNameA.videos[0].baselineMedianViews, null);

  assert.equal(
    recordNameA.videos[0].outlierRatio,
    recordNameB.videos[0].outlierRatio
  );
  assert.equal(
    recordNameA.videos[0].baselineMedianViews,
    recordNameB.videos[0].baselineMedianViews
  );
});

test('5. Empty text returns unknown faceless classification instead of fake confidence', () => {
  const emptyResult = classifyChannelHeuristic('');
  assert.equal(emptyResult.isFaceless, null);
  assert.equal(emptyResult.facelessStatus, 'unknown');
  assert.equal(emptyResult.facelessReason, 'empty_text_input');
});

test('6. Upserting a channel on re-crawl merges videos and never deletes existing channel videos', () => {
  const db = createIsolatedTestDb('merge-videos');
  try {
    upsertChannelAndVideos(db, {
      channelId: 'UC_MERGE_TEST',
      title: 'Merge Channel',
      dataOrigin: 'observed',
      videos: [
        { videoId: 'vid_old_1', title: 'Old Video 1', views: 10000, durationMinutes: 8, contentType: 'long' },
        { videoId: 'vid_old_2', title: 'Old Video 2', views: 20000, durationMinutes: 9, contentType: 'long' }
      ]
    });

    // Second crawl discovers only 1 new video for the same channel
    upsertChannelAndVideos(db, {
      channelId: 'UC_MERGE_TEST',
      title: 'Merge Channel',
      dataOrigin: 'observed',
      videos: [
        { videoId: 'vid_new_3', title: 'New Video 3', views: 95000, durationMinutes: 11, contentType: 'long' }
      ]
    });

    const detail = getChannelDetail('UC_MERGE_TEST', db);
    assert.equal(detail.found, true);
    assert.equal(detail.channel.videos.length, 3, 'All 3 videos must be preserved after re-crawl');
    assert.equal(detail.channel.observedVideoSampleCount, 3);
    assert.ok(detail.channel.topOutlierRatio !== null, 'With 3 long videos, outlier ratio is now computable');
  } finally {
    db.close();
  }
});

test('7. Seed selection picks unseen seeds first, then oldest last_success_at, and failed seeds do not update last_success_at', () => {
  const db = createIsolatedTestDb('seeds');
  try {
    const now = '2026-10-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO crawl_seeds (seed_key, market_code, language_code, keyword, origin, status, created_at)
      VALUES
        ('XX:seed1', 'XX', 'en', 'seed1', 'custom', 'pending', ?),
        ('XX:seed2', 'XX', 'en', 'seed2', 'custom', 'pending', ?)
    `).run(now, now);

    const firstBatch = selectSeedsForMarket(db, 'XX', 1);
    assert.equal(firstBatch[0].seed_key, 'XX:seed1');

    // Simulate failure on XX:seed1 -> last_success_at must remain null
    markSeedAttemptStart(db, 'XX:seed1', '2026-10-02T00:00:00.000Z');
    markSeedFailure(db, 'XX:seed1', 'Simulated network error', '2026-10-02T00:01:00.000Z');

    const seed1Row = db.prepare(`SELECT * FROM crawl_seeds WHERE seed_key = 'XX:seed1'`).get();
    assert.equal(seed1Row.last_success_at, null);
    assert.equal(seed1Row.status, 'failed');
    assert.equal(seed1Row.attempt_count, 1);

    // Mark both XX:seed1 and XX:seed2 as succeeded at different timestamps
    markSeedSuccess(db, 'XX:seed1', 3, '2026-10-03T00:00:00.000Z');
    markSeedAttemptStart(db, 'XX:seed2', '2026-10-10T00:00:00.000Z');
    markSeedSuccess(db, 'XX:seed2', 2, '2026-10-10T00:01:00.000Z');

    // Now all seeds in market XX have been seen; next pick must select oldest last_success_at ('XX:seed1')
    const rotated = selectSeedsForMarket(db, 'XX', 1);
    assert.equal(rotated[0].seed_key, 'XX:seed1');
  } finally {
    db.close();
  }
});

test('8. Disabling crawler schedule with intervalMinutes keeps autoScheduleEnabled=false', () => {
  const db = createIsolatedTestDb('schedule');
  try {
    updateCrawlerSchedule({ autoScheduleEnabled: true, intervalMinutes: 20 }, db);
    assert.equal(crawlerState.autoScheduleEnabled, true);

    const updated = updateCrawlerSchedule({ autoScheduleEnabled: false, intervalMinutes: 15 }, db);
    assert.equal(updated.autoScheduleEnabled, false);
    assert.equal(updated.intervalMinutes, 15);
    assert.equal(crawlerState.autoScheduleEnabled, false);
  } finally {
    updateCrawlerSchedule({ autoScheduleEnabled: false }, db);
    db.close();
  }
});

test('9. Transcript unavailable vs metadata outline are strictly separated', () => {
  const db = createIsolatedTestDb('outline');
  try {
    upsertChannelAndVideos(db, {
      channelId: 'UC_OUTLINE',
      title: 'Outline Test Channel',
      dataOrigin: 'observed',
      videos: [
        { videoId: 'vid_outline_1', title: 'How SQLite WAL Works', views: 50000, durationMinutes: 12 }
      ]
    });

    const outline = generateVideoProductionOutline('vid_outline_1', db);
    assert.equal(outline.status, 'derived');
    assert.equal(outline.source, 'production_outline_generator');
    assert.ok(outline.note.includes('KHÔNG phải transcript'));
    assert.ok(Array.isArray(outline.sections));
  } finally {
    db.close();
  }
});

test('10. Thumbnail & title audit never awards visual bonus points just because thumbnailUrl is non-empty', async () => {
  const auditWithoutUrl = await auditThumbnailAndTitle({
    title: 'Why 99% of Channels Fail in 2026',
    thumbnailUrl: '',
    niche: 'Documentary'
  });
  const auditWithUrl = await auditThumbnailAndTitle({
    title: 'Why 99% of Channels Fail in 2026',
    thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    niche: 'Documentary'
  });

  assert.equal(auditWithUrl.imageAnalysisStatus, 'not_analyzed');
  assert.equal(auditWithUrl.scoreStatus, 'heuristic_title_only');
  assert.equal(
    auditWithUrl.ctrScore,
    auditWithoutUrl.ctrScore,
    'Passing an unanalyzed image URL must not inflate ctrScore'
  );
});

test('11, 12, 13. HTTP Server returns 404 JSON on unknown API routes, 400 JSON on invalid JSON, and preserves secrets on empty string', async () => {
  const previousSecrets = loadSecrets();
  updateSecrets({
    youtubeApiKeyAction: 'replace',
    youtubeApiKey: 'AIzaSyTestPreservedKey999999'
  });

  const server = createNexlevServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 11. Unknown /api/* route returns 404 JSON (never HTML 200)
    const res404 = await fetch(`${baseUrl}/api/v1/non-existent-endpoint`);
    assert.equal(res404.status, 404);
    assert.ok((res404.headers.get('content-type') || '').includes('application/json'));
    const body404 = await res404.json();
    assert.equal(body404.code, 'API_NOT_FOUND');

    // 12. Malformed JSON returns 400 JSON
    const res400 = await fetch(`${baseUrl}/api/v1/swipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"brokenJson": '
    });
    assert.equal(res400.status, 400);
    const body400 = await res400.json();
    assert.equal(body400.code, 'INVALID_JSON');

    // 13. Submitting empty string in settings does NOT wipe existing YouTube API Key
    const resSettings = await fetch(`${baseUrl}/api/v1/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        youtubeApiKey: '',
        includeDemo: false
      })
    });
    assert.equal(resSettings.status, 200);
    assert.equal(loadSecrets().youtubeApiKey, 'AIzaSyTestPreservedKey999999');
  } finally {
    updateSecrets({
      youtubeApiKeyAction: previousSecrets.youtubeApiKey ? 'replace' : 'clear',
      youtubeApiKey: previousSecrets.youtubeApiKey || ''
    });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('14. MCP Server negotiates protocolVersion and rejects analyze_youtube_channel with empty arguments', async () => {
  const db = createIsolatedTestDb('mcp-server');
  try {
    upsertChannelAndVideos(db, {
      channelId: 'UC_FIRST_CHANNEL',
      title: 'First Channel',
      dataOrigin: 'observed',
      videos: []
    });

    // Initialize handshake with unsupported client protocol version -> server negotiates supported version
    const initResp = await handleRpcMessage(
      {
        jsonrpc: '2.0',
        mId: 1,
        method: 'initialize',
        params: { protocolVersion: '2099-01-01' }
      },
      db
    );
    assert.equal(initResp.protocolVersion, '2024-11-05');

    // Call analyze_youtube_channel with {} -> must return isError: true
    const callResp = await handleRpcMessage(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'analyze_youtube_channel',
          arguments: {}
        }
      },
      db
    );
    assert.equal(callResp.isError, true);
  } finally {
    db.close();
  }
});

test('15 & 16. Internal Auth, 6-Stage Team Production Workflow (Phát hiện → Duyệt → Brief → Giao việc → Đã đăng → Đánh giá), and Brief Generation', () => {
  const db = createIsolatedTestDb('team-workflow');
  try {
    // Verify seeded users and login
    const managerAuth = authenticateUser(db, 'admin', 'nexlev-admin-2026');
    assert.ok(managerAuth);
    assert.equal(managerAuth.user.role, 'manager');

    const memberAuth = authenticateUser(db, 'member1', 'nexlev-member-2026');
    assert.ok(memberAuth);
    assert.equal(memberAuth.user.role, 'member');

    const verifiedMember = resolveUserFromToken(db, memberAuth.token);
    assert.equal(verifiedMember.username, 'member1');

    // Seed a channel with 3 videos so outlier is computed honestly
    upsertChannelAndVideos(db, {
      channelId: 'UC_WORKFLOW_CH',
      title: 'Workflow Science Channel',
      dataOrigin: 'observed',
      videos: [
        { videoId: 'vid_wf_1', title: 'Baseline Video 1', views: 10_000, durationMinutes: 10, contentType: 'long' },
        { videoId: 'vid_wf_2', title: 'Baseline Video 2', views: 12_000, durationMinutes: 11, contentType: 'long' },
        { videoId: 'vid_wf_3', title: 'Viral Outlier Video 3', views: 180_000, durationMinutes: 12, contentType: 'long' }
      ]
    });

    // Save item to Swipe Library (Stage 1: discovered / Phát hiện)
    const saved = createSwipeItem(
      {
        videoId: 'vid_wf_3',
        channelId: 'UC_WORKFLOW_CH',
        title: 'Viral Outlier Video 3',
        channelTitle: 'Workflow Science Channel',
        canonicalUrl: 'https://www.youtube.com/watch?v=vid_wf_3',
        thumbnailUrl: 'https://i.ytimg.com/vi/vid_wf_3/hqdefault.jpg',
        notes: 'High retention hook on science paradox',
        tags: ['science', 'outlier'],
        workflowStage: 'discovered',
        ownerLabel: 'Nhân viên Research 01',
        deadline: '2026-10-25'
      },
      db
    );

    assert.equal(saved.videoId, 'vid_wf_3');
    assert.equal(saved.channelId, 'UC_WORKFLOW_CH');
    assert.equal(saved.canonicalUrl, 'https://www.youtube.com/watch?v=vid_wf_3');
    assert.equal(saved.thumbnailUrl, 'https://i.ytimg.com/vi/vid_wf_3/hqdefault.jpg');
    assert.equal(saved.workflowStage, 'discovered');
    assert.equal(saved.ownerLabel, 'Nhân viên Research 01');
    assert.equal(saved.deadline, '2026-10-25');

    // Progress through all 6 stages: discovered -> approved -> briefing -> assigned -> published -> review
    const stages = ['approved', 'briefing', 'assigned', 'published', 'review'];
    for (const nextStage of stages) {
      const updated = updateSwipeItem(
        saved.id,
        {
          workflowStage: nextStage,
          resultUrl: nextStage === 'published' ? 'https://www.youtube.com/watch?v=our_published_vid' : undefined
        },
        db
      );
      assert.equal(updated.workflowStage, nextStage);
    }

    // Generate production brief for the item
    const briefUpdated = generateSwipeProductionBrief(saved.id, db);
    assert.ok(briefUpdated.briefMarkdown.includes('# Production Brief: Viral Outlier Video 3'));
    assert.equal(briefUpdated.resultUrl, 'https://www.youtube.com/watch?v=our_published_vid');
  } finally {
    db.close();
  }
});

test('17. Demo isolation, strict null vs 0 numeric filtering, and Extension batch-metrics baseline consistency', async () => {
  const { queryChannels, getBatchExtensionMetrics } = await import('../src/core/engine.mjs');
  const db = createIsolatedTestDb('demo-and-extension');
  try {
    // 1. Insert a demo channel and two observed channels (one with unknown subscribers, one with 15,000 subscribers)
    upsertChannelAndVideos(db, {
      channelId: 'UC_DEMO_FIXTURE',
      title: 'Demo Fixture Channel',
      dataOrigin: 'demo',
      observedSubscribers: 20_000,
      videos: [
        { videoId: 'v_demo_1', title: 'Demo 1', views: 50_000, durationMinutes: 10 },
        { videoId: 'v_demo_2', title: 'Demo 2', views: 60_000, durationMinutes: 10 },
        { videoId: 'v_demo_3', title: 'Demo 3', views: 300_000, durationMinutes: 10 }
      ]
    });

    upsertChannelAndVideos(db, {
      channelId: 'UC_OBS_UNKNOWN_SUBS',
      title: 'Observed Unknown Subs Channel',
      dataOrigin: 'observed',
      observedSubscribers: null,
      videos: [
        { videoId: 'v_u_1', title: 'Only 1 Video', views: 80_000, durationMinutes: 10 }
      ]
    });

    upsertChannelAndVideos(db, {
      channelId: 'UC_OBS_KNOWN_SUBS',
      title: 'Observed Known Subs Channel',
      dataOrigin: 'observed',
      observedSubscribers: 15_000,
      videos: [
        { videoId: 'v_k_1', title: 'Video 1', views: 10_000, durationMinutes: 10 },
        { videoId: 'v_k_2', title: 'Video 2', views: 14_000, durationMinutes: 10 },
        { videoId: 'v_k_3', title: 'Video 3 Outlier', views: 140_000, durationMinutes: 10 }
      ]
    });

    // By default (includeDemo=false), demo channel is strictly excluded
    const defaultList = queryChannels({ includeDemo: 'false' }, db);
    assert.ok(!defaultList.channels.some((c) => c.id === 'UC_DEMO_FIXTURE'));
    assert.equal(defaultList.channels.length, 2);

    // Numeric filter maxSubscribers=50000 without includeUnknown must NOT match UC_OBS_UNKNOWN_SUBS (null is not 0!)
    const strictSubFilter = queryChannels(
      { includeDemo: 'false', maxSubscribers: 50_000, includeUnknown: 'false' },
      db
    );
    assert.equal(strictSubFilter.channels.length, 1);
    assert.equal(strictSubFilter.channels[0].id, 'UC_OBS_KNOWN_SUBS');

    // Extension batch metrics must report insufficient_data for v_u_1 (1 video) and derived 10x for v_k_3 (3 videos)
    const extMetrics = getBatchExtensionMetrics(
      {
        videoIds: ['v_u_1', 'v_k_3'],
        channelIds: ['UC_OBS_UNKNOWN_SUBS', 'UC_OBS_KNOWN_SUBS']
      },
      db
    );
    assert.equal(extMetrics.videos['v_u_1'].outlierStatus, 'insufficient_data');
    assert.equal(extMetrics.videos['v_u_1'].outlierRatio, null);
    assert.equal(extMetrics.videos['v_k_3'].outlierStatus, 'derived');
    assert.equal(extMetrics.videos['v_k_3'].outlierRatio, 10);
  } finally {
    db.close();
  }
});

