const test = require('node:test');
const assert = require('node:assert');
const {
  sendMessage,
  sendInternalDriverMessage,
  markChatAsRead,
  markInternalChatAsRead,
  toggleReaction,
  addReaction,
  removeReaction,
  subscribeToChatMessages,
  subscribeToInternalDriverChat,
  getChatMessagesPage,
} = require('../services/chatService');

const createMockRealtimeDb = (initialData = {}) => {
  const refCalls = [];
  const data = JSON.parse(JSON.stringify(initialData));
  const listeners = new Map();

  const normalizePath = (path = '') => path.split('/').filter(Boolean);
  const getValue = (path) => normalizePath(path).reduce((acc, part) => (acc == null ? undefined : acc[part]), data);
  const cloneValue = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  const parseTime = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };
  const applyQuery = (value, queryState = {}) => {
    if (!value || typeof value !== 'object' || !queryState.orderByChild) {
      return value;
    }

    let entries = Object.entries(value).sort((a, b) => {
      const aValue = a[1]?.[queryState.orderByChild];
      const bValue = b[1]?.[queryState.orderByChild];
      const timeDelta = parseTime(aValue) - parseTime(bValue);
      if (timeDelta !== 0) return timeDelta;
      return a[0].localeCompare(b[0]);
    });

    if (queryState.endAt !== undefined) {
      const endMs = parseTime(queryState.endAt);
      entries = entries.filter(([, childValue]) => parseTime(childValue?.[queryState.orderByChild]) <= endMs);
    }

    if (queryState.limitToLast !== undefined) {
      entries = entries.slice(-queryState.limitToLast);
    }

    return entries.reduce((accumulator, [key, childValue]) => {
      accumulator[key] = childValue;
      return accumulator;
    }, {});
  };
  const setValue = (path, value) => {
    const parts = normalizePath(path);
    if (parts.length === 0) {
      throw new Error('Root writes are not supported in test mock');
    }

    let cursor = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }

    const lastKey = parts[parts.length - 1];
    if (value === null) {
      delete cursor[lastKey];
    } else {
      cursor[lastKey] = cloneValue(value);
    }
  };

  const buildSnapshot = (path, queryState = {}) => {
    const value = applyQuery(getValue(path), queryState);
    return {
      key: normalizePath(path).slice(-1)[0] || null,
      val: () => cloneValue(value),
      exists: () => value !== undefined && value !== null,
      forEach: (callback) => {
        if (!value || typeof value !== 'object') return false;
        Object.entries(value).forEach(([childKey, childValue]) => {
          callback({
            key: childKey,
            val: () => cloneValue(childValue),
            exists: () => childValue !== undefined && childValue !== null,
          });
        });
        return false;
      },
    };
  };

  const notifyValueListeners = (path) => {
    const parts = normalizePath(path);
    for (let i = parts.length; i >= 1; i -= 1) {
      const candidate = parts.slice(0, i).join('/');
      const callbacks = listeners.get(candidate) || [];
      callbacks.forEach((callback) => callback(buildSnapshot(candidate)));
    }
  };

  return {
    refCalls,
    data,
    ref(path) {
      const context = { path, setCalls: [], removeCalls: 0, updateCalls: [], pushCalls: [] };

      context.set = async (value) => {
        context.setCalls.push(cloneValue(value));
        setValue(path, value);
        notifyValueListeners(path);
        return value;
      };

      context.update = async (patch) => {
        context.updateCalls.push(cloneValue(patch));
        const current = getValue(path);
        setValue(path, { ...(current && typeof current === 'object' ? current : {}), ...patch });
        notifyValueListeners(path);
        return patch;
      };

      context.remove = async () => {
        context.removeCalls += 1;
        setValue(path, null);
        notifyValueListeners(path);
      };

      context.once = async () => buildSnapshot(path, context.queryState);

      context.transaction = async (updater) => {
        const current = cloneValue(getValue(path));
        const next = updater(current);
        if (next === undefined) {
          return { committed: false, snapshot: buildSnapshot(path) };
        }
        setValue(path, next === null ? null : next);
        notifyValueListeners(path);
        return { committed: true, snapshot: buildSnapshot(path) };
      };

      context.queryState = {};

      context.on = (eventType, callback) => {
        assert.equal(eventType, 'value');
        const callbacks = listeners.get(path) || [];
        callbacks.push(callback);
        listeners.set(path, callbacks);
        callback(buildSnapshot(path, context.queryState));
        return callback;
      };

      context.off = (eventType, callback) => {
        assert.equal(eventType, 'value');
        const callbacks = listeners.get(path) || [];
        listeners.set(path, callbacks.filter((candidate) => candidate !== callback));
      };

      context.orderByChild = (child) => {
        context.queryState.orderByChild = child;
        return context;
      };
      context.endAt = (value) => {
        context.queryState.endAt = value;
        return context;
      };
      context.limitToLast = (limit) => {
        context.queryState.limitToLast = limit;
        return context;
      };

      context.push = () => {
        const key = `msg-${context.pushCalls.length + 1}`;
        const refObject = {
          key,
          async set(value) {
            context.setCalls.push(cloneValue(value));
            setValue(`${path}/${key}`, value);
            notifyValueListeners(`${path}/${key}`);
            return value;
          },
        };

        context.pushCalls.push(refObject);
        return refObject;
      };

      refCalls.push(context);
      return context;
    },
  };
};

