import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_TMP_DIR = path.join(__dirname, "..", "test-tmp");
fs.mkdirSync(TEST_TMP_DIR, { recursive: true });

// T19: Isolate SQLite & Secrets paths in test-tmp BEFORE any test touches default paths
process.env.NEXLEV_SQLITE_PATH = path.join(TEST_TMP_DIR, `server-test-${Date.now()}.sqlite`);
process.env.NEXLEV_SECRETS_PATH = path.join(TEST_TMP_DIR, `secrets-test-${Date.now()}.json`);

after(() => {
  try {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
});

import {
  parseViewOrSubscriberCount,
  parseRelativePublishedDate,
  parseDurationSecondsStrict,
  classifyVideoContentType
} from "../src/core/parsers.mjs";

import {
  evaluateChannelVideosOutliers,
  classifyChannelHeuristic,
  buildHonestChannelRecord,
  simulateRpmScenario
} from "../src/core/metrics.mjs";

import {
  initSchema,
  upsertChannelAndVideos,
  authenticateUser,
  resolveUserFromToken,
  updateTeamUser,
  listTeamUsers,
  loadSecrets,
  updateSecrets
} from "../src/core/sqlite-repo.mjs";

import {
  deriveChannelStatsFromVideos,
  auditThumbnailAndTitle,
  generateVideoProductionOutline,
  getChannelDetail,
  getChannelGrowthTracking,
  createSwipeItem,
  updateSwipeItem,
  transitionSwipeItem,
  deleteSwipeItem,
  generateSwipeProductionBrief,
  bulkImportTargets,
  getImportTargets,
  exportShortlist,
  saveSettingsAndSecrets,
  normalizeWorkflowStage
} from "../src/core/engine.mjs";

import {
  selectSeedsForMarket,
  markSeedAttemptStart,
  markSeedFailure,
  markSeedSuccess,
  updateCrawlerSchedule,
  recoverInterruptedCrawlJobs,
  crawlerState
} from "../src/core/crawler.mjs";

import { createNexlevServer } from "../src/server.mjs";
import { handleRpcMessage } from "../mcp-server/index.mjs";

function createIsolatedTestDb(name) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const sqlitePath = path.join(
    TEST_TMP_DIR,
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.sqlite`
  );
  const db = new sqlite.DatabaseSync(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at, reconciliation_json) VALUES ('v2.0-honest-sqlite', ?, '{}'), ('v2.1-review-redesign-fixes', ?, '{}')`
  ).run(new Date().toISOString(), new Date().toISOString());
  return db;
}

test("1. Multi-locale count parser parses 1B as 1_000_000_000, handles decimal separators, and returns unknown on unparsed units", () => {
  const b1 = parseViewOrSubscriberCount("1B views");
  assert.equal(b1.value, 1_000_000_000);
  assert.equal(b1.status, "observed");

  const b12 = parseViewOrSubscriberCount("1.2B views");
  assert.equal(b12.value, 1_200_000_000);

  const de = parseViewOrSubscriberCount("1,2 Mio. Aufrufe", "de");
  assert.equal(de.value, 1_200_000);
  assert.equal(de.status, "observed");

  const ko = parseViewOrSubscriberCount("조회수 1.5억회", "ko");
  assert.equal(ko.value, 150_000_000);

  const vn = parseViewOrSubscriberCount("2,5 Tr người đăng ký", "vi");
  assert.equal(vn.value, 2_500_000);

  const grouped = parseViewOrSubscriberCount("1,234,567 views", "en");
  assert.equal(grouped.value, 1_234_567);

  const unknownUnit = parseViewOrSubscriberCount("12 zillion views", "en");
  assert.equal(unknownUnit.value, null);
  assert.equal(unknownUnit.status, "unknown");

  const hidden = parseViewOrSubscriberCount("");
  assert.equal(hidden.value, null);
  assert.equal(hidden.status, "unknown");
});

