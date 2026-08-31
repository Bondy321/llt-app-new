'use strict';

// @ts-check

/**
 * Firebase query snapshots expose their authoritative server order through
 * `forEach`. Reading `snapshot.val()` and sorting the resulting object is not
 * equivalent for integer-like or mixed-case keys and can corrupt cursors.
 *
 * @param {any} snapshot
 * @returns {Array<[string, any]>}
 */
const snapshotEntriesInQueryOrder = (snapshot) => {
  const entries = [];
  if (snapshot && typeof snapshot.forEach === 'function') {
    snapshot.forEach((child) => {
      entries.push([String(child.key), child.val()]);
      return false;
    });
    return entries;
  }
  return Object.entries(snapshot?.val?.() || {});
};

/** @param {any} snapshot @param {number} pageSize */
const selectSnapshotPage = (snapshot, pageSize) => {
  const entries = snapshotEntriesInQueryOrder(snapshot);
  const selected = entries.slice(0, pageSize);
  return {
    entries: selected,
    hasMore: entries.length > pageSize,
    lastKey: selected.at(-1)?.[0] || null,
  };
};

module.exports = {
  selectSnapshotPage,
  snapshotEntriesInQueryOrder,
};