const assertNoReactionParentWrites = (refCalls, tourId, messageId, emoji) => {
  const forbiddenPaths = new Set([
    `chats/${tourId}/messages/${messageId}`,
    `chats/${tourId}/messages/${messageId}/reactions`,
    `chats/${tourId}/messages/${messageId}/reactions/${emoji}`,
  ]);

  refCalls.forEach((refCall) => {
    const performedWrite = refCall.setCalls.length > 0
      || refCall.removeCalls > 0
      || refCall.updateCalls.length > 0;
    if (!performedWrite) {
      return;
    }

    assert.equal(
      forbiddenPaths.has(refCall.path),
      false,
      `Forbidden parent write used: ${refCall.path}`
    );
  });
};

test('sendMessage builds payload with sender info and driver flag', async () => {
  const mockDb = createMockRealtimeDb();
  const senderInfo = { name: 'Alex', userId: 'driver:alex', principalType: 'driver', isDriver: true };

  const result = await sendMessage('tour-123', ' Hello ', senderInfo, mockDb);

  assert.equal(result.success, true);
  assert.ok(result.message.id);
  assert.equal(result.message.text, 'Hello');
  assert.equal(result.message.senderName, 'Alex');
  assert.equal(result.message.senderId, 'driver:alex');
  assert.equal(result.message.senderStableId, 'driver:alex');
  assert.equal(result.message.isDriver, true);
  assert.ok(new Date(result.message.timestamp).getTime());

  const refCall = mockDb.refCalls[0];
  assert.ok(refCall);
  assert.equal(refCall.setCalls[0].text, 'Hello');
  assert.equal(refCall.setCalls[0].senderName, 'Alex');
  assert.equal(refCall.setCalls[0].senderId, 'driver:alex');
  assert.equal(refCall.setCalls[0].senderStableId, 'driver:alex');
  assert.equal(refCall.setCalls[0].timestamp, result.message.timestamp);
  assert.equal(refCall.setCalls[0].isDriver, true);
});

test('sendMessage rejects empty content', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await sendMessage('tour-abc', '   ', { name: 'Tester' }, mockDb);

  assert.equal(result.success, false);
  assert.ok(mockDb.refCalls.length === 0);
});

