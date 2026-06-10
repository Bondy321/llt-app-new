const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkTextForObjectionableContent,
  assertTextPassesModeration,
  createContentReport,
} = require('../services/contentModerationService');

const createMockDb = () => {
  const writes = [];
  return {
    writes,
    ref(path) {
      return {
        path,
        push() {
          return {
            key: 'report-1',
            set: async (value) => {
              writes.push({ path: `${path}/report-1`, value });
            },
          };
        },
        set: async (value) => {
          writes.push({ path, value });
        },
      };
    },
  };
};

test('checkTextForObjectionableContent allows ordinary tour copy', () => {
  const result = checkTextForObjectionableContent('Meet at the coach after lunch.');
  assert.equal(result.allowed, true);
});

test('assertTextPassesModeration rejects offensive wording', () => {
  assert.throws(
    () => assertTextPassesModeration('This is shit', 'Message'),
    /Message contains wording/,
  );
});

test('createContentReport writes bounded report payload', async () => {
  const db = createMockDb();
  const result = await createContentReport({
    tourId: 'TOUR_1',
    contentType: 'chat_message',
    contentId: 'MSG_1',
    chatScope: 'group',
    reason: 'harassment',
    reporterId: 'pax-1',
    reporterAuthUid: 'auth-1',
    reporterName: 'A passenger',
    contentOwnerId: 'pax-2',
    contentOwnerName: 'Another passenger',
    contentPreview: 'A reported message',
    sourcePath: 'chats/TOUR_1/messages/MSG_1',
  }, {
    dbInstance: db,
    nowFn: () => 1710000000000,
  });

  assert.equal(result.success, true);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, 'content_reports/report-1');
  assert.deepEqual(db.writes[0].value, {
    schemaVersion: 1,
    reportId: 'report-1',
    tourId: 'TOUR_1',
    contentType: 'chat_message',
    contentId: 'MSG_1',
    reason: 'harassment',
    status: 'open',
    reporterId: 'pax-1',
    reporterAuthUid: 'auth-1',
    reporterName: 'A passenger',
    contentOwnerId: 'pax-2',
    contentOwnerName: 'Another passenger',
    contentPreview: 'A reported message',
    sourcePath: 'chats/TOUR_1/messages/MSG_1',
    details: '',
    createdAt: '2024-03-09T16:00:00.000Z',
    createdAtMs: 1710000000000,
    updatedAt: '2024-03-09T16:00:00.000Z',
    updatedAtMs: 1710000000000,
    chatScope: 'group',
  });
});

test('createContentReport rejects unsupported content types', async () => {
  const result = await createContentReport({
    tourId: 'TOUR_1',
    contentType: 'unknown',
    contentId: 'MSG_1',
    reason: 'other',
    reporterId: 'pax-1',
    reporterAuthUid: 'auth-1',
  }, {
    dbInstance: createMockDb(),
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported content report type/);
});