test("2. Relative published date parser handles FR, PT, NL, hours/seconds accurately (T16) and never defaults to 12 days on unknown input", () => {
  const refMs = Date.parse("2026-10-15T12:00:00.000Z");

  const fr = parseRelativePublishedDate("il y a 3 semaines", refMs);
  assert.equal(fr.status, "derived");
  assert.equal(fr.ageDays, 21);

  const pt = parseRelativePublishedDate("há 2 meses", refMs);
  assert.equal(pt.status, "derived");
  assert.equal(pt.ageDays, 60);

  const nl = parseRelativePublishedDate("5 dagen geleden", refMs);
  assert.equal(nl.status, "derived");
  assert.equal(nl.ageDays, 5);

  const hrs12 = parseRelativePublishedDate("12 hours ago", refMs);
  assert.equal(hrs12.status, "derived");
  assert.equal(hrs12.ageDays, 0.5);

  const unparseable = parseRelativePublishedDate("en direct prochainement", refMs);
  assert.equal(unparseable.value, null);
  assert.equal(unparseable.ageDays, null);
  assert.equal(unparseable.status, "unknown");
  assert.notEqual(unparseable.ageDays, 12);
});

test("3. deriveChannelStatsFromVideos([]) returns null/unknown instead of fabricating subscribers, age, or growth", () => {
  const emptyStats = deriveChannelStatsFromVideos([]);
  assert.equal(emptyStats.subscribers, null);
  assert.equal(emptyStats.subscribersStatus, "unknown");
  assert.equal(emptyStats.videoCount, null);
  assert.equal(emptyStats.videoCountStatus, "unknown");
  assert.equal(emptyStats.channelAgeMonths, null);
  assert.equal(emptyStats.channelAgeStatus, "unknown");
  assert.equal(emptyStats.monthlyViews, null);
  assert.equal(emptyStats.growthRate30d, null);
  assert.equal(emptyStats.growthStatus, "unknown");
});

test("4. Single-video channel has outlierRatio=null (insufficient_data) and renaming channel never changes outlier baseline", () => {
  const singleVideo = [
    {
      videoId: "vid_single_1",
      title: "Test Video 1",
      views: 150_000,
      durationMinutes: 10,
      contentType: "long",
      publishedDaysAgo: 14
    }
  ];

  const recordNameA = buildHonestChannelRecord({
    channelId: "UC_TEST_1",
    title: "Alpha Channel Name",
    videos: singleVideo,
    minOutlierSampleSize: 3
  });
  const recordNameB = buildHonestChannelRecord({
    channelId: "UC_TEST_1",
    title: "Completely Renamed Channel ZZZ",
    videos: singleVideo,
    minOutlierSampleSize: 3
  });

  assert.equal(recordNameA.videos[0].outlierRatio, null);
  assert.equal(recordNameA.videos[0].outlierStatus, "insufficient_data");
  assert.equal(recordNameA.videos[0].baselineMedianViews, null);

  assert.equal(recordNameA.videos[0].outlierRatio, recordNameB.videos[0].outlierRatio);
  assert.equal(recordNameA.videos[0].baselineMedianViews, recordNameB.videos[0].baselineMedianViews);
});

test("5. Empty text returns unknown faceless classification instead of fake confidence", () => {
  const emptyResult = classifyChannelHeuristic("");
  assert.equal(emptyResult.isFaceless, null);
  assert.equal(emptyResult.facelessStatus, "unknown");
  assert.equal(emptyResult.facelessReason, "empty_text_input");
});

