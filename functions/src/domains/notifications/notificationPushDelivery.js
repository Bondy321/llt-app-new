'use strict';

// @ts-check

const { log } = require('../../infrastructure/logging/safeLogger');
const { getExpoPushClient } = require('../../infrastructure/notifications/expoPushClient');
const { removeInvalidToken } = require('./notificationPolicy');
const { collectExpoTokenFailures } = require('./notificationRecipients');

/** @type {(...args: any[]) => Promise<{ successCount: number, errorCount: number }>} */
const deliverPushNotifications = async ({
  pushMessages,
  validRecipients,
  context,
  chunkErrorEvent,
  ticketErrorEvent = null,
  successWhen = (/** @type {any} */ ticket) => ticket?.status !== 'error',
  fallbackRemovalReason = 'DEVICE_NOT_REGISTERED',
}) => {
  const expo = getExpoPushClient();
  let successCount = 0;
  let errorCount = 0;
  for (const chunk of expo.chunkPushNotifications(pushMessages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (successWhen(ticket)) successCount += 1;
        else {
          errorCount += 1;
          if (ticketErrorEvent) {
            log.error(ticketErrorEvent, { error: ticket.message, details: ticket.details }, context);
          }
        }
      }
      const failures = collectExpoTokenFailures(tickets, chunk);
      await Promise.all(failures.map(async ({ token, errorCode }) => {
        const recipient = validRecipients.find((/** @type {any} */ candidate) => (
          candidate?.userData?.pushToken === token
        ));
        if (recipient?.userId) {
          await removeInvalidToken(recipient.userId, token, {
            reason: errorCode || fallbackRemovalReason,
          });
        }
      }));
    } catch (error) {
      errorCount += chunk.length;
      log.error(chunkErrorEvent, error, { ...context, chunkSize: chunk.length });
    }
  }
  return { successCount, errorCount };
};

module.exports = { deliverPushNotifications };
