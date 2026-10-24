'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mediaPublicationGate } = require('../../functions/lib/mediaPublicationRules');
const { sessionAdmissionRules } = require('../../functions/lib/sessionAdmissionRules');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../../database.rules.json'), 'utf8')).rules;

test('actual publication validation contains the complete current generated admission gates', () => {
  assert.ok(rules['.validate'].includes(`? (${mediaPublicationGate()}) :`), 'media gate must not drift from its generator');
  const { assignmentGate, policyGate } = sessionAdmissionRules();
  assert.ok(rules['.validate'].includes(`${assignmentGate} && ${policyGate}`), 'session gate must preserve exact admitted ownership');
  assert.doesNotMatch(JSON.stringify(rules), /\.numChildren\s*\(/,
    'RTDB rules must not call the SDK-only DataSnapshot.numChildren method');
});

test('photo metadata and safety copies have no parent admin write bypass', () => {
  for (const node of [rules.group_tour_photos, rules.group_tour_photos.$tourId,
    rules.private_tour_photos, rules.private_tour_photos.$tourId, rules.private_tour_photos.$tourId.$ownerId,
    rules.logs, rules.logs.$userId]) assert.equal(node['.write'], false);
  assert.match(rules.group_tour_photos.$tourId.$photoId['.write'], /^auth != null && auth\.lltMediaPublisher === true && /);
  const inspect = node => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '.write') assert.equal(value, false);
      else if (value && typeof value === 'object') inspect(value);
    }
  };
  for (const node of [rules.globalSafetyAlerts, rules.tours.$tourId.safetyAlerts, rules.logs.$userId.safety]) inspect(node);
  assert.ok(rules.logs.$userId.$logType['.write'], 'ordinary nonsafety logs retain their scoped writer');
});