test("6. Upserting a channel on re-crawl merges videos, upgrades provenance (T06), and computes dynamic publishedDaysAgo", () => {
  const db = createIsolatedTestDb("merge-videos");
  try {
    upsertChannelAndVideos(db, {
      channelId: "UC_MERGE_TEST",
      title: "Merge Channel",
      dataOrigin: "observed",
      videos: [
        {
          videoId: "vid_old_1",
          title: "Old Video 1",
          views: 10000,
          durationMinutes: 8,
          contentType: "long",
          dataOrigin: "legacy_unverified"
        },
        {
          videoId: "vid_old_2",
          title: "Old Video 2",
          views: 20000,
          durationMinutes: 9,
          contentType: "long"
        }
      ]
    });

    // Second crawl re-observes vid_old_1 with verified provenance and adds vid_new_3
    const fiveDaysAgoIso = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    upsertChannelAndVideos(db, {
      channelId: "UC_MERGE_TEST",
      title: "Merge Channel",
      dataOrigin: "observed",
      videos: [
        {
          videoId: "vid_old_1",
          title: "Old Video 1 Verified",
          views: 11000,
          durationMinutes: 8,
          contentType: "long",
          dataOrigin: "observed",
          publishedAt: fiveDaysAgoIso
        },
        {
          videoId: "vid_new_3",
          title: "New Video 3",
          views: 95000,
          durationMinutes: 11,
          contentType: "long"
        }
      ]
    });

    const detail = getChannelDetail("UC_MERGE_TEST", db);
    assert.equal(detail.found, true);
    assert.equal(detail.channel.videos.length, 3, "All 3 videos must be preserved after re-crawl");
    assert.equal(detail.channel.observedVideoSampleCount, 3);
    assert.ok(detail.channel.topOutlierRatio !== null, "With 3 observed long videos, outlier ratio is computable");

    const v1 = detail.channel.videos.find((v) => v.videoId === "vid_old_1");
    assert.equal(v1.dataOrigin, "observed", "Provenance must upgrade from legacy_unverified to observed");
    assert.ok(v1.publishedDaysAgo >= 4.9 && v1.publishedDaysAgo <= 5.2, "publishedDaysAgo must be dynamically computed from published_at");
  } finally {
    db.close();
  }
});

test("7. Seed selection picks unseen seeds first, then oldest last_success_at, and failed seeds do not update last_success_at", () => {
  const db = createIsolatedTestDb("seeds");
  try {
    const now = "2026-10-01T00:00:00.000Z";
    db.prepare(`
      INSERT INTO crawl_seeds (seed_key, market_code, language_code, keyword, origin, status, created_at)
      VALUES
        ('XX:seed1', 'XX', 'en', 'seed1', 'custom', 'pending', ?),
        ('XX:seed2', 'XX', 'en', 'seed2', 'custom', 'pending', ?)
    `).run(now, now);

    const firstBatch = selectSeedsForMarket(db, "XX", 1);
    assert.equal(firstBatch[0].seed_key, "XX:seed1");

    markSeedAttemptStart(db, "XX:seed1", "2026-10-02T00:00:00.000Z");
    markSeedFailure(db, "XX:seed1", "Simulated network error", "2026-10-02T00:01:00.000Z");

    const seed1Row = db.prepare(`SELECT * FROM crawl_seeds WHERE seed_key = 'XX:seed1'`).get();
    assert.equal(seed1Row.last_success_at, null);
    assert.equal(seed1Row.status, "failed");
    assert.equal(seed1Row.attempt_count, 1);

    markSeedSuccess(db, "XX:seed1", 3, "2026-10-03T00:00:00.000Z");
    markSeedAttemptStart(db, "XX:seed2", "2026-10-10T00:00:00.000Z");
    markSeedSuccess(db, "XX:seed2", 2, "2026-10-10T00:01:00.000Z");

    const rotated = selectSeedsForMarket(db, "XX", 1);
    assert.equal(rotated[0].seed_key, "XX:seed1");
  } finally {
    db.close();
  }
});