test('sendMessage persists sanitized reply context metadata', async () => {
  const mockDb = createMockRealtimeDb();
  const senderInfo = {
    name: 'Jamie',
    userId: 'passenger-9',
    principalType: 'passenger',
    stablePassengerId: 'passenger-9',
    isDriver: false,
  };

  const result = await sendMessage('tour-reply', 'Following up', senderInfo, mockDb, {
    replyTo: {
      messageId: 'msg-42',
      idempotencyKey: 'offline-msg-42',
      senderName: 'Driver Bondy',
      previewText: '  Please be at the pickup point by 08:15 AM.  ',
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.message.replyTo.messageId, 'msg-42');
  assert.equal(result.message.replyTo.idempotencyKey, 'offline-msg-42');
  assert.equal(result.message.replyTo.senderName, 'Driver Bondy');
  assert.equal(result.message.replyTo.previewText, 'Please be at the pickup point by 08:15 AM.');

  const refCall = mockDb.refCalls[0];
  assert.ok(refCall);
  assert.deepEqual(refCall.setCalls[0].replyTo, {
    messageId: 'msg-42',
    idempotencyKey: 'offline-msg-42',
    senderName: 'Driver Bondy',
    previewText: 'Please be at the pickup point by 08:15 AM.',
  });
});

test('sendMessage rejects passenger writes without stable sender identity once principal is known', async () => {
  const mockDb = createMockRealtimeDb();
  const senderInfo = {
    name: 'Morgan',
    userId: 'uid-missing-stable-1',
    principalType: 'passenger',
    isDriver: false,
  };

  const result = await sendMessage('tour-missing-stable', 'Hello', senderInfo, mockDb);

  assert.equal(result.success, false);
  assert.match(result.error, /senderStableId is required/i);
  assert.equal(mockDb.refCalls.length, 0);
});

test('sendInternalDriverMessage writes senderStableId for driver principals when explicit stable id is not provided', async () => {
  const mockDb = createMockRealtimeDb();
  const senderInfo = {
    name: 'Driver Bondy',
    principalId: 'driver:BONDY',
    principalType: 'driver',
    isDriver: true,
  };

  const result = await sendInternalDriverMessage('tour-internal', 'Ops check-in', senderInfo, mockDb, {
    messageId: 'int-driver-1',
  });

  assert.equal(result.success, true);
  const writeRef = mockDb.refCalls.find((refCall) => refCall.path === 'internal_chats/tour-internal/messages/int-driver-1');
  assert.ok(writeRef);
  assert.equal(writeRef.setCalls.length, 1);
  assert.equal(writeRef.setCalls[0].senderType, 'driver');
  assert.equal(writeRef.setCalls[0].senderStableId, 'driver:BONDY');
});


test('markChatAsRead writes timestamp to chat lastRead path', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await markChatAsRead('tour-77', 'user-22', mockDb);

  assert.equal(result.success, true);
  const refCall = mockDb.refCalls[0];
  assert.equal(refCall.path, 'chats/tour-77/lastRead/user-22');
  assert.ok(new Date(refCall.setCalls[0]).getTime());
});

test('markInternalChatAsRead writes timestamp to internal chat lastRead path', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await markInternalChatAsRead('tour-88', 'driver-3', mockDb);

  assert.equal(result.success, true);
  const refCall = mockDb.refCalls[0];
  assert.equal(refCall.path, 'internal_chats/tour-88/lastRead/driver-3');
  assert.ok(new Date(refCall.setCalls[0]).getTime());
});

test('toggleReaction toggles exclusively from canonical user leaf and never writes message parent', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-1': {
        messages: {
          'msg-1': {
            text: 'Hello',
            reactions: {
              '👍': { 'user-1': true },
            },
          },
        },
      },
    },
  });

  const addResult = await toggleReaction('tour-1', 'msg-1', '👍', 'user-2', mockDb);
  assert.equal(addResult.success, true);
  assert.equal(addResult.action, 'added');
  assert.ok(
    mockDb.refCalls.some(
      (refCall) =>
        refCall.path === 'chats/tour-1/messages/msg-1/reactions/👍/user-2'
        && refCall.setCalls.includes(true)
    )
  );
  assert.ok(addResult.users.includes('user-1'));
  assert.ok(addResult.users.includes('user-2'));
  assert.deepEqual(addResult.reactions, { '👍': ['user-1', 'user-2'] });

  const removeResult = await toggleReaction('tour-1', 'msg-1', '👍', 'user-1', mockDb);
  assert.equal(removeResult.success, true);
  assert.equal(removeResult.action, 'removed');
  assert.ok(
    mockDb.refCalls.some(
      (refCall) =>
        refCall.path === 'chats/tour-1/messages/msg-1/reactions/👍/user-1'
        && refCall.removeCalls === 1
    )
  );
  assert.ok(
    mockDb.refCalls.every(
      (refCall) => refCall.path !== 'chats/tour-1/messages/msg-1'
    )
  );
});

