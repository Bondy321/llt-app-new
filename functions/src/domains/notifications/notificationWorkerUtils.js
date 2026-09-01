'use strict';

// @ts-check

/** @param {any[]} items @param {number} concurrency @param {(item: any) => Promise<any>} callback */
const mapWithConcurrency = async (items, concurrency, callback) => {
  const results = new Array(items.length); let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

const resolveFanoutStatus = (counts) => {
  if (Number(counts.retrying || 0) > 0) return 'retrying';
  if (Number(counts.receiptPending || 0) > 0) return 'receipt_pending';
  if (Number(counts.submissionUnknown || 0) > 0) {
    const known = Number(counts.ticketAccepted || 0) + Number(counts.ticketRejected || 0)
      + Number(counts.receiptAccepted || 0) + Number(counts.receiptRejected || 0);
    return known > 0 ? 'partial' : 'submission_unknown';
  }
  return Number(counts.eligible || 0) === 0 ? 'no_recipients' : 'ticket_rejected';
};

module.exports = { mapWithConcurrency, resolveFanoutStatus };