test("8. Disabling crawler schedule with intervalMinutes keeps autoScheduleEnabled=false", () => {
  const db = createIsolatedTestDb("schedule");
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

test("9. Transcript unavailable vs metadata outline are strictly separated", () => {
  const db = createIsolatedTestDb("outline");
  try {
    upsertChannelAndVideos(db, {
      channelId: "UC_OUTLINE",
      title: "Outline Test Channel",
      dataOrigin: "observed",
      videos: [
        { videoId: "vid_outline_1", title: "How SQLite WAL Works", views: 50000, durationMinutes: 12 }
      ]
    });

    const outline = generateVideoProductionOutline("vid_outline_1", db);
    assert.equal(outline.status, "derived");
    assert.equal(outline.source, "production_outline_generator");
    assert.ok(outline.note.includes("KHÔNG phải transcript"));
    assert.ok(Array.isArray(outline.sections));
  } finally {
    db.close();
  }
});

test("10. Thumbnail & title audit never awards visual bonus points just because thumbnailUrl is non-empty", async () => {
  const auditWithoutUrl = await auditThumbnailAndTitle({
    title: "Why 99% of Channels Fail in 2026",
    thumbnailUrl: "",
    niche: "Documentary"
  });
  const auditWithUrl = await auditThumbnailAndTitle({
    title: "Why 99% of Channels Fail in 2026",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    niche: "Documentary"
  });

  assert.equal(auditWithUrl.imageAnalysisStatus, "not_analyzed");
  assert.equal(auditWithUrl.scoreStatus, "heuristic_title_only");
  assert.equal(
    auditWithUrl.ctrScore,
    auditWithoutUrl.ctrScore,
    "Passing an unanalyzed image URL must not inflate ctrScore"
  );
});

test("11, 12, 13 & T01. Strict Auth by default (401 unauthenticated), 404 JSON on unknown API routes, 400 on malformed JSON, and secret preservation", async () => {
  const db = createIsolatedTestDb("http-server");
  updateSecrets({
    youtubeApiKeyAction: "replace",
    youtubeApiKey: "AIzaSyTestPreservedKey999999"
  });

  const server = createNexlevServer({ db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // T01: Unauthenticated requests to protected endpoints return 401 AUTH_REQUIRED
    const unauthChannels = await fetch(`${baseUrl}/api/v1/channels`);
    assert.equal(unauthChannels.status, 401);
    const unauthBody = await unauthChannels.json();
    assert.equal(unauthBody.code, "AUTH_REQUIRED");

    const unauthBootstrap = await fetch(`${baseUrl}/api/v1/auth/bootstrap`);
    assert.equal(unauthBootstrap.status, 401);

    // Login as manager to obtain sessionToken
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "nexlev-admin-2026" })
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.ok(loginData.sessionToken);
    assert.equal(loginData.user.apiToken, undefined, "Raw apiToken must never be leaked in login user payload");

    const authHeaders = {
      Authorization: `Bearer ${loginData.sessionToken}`,
      "Content-Type": "application/json"
    };

    // T01: /api/v1/users never returns raw apiToken
    const usersRes = await fetch(`${baseUrl}/api/v1/users`, { headers: authHeaders });
    assert.equal(usersRes.status, 200);
    const usersData = await usersRes.json();
    for (const u of usersData.users) {
      assert.equal(u.apiToken, undefined, "Team user list must never expose raw apiToken");
      assert.ok(u.apiTokenPreview);
    }

    // 11. Unknown /api/* route returns 404 JSON (never HTML 200)
    const res404 = await fetch(`${baseUrl}/api/v1/non-existent-endpoint`, { headers: authHeaders });
    assert.equal(res404.status, 404);
    assert.ok((res404.headers.get("content-type") || "").includes("application/json"));
    const body404 = await res404.json();
    assert.equal(body404.code, "API_NOT_FOUND");

    // 12. Malformed JSON returns 400 JSON
    const res400 = await fetch(`${baseUrl}/api/v1/swipe`, {
      method: "POST",
      headers: authHeaders,
      body: '{"brokenJson": '
    });
    assert.equal(res400.status, 400);
    const body400 = await res400.json();
    assert.equal(body400.code, "INVALID_JSON");

    // 13. Submitting empty string in settings does NOT wipe existing YouTube API Key
    const resSettings = await fetch(`${baseUrl}/api/v1/settings`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        youtubeApiKey: "",
        includeDemo: false,
        minOutlierSampleSize: 3
      })
    });
    assert.equal(resSettings.status, 200);
    assert.equal(loadSecrets().youtubeApiKey, "AIzaSyTestPreservedKey999999");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("14. MCP Server negotiates protocolVersion and rejects analyze_youtube_channel with empty arguments", async () => {
  const db = createIsolatedTestDb("mcp-server");
  try {
    upsertChannelAndVideos(db, {
      channelId: "UC_FIRST_CHANNEL",
      title: "First Channel",
      dataOrigin: "observed",
      videos: []
    });

    const initResp = await handleRpcMessage(
      {
        jsonrpc: "2.0",
        mId: 1,
        method: "initialize",
        params: { protocolVersion: "2099-01-01" }
      },
      db
    );
    assert.equal(initResp.protocolVersion, "2024-11-05");

    const callResp = await handleRpcMessage(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "analyze_youtube_channel",
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

test("15, 16, T01, T02 & T08. Server-enforced RBAC, Workflow Transitions, Session Revocation on Password Change, Optimistic Concurrency (409), and Brief Revisions", () => {
  const db = createIsolatedTestDb("team-workflow");
  try {
    const managerAuth = authenticateUser(db, "admin", "nexlev-admin-2026");
    const memberAuth = authenticateUser(db, "member1", "nexlev-member-2026");
    assert.equal(managerAuth.user.role, "manager");
    assert.equal(memberAuth.user.role, "member");

    upsertChannelAndVideos(db, {
      channelId: "UC_WORKFLOW_CH",
      title: "Workflow Science Channel",
      dataOrigin: "observed",
      videos: [
        { videoId: "vid_wf_1", title: "Baseline Video 1", views: 10_000, durationMinutes: 10, contentType: "long" },
        { videoId: "vid_wf_2", title: "Baseline Video 2", views: 12_000, durationMinutes: 11, contentType: "long" },
        { videoId: "vid_wf_3", title: "Viral Outlier Video 3", views: 180_000, durationMinutes: 12, contentType: "long" }
      ]
    });

    // T02: Creating an item always starts at 'discovered' even if caller passes 'approved'
    const saved = createSwipeItem(
      {
        videoId: "vid_wf_3",
        channelId: "UC_WORKFLOW_CH",
        title: "Viral Outlier Video 3",
        channelTitle: "Workflow Science Channel",
        canonicalUrl: "https://www.youtube.com/watch?v=vid_wf_3",
        thumbnailUrl: "https://i.ytimg.com/vi/vid_wf_3/hqdefault.jpg",
        notes: "High retention hook on science paradox",
        workflowStage: "approved"
      },
      db,
      memberAuth.user
    );
    assert.equal(saved.workflowStage, "discovered");
    assert.equal(saved.revision, 1);

    // T02: Member attempting to approve (discovered -> approved) must be rejected with 403
    assert.throws(
      () => transitionSwipeItem(saved.id, { toStage: "approved" }, db, memberAuth.user),
      (err) => err.statusCode === 403 && err.code === "FORBIDDEN_STAGE_TRANSITION"
    );

    // T02: Member attempting to assign ownerLabel/deadline must be rejected with 403
    assert.throws(
      () => updateSwipeItem(saved.id, { ownerLabel: "Self Assign", deadline: "2026-11-01" }, db, memberAuth.user),
      (err) => err.statusCode === 403 && err.code === "FORBIDDEN_FIELD_ASSIGNMENT"
    );

    // Manager approves (discovered -> approved)
    const approvedItem = transitionSwipeItem(saved.id, { toStage: "approved" }, db, managerAuth.user);
    assert.equal(approvedItem.workflowStage, "approved");
    assert.equal(approvedItem.revision, 2);

    // Member transitions approved -> briefing
    const briefingItem = transitionSwipeItem(saved.id, { toStage: "briefing" }, db, memberAuth.user);
    assert.equal(briefingItem.workflowStage, "briefing");

    // Generate template brief (tagged as template_draft)
    const withTemplate = generateSwipeProductionBrief(saved.id, db, { actor: memberAuth.user });
    assert.equal(withTemplate.briefStatus, "template_draft");
    assert.equal(withTemplate.briefRevisions.length, 1);

    // Member edits the brief manually -> briefStatus becomes 'user_edited'
    const manualEdited = updateSwipeItem(
      saved.id,
      { briefMarkdown: "# Custom Team Script\nManual hook & outline" },
      db,
      memberAuth.user
    );
    assert.equal(manualEdited.briefStatus, "user_edited");

    // T08: Calling generateSwipeProductionBrief without overwrite: true preserves manual edits!
    const preserved = generateSwipeProductionBrief(saved.id, db, { overwrite: false, actor: memberAuth.user });
    assert.equal(preserved.briefMarkdown, "# Custom Team Script\nManual hook & outline");
    assert.equal(preserved.briefRevisions.length, 3);

    // T08: Optimistic concurrency check — stale expectedRevision throws 409 REVISION_CONFLICT
    assert.throws(
      () =>
        updateSwipeItem(
          saved.id,
          { notes: "Stale edit", expectedRevision: 1 },
          db,
          managerAuth.user
        ),
      (err) => err.statusCode === 409 && err.code === "REVISION_CONFLICT" && Boolean(err.serverItem)
    );

    // Manager assigns item (briefing -> assigned)
    const assigned = transitionSwipeItem(
      saved.id,
      { toStage: "assigned", ownerLabel: "Nhân viên Research 01", deadline: "2026-10-25" },
      db,
      managerAuth.user
    );
    assert.equal(assigned.workflowStage, "assigned");
    assert.equal(assigned.ownerLabel, "Nhân viên Research 01");

    // T02: Transitioning to 'published' without resultUrl fails with 400 MISSING_RESULT_URL
    assert.throws(
      () => transitionSwipeItem(saved.id, { toStage: "published" }, db, memberAuth.user),
      (err) => err.statusCode === 400 && err.code === "MISSING_RESULT_URL"
    );

    // Transitioning to 'published' with valid HTTP/HTTPS resultUrl succeeds
    const published = transitionSwipeItem(
      saved.id,
      { toStage: "published", resultUrl: "https://www.youtube.com/watch?v=our_published_vid" },
      db,
      memberAuth.user
    );
    assert.equal(published.workflowStage, "published");
    assert.ok(published.activityLog.length >= 4, "Audit activity log must record workflow transitions");

    // T01: Changing member1's password revokes all existing sessions for member1
    assert.ok(resolveUserFromToken(db, memberAuth.sessionToken));
    updateTeamUser(db, memberAuth.user.id, { password: "new-password-2026" });
    assert.equal(
      resolveUserFromToken(db, memberAuth.sessionToken),
      null,
      "Old session token must be immediately invalidated after password change"
    );
  } finally {
    db.close();
  }
});

test("17, T03 & T04. Demo isolation, legacy_unverified exclusion from outlier baselines, and strict Shorts/Long classification", async () => {
  const { queryChannels, getBatchExtensionMetrics } = await import("../src/core/engine.mjs");
  const db = createIsolatedTestDb("demo-and-extension");
  try {
    // T04: Bare durationSeconds <= 180 without explicit Shorts flag/URL/orientation returns 'unknown'
    assert.equal(classifyVideoContentType({ durationSeconds: 95 }), "unknown");
    assert.equal(classifyVideoContentType({ durationSeconds: 95, isShorts: true }), "shorts");
    assert.equal(classifyVideoContentType({ durationSeconds: 240 }), "long");

    // T03: Legacy unverified channel must NEVER produce 'derived' outlier ratios
    upsertChannelAndVideos(db, {
      channelId: "UC_LEGACY_CH",
      title: "Legacy Unverified Channel",
      dataOrigin: "legacy_unverified",
      videos: [
        { videoId: "v_leg_1", title: "Legacy 1", views: 10_000, durationMinutes: 10, contentType: "long", dataOrigin: "legacy_unverified" },
        { videoId: "v_leg_2", title: "Legacy 2", views: 12_000, durationMinutes: 10, contentType: "long", dataOrigin: "legacy_unverified" },
        { videoId: "v_leg_3", title: "Legacy 3", views: 120_000, durationMinutes: 10, contentType: "long", dataOrigin: "legacy_unverified" }
      ]
    });
    const legDetail = getChannelDetail("UC_LEGACY_CH", db);
    assert.equal(legDetail.channel.outlierStatus, "unverified_source");
    assert.equal(legDetail.channel.topOutlierRatio, null);

    upsertChannelAndVideos(db, {
      channelId: "UC_DEMO_FIXTURE",
      title: "Demo Fixture Channel",
      dataOrigin: "demo",
      observedSubscribers: 20_000,
      videos: [
        { videoId: "v_demo_1", title: "Demo 1", views: 50_000, durationMinutes: 10 },
        { videoId: "v_demo_2", title: "Demo 2", views: 60_000, durationMinutes: 10 },
        { videoId: "v_demo_3", title: "Demo 3", views: 300_000, durationMinutes: 10 }
      ]
    });

    upsertChannelAndVideos(db, {
      channelId: "UC_OBS_UNKNOWN_SUBS",
      title: "Observed Unknown Subs Channel",
      dataOrigin: "observed",
      observedSubscribers: null,
      videos: [{ videoId: "v_u_1", title: "Only 1 Video", views: 80_000, durationMinutes: 10 }]
    });

    upsertChannelAndVideos(db, {
      channelId: "UC_OBS_KNOWN_SUBS",
      title: "Observed Known Subs Channel",
      dataOrigin: "observed",
      observedSubscribers: 15_000,
      videos: [
        { videoId: "v_k_1", title: "Video 1", views: 10_000, durationMinutes: 10 },
        { videoId: "v_k_2", title: "Video 2", views: 14_000, durationMinutes: 10 },
        { videoId: "v_k_3", title: "Video 3 Outlier", views: 140_000, durationMinutes: 10 }
      ]
    });

    const defaultList = queryChannels({ includeDemo: "false", dataOrigin: "observed" }, db);
    assert.ok(!defaultList.channels.some((c) => c.id === "UC_DEMO_FIXTURE"));
    assert.ok(!defaultList.channels.some((c) => c.id === "UC_LEGACY_CH"));
    assert.equal(defaultList.channels.length, 2);

    const extMetrics = getBatchExtensionMetrics(
      {
        videoIds: ["v_u_1", "v_k_3", "v_leg_3"],
        channelIds: ["UC_OBS_UNKNOWN_SUBS", "UC_OBS_KNOWN_SUBS", "UC_LEGACY_CH"]
      },
      db
    );
    assert.equal(extMetrics.videos["v_u_1"].outlierStatus, "insufficient_data");
    assert.equal(extMetrics.videos["v_k_3"].outlierStatus, "derived");
    assert.equal(extMetrics.videos["v_k_3"].outlierRatio, 10);
    assert.equal(extMetrics.videos["v_leg_3"].outlierStatus, "unverified_source");
    assert.equal(extMetrics.videos["v_leg_3"].outlierRatio, null);
  } finally {
    db.close();
  }
});

test("18. T05, T07, T09, T10 & T11: Cohort Growth Tracking, Sample Size Recompute, URL Allowlist Import Queue, and Lease Lock Recovery", () => {
  const db = createIsolatedTestDb("v21-probes");
  try {
    // T05: Channel with null video views must NOT write a fake 0-view snapshot
    upsertChannelAndVideos(db, {
      channelId: "UC_NULL_VIEWS",
      title: "Null Views Channel",
      dataOrigin: "observed",
      videos: [{ videoId: "v_null_1", title: "Hidden Views", views: null, durationMinutes: 10 }]
    });
    const nullSnaps = db
      .prepare("SELECT * FROM metric_snapshots WHERE channel_id = 'UC_NULL_VIEWS'")
      .all();
    assert.equal(nullSnaps.length, 0, "Must not insert a 0-view snapshot when views are unknown");

    // T05: Cohort intersection growth across 2 snapshots at different timestamps
    upsertChannelAndVideos(db, {
      channelId: "UC_COHORT",
      title: "Cohort Channel",
      dataOrigin: "observed",
      videos: [
        { videoId: "vc_1", title: "Cohort 1", views: 10_000, durationMinutes: 10 },
        { videoId: "vc_2", title: "Cohort 2", views: 20_000, durationMinutes: 10 },
        { videoId: "vc_3", title: "Cohort 3", views: 30_000, durationMinutes: 10 }
      ]
    });
    // Backdate the first batch of snapshots by 2 days
    const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    db.prepare("UPDATE metric_snapshots SET collected_at = ? WHERE channel_id = 'UC_COHORT'").run(twoDaysAgo);

    // Second observation with higher views on the same 3 videos
    upsertChannelAndVideos(db, {
      channelId: "UC_COHORT",
      title: "Cohort Channel",
      dataOrigin: "observed",
      videos: [
        { videoId: "vc_1", title: "Cohort 1", views: 15_000, durationMinutes: 10 },
        { videoId: "vc_2", title: "Cohort 2", views: 25_000, durationMinutes: 10 },
        { videoId: "vc_3", title: "Cohort 3", views: 35_000, durationMinutes: 10 }
      ]
    });
    const growth = getChannelGrowthTracking("UC_COHORT", db);
    assert.equal(growth.comparable, true);
    assert.equal(growth.basis, "video_cohort_intersection");
    assert.equal(growth.commonVideoCount, 3);
    assert.equal(growth.viewsDelta, 15_000);

    // T07: Increasing minOutlierSampleSize to 5 recomputes stored channels so a 3-video channel becomes insufficient_data
    saveSettingsAndSecrets({ minOutlierSampleSize: 5 }, db);
    const afterRecompute = getChannelDetail("UC_COHORT", db);
    assert.equal(afterRecompute.channel.outlierStatus, "insufficient_data");
    assert.equal(afterRecompute.channel.topOutlierRatio, null);

    // T10: Bulk import rejects lookalike domains (notyoutube.com) and queues valid unresolved targets without fabricating UC_IMPORT_...
    const impRes = bulkImportTargets(
      [
        "https://notyoutube.com/@spoof",
        "https://www.youtube.com/@unseen_creator_xyz",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      ],
      db
    );
    assert.equal(impRes.rejectedCount, 1);
    assert.equal(impRes.queuedCount, 2);
    const fakeChannels = db
      .prepare("SELECT * FROM channels WHERE id LIKE 'UC_IMPORT_%'")
      .all();
    assert.equal(fakeChannels.length, 0, "Must never fabricate UC_IMPORT_... channels");
    const queuedTargets = getImportTargets(db);
    assert.equal(queuedTargets.length, 2);

    // T11: recoverInterruptedCrawlJobs only marks expired leases failed and leaves active leases running
    const futureLease = new Date(Date.now() + 300_000).toISOString();
    const pastLease = new Date(Date.now() - 300_000).toISOString();
    db.prepare(`
      INSERT INTO crawl_jobs (job_id, job_type, status, started_at, created_at, worker_id, lease_until)
      VALUES
        ('job_active_lease', 'batch', 'running', ?, ?, 'worker_1', ?),
        ('job_expired_lease', 'batch', 'running', ?, ?, 'worker_2', ?)
    `).run(pastLease, pastLease, futureLease, pastLease, pastLease, pastLease);

    const recoveredCount = recoverInterruptedCrawlJobs(db);
    assert.equal(recoveredCount, 1);
    const activeJob = db.prepare("SELECT status FROM crawl_jobs WHERE job_id = 'job_active_lease'").get();
    const expiredJob = db.prepare("SELECT status FROM crawl_jobs WHERE job_id = 'job_expired_lease'").get();
    assert.equal(activeJob.status, "running");
    assert.equal(expiredJob.status, "failed");
  } finally {
    db.close();
  }
});