test('toggleReaction forceAction add keeps an existing reaction applied', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-force': {
        messages: {
          'msg-heart': {
            text: 'Hello',
            reactions: {
              heart: {
                'user-1': true,
              },
            },
          },
        },
      },
    },
  });

  const result = await toggleReaction(
    'tour-force',
    'msg-heart',
    'heart',
    'user-1',
    mockDb,
    { forceAction: 'add' }
  );

  assert.equal(result.success, true);
  assert.equal(result.action, 'added');
  assert.equal(
    mockDb.data.chats['tour-force'].messages['msg-heart'].reactions.heart['user-1'],
    true
  );
  assert.ok(
    mockDb.refCalls.some(
      (refCall) =>
        refCall.path === 'chats/tour-force/messages/msg-heart/reactions/heart/user-1'
        && refCall.setCalls.includes(true)
    )
  );
  assert.ok(
    mockDb.refCalls.every(
      (refCall) =>
        refCall.path !== 'chats/tour-force/messages/msg-heart/reactions/heart/user-1'
        || refCall.removeCalls === 0
    )
  );
});

test('addReaction and removeReaction are idempotent against map-backed reactions', async () => {
  const mockDb = createMockRealtimeDb();

  const firstAdd = await addReaction('tour-2', 'msg-9', '🎉', 'driver-1', mockDb);
  const secondAdd = await addReaction('tour-2', 'msg-9', '🎉', 'driver-1', mockDb);
  assert.equal(firstAdd.success, true);
  assert.equal(secondAdd.success, true);
  const addLeafWrites = mockDb.refCalls.filter(
    (refCall) => refCall.path === 'chats/tour-2/messages/msg-9/reactions/🎉/driver-1'
  );
  assert.equal(addLeafWrites.length, 2);
  assert.deepEqual(addLeafWrites.map((refCall) => refCall.setCalls), [[true], [true]]);
  assert.ok(
    mockDb.refCalls.every(
      (refCall) => refCall.path !== 'chats/tour-2/messages/msg-9/reactions/🎉'
        && refCall.path !== 'chats/tour-2/messages/msg-9/reactions'
        && refCall.path !== 'chats/tour-2/messages/msg-9'
    )
  );
  assert.deepEqual(mockDb.data.chats['tour-2'].messages['msg-9'].reactions['🎉'], {
    'driver-1': true,
  });

  const firstRemove = await removeReaction('tour-2', 'msg-9', '🎉', 'driver-1', mockDb);
  const secondRemove = await removeReaction('tour-2', 'msg-9', '🎉', 'driver-1', mockDb);
  assert.equal(firstRemove.success, true);
  assert.equal(secondRemove.success, true);
  const removeLeafWrites = mockDb.refCalls.filter(
    (refCall) => refCall.path === 'chats/tour-2/messages/msg-9/reactions/🎉/driver-1'
  );
  assert.equal(removeLeafWrites.length, 4);
  assert.equal(removeLeafWrites[2].removeCalls, 1);
  assert.equal(removeLeafWrites[3].removeCalls, 1);
  assert.ok(
    mockDb.refCalls.every(
      (refCall) => refCall.path !== 'chats/tour-2/messages/msg-9/reactions/🎉'
        && refCall.path !== 'chats/tour-2/messages/msg-9/reactions'
        && refCall.path !== 'chats/tour-2/messages/msg-9'
    )
  );
  assert.ok(
    mockDb.data.chats['tour-2'].messages['msg-9'].reactions?.['🎉'] === undefined
      || Object.keys(mockDb.data.chats['tour-2'].messages['msg-9'].reactions?.['🎉'] || {}).length === 0
  );
});

test('addReaction sets exact reaction leaf ref to true', async () => {
  const mockDb = createMockRealtimeDb();

  const result = await addReaction('tour-10', 'msg-1', '🔥', 'user-7', mockDb);

  assert.equal(result.success, true);
  assert.equal(mockDb.refCalls.length, 1);
  assert.equal(mockDb.refCalls[0].path, 'chats/tour-10/messages/msg-1/reactions/🔥/user-7');
  assert.deepEqual(mockDb.refCalls[0].setCalls, [true]);
});

test('removeReaction removes exact reaction leaf ref', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-10': {
        messages: {
          'msg-1': {
            reactions: {
              '🔥': {
                'user-7': true,
              },
            },
          },
        },
      },
    },
  });

  const result = await removeReaction('tour-10', 'msg-1', '🔥', 'user-7', mockDb);

  assert.equal(result.success, true);
  assert.equal(mockDb.refCalls.length, 1);
  assert.equal(mockDb.refCalls[0].path, 'chats/tour-10/messages/msg-1/reactions/🔥/user-7');
  assert.equal(mockDb.refCalls[0].removeCalls, 1);
  assert.equal(
    mockDb.data.chats['tour-10'].messages['msg-1'].reactions?.['🔥']?.['user-7'],
    undefined
  );
});

test('reaction methods never write to reaction parent or message parent paths', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-guard': {
        messages: {
          'msg-guard': {
            reactions: {
              '👍': {
                'user-a': true,
              },
            },
          },
        },
      },
    },
  });

  await addReaction('tour-guard', 'msg-guard', '👍', 'user-b', mockDb);
  await removeReaction('tour-guard', 'msg-guard', '👍', 'user-a', mockDb);
  await toggleReaction('tour-guard', 'msg-guard', '👍', 'user-c', mockDb);
  await toggleReaction('tour-guard', 'msg-guard', '👍', 'user-c', mockDb);

  const leafPath = 'chats/tour-guard/messages/msg-guard/reactions/👍';
  const allWritePaths = mockDb.refCalls
    .filter((refCall) => refCall.setCalls.length > 0 || refCall.removeCalls > 0 || refCall.updateCalls.length > 0)
    .map((refCall) => refCall.path);

  assert.ok(allWritePaths.every((path) => path.startsWith(`${leafPath}/`)));
  assertNoReactionParentWrites(mockDb.refCalls, 'tour-guard', 'msg-guard', '👍');
});

test('subscribeToChatMessages uses a bounded timestamp query by default', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-bounded': {
        messages: {
          old: { text: 'old', timestamp: '2026-03-18T09:00:00.000Z' },
          recent: { text: 'recent', timestamp: '2026-03-18T10:00:00.000Z' },
        },
      },
    },
  });

  const updates = [];
  const unsubscribe = subscribeToChatMessages('tour-bounded', (messages) => {
    updates.push(messages);
  }, mockDb);

  assert.equal(mockDb.refCalls[0].path, 'chats/tour-bounded/messages');
  assert.equal(mockDb.refCalls[0].queryState.orderByChild, 'timestamp');
  assert.equal(mockDb.refCalls[0].queryState.limitToLast, 80);
  assert.deepEqual(updates[0].map((message) => message.id), ['old', 'recent']);
  unsubscribe();
});

test('chat subscriptions accept custom limits and internal chat uses the same bounded query', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-limit': {
        messages: {
          first: { text: 'first', timestamp: '2026-03-18T09:00:00.000Z' },
          second: { text: 'second', timestamp: '2026-03-18T09:01:00.000Z' },
          third: { text: 'third', timestamp: '2026-03-18T09:02:00.000Z' },
        },
      },
    },
    internal_chats: {
      'tour-limit': {
        messages: {
          intFirst: { text: 'first', timestamp: '2026-03-18T09:00:00.000Z' },
          intSecond: { text: 'second', timestamp: '2026-03-18T09:01:00.000Z' },
        },
      },
    },
  });

  const groupUpdates = [];
  const internalUpdates = [];
  const unsubscribeGroup = subscribeToChatMessages('tour-limit', (messages) => {
    groupUpdates.push(messages);
  }, mockDb, { limit: 2 });
  const unsubscribeInternal = subscribeToInternalDriverChat('tour-limit', (messages) => {
    internalUpdates.push(messages);
  }, mockDb, { limit: 1 });

  assert.equal(mockDb.refCalls[0].queryState.limitToLast, 2);
  assert.deepEqual(groupUpdates[0].map((message) => message.id), ['second', 'third']);
  assert.equal(mockDb.refCalls[1].path, 'internal_chats/tour-limit/messages');
  assert.equal(mockDb.refCalls[1].queryState.orderByChild, 'timestamp');
  assert.equal(mockDb.refCalls[1].queryState.limitToLast, 1);
  assert.deepEqual(internalUpdates[0].map((message) => message.id), ['intSecond']);

  unsubscribeGroup();
  unsubscribeInternal();
});

test('getChatMessagesPage returns older normalized messages without duplicating cursor', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-page': {
        messages: {
          msg1: {
            text: 'one',
            timestamp: '2026-03-18T09:00:00.000Z',
            reactions: { '👍': { userA: true } },
          },
          msg2: { text: 'two', timestamp: '2026-03-18T09:01:00.000Z' },
          msg3: { text: 'three', timestamp: '2026-03-18T09:02:00.000Z' },
          msg4: { text: 'four', timestamp: '2026-03-18T09:03:00.000Z' },
        },
      },
    },
  });

  const result = await getChatMessagesPage({
    tourId: 'tour-page',
    beforeTimestamp: '2026-03-18T09:03:00.000Z',
    beforeMessageId: 'msg4',
    limit: 2,
    dbInstance: mockDb,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.messages.map((message) => message.id), ['msg2', 'msg3']);
  assert.deepEqual(result.messages[0].reactions, {});
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.nextCursor, {
    beforeTimestamp: '2026-03-18T09:01:00.000Z',
    beforeMessageId: 'msg2',
  });
});

test('getChatMessagesPage returns failure contract when database is unavailable', async () => {
  const result = await getChatMessagesPage({
    tourId: 'tour-page',
    dbInstance: null,
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.messages, []);
});

test('subscribeToChatMessages normalizes reaction maps for the UI', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-3': {
        messages: {
          'msg-1': {
            text: 'Hi',
            timestamp: '2026-03-18T09:00:00.000Z',
            reactions: {
              '❤️': {
                'user-1': true,
                'user-2': true,
                ignored: false,
              },
            },
          },
        },
      },
    },
  });

  const updates = [];
  const unsubscribe = subscribeToChatMessages('tour-3', (messages) => {
    updates.push(messages);
  }, mockDb);

  assert.equal(typeof unsubscribe, 'function');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0][0].reactions, {
    '❤️': ['user-1', 'user-2'],
  });

  unsubscribe();
});

test('chat subscriptions normalize canonical maps and ignore malformed reaction payloads', async () => {
  const mockDb = createMockRealtimeDb({
    chats: {
      'tour-4': {
        messages: {
          'msg-array': {
            text: 'array',
            timestamp: '2026-03-18T09:00:00.000Z',
            reactions: {
              '👍': ['user-2', '', ' user-1 ', 'user-2'],
            },
          },
          'msg-map': {
            text: 'map',
            timestamp: '2026-03-18T09:01:00.000Z',
            reactions: {
              '❤️': {
                ' user-3 ': true,
                '': true,
                ignored: false,
              },
            },
          },
          'msg-bad': {
            text: 'bad',
            timestamp: '2026-03-18T09:02:00.000Z',
            reactions: {
              '🎉': 'not-an-array-or-map',
            },
          },
        },
      },
    },
    internal_chats: {
      'tour-4': {
        messages: {
          'int-1': {
            text: 'internal',
            timestamp: '2026-03-18T09:03:00.000Z',
            reactions: {
              '🔥': {
                'driver-b': true,
                'driver-a': true,
              },
            },
          },
        },
      },
    },
  });

  const groupUpdates = [];
  const unsubscribeGroup = subscribeToChatMessages('tour-4', (messages) => {
    groupUpdates.push(messages);
  }, mockDb);

  const internalUpdates = [];
  const unsubscribeInternal = subscribeToInternalDriverChat('tour-4', (messages) => {
    internalUpdates.push(messages);
  }, mockDb);

  assert.equal(groupUpdates.length, 1);
  const latestGroup = groupUpdates[0];
  assert.deepEqual(latestGroup.find((msg) => msg.id === 'msg-array')?.reactions, {});
  assert.deepEqual(latestGroup.find((msg) => msg.id === 'msg-map')?.reactions, {
    '❤️': ['user-3'],
  });
  assert.deepEqual(latestGroup.find((msg) => msg.id === 'msg-bad')?.reactions, {});

  assert.equal(internalUpdates.length, 1);
  assert.deepEqual(internalUpdates[0][0].reactions, {
    '🔥': ['driver-a', 'driver-b'],
  });

  unsubscribeGroup();
  unsubscribeInternal();
});
