'use strict';

const { unwrapReviewedAuthorityConstraints } = require('./reviewedRuleConstraints');
const { constrainSourcePassengerRule, sourcePassengerRuleBoundaries } = require('./sourcePassengerScopeRules');

const closesOuterGrantAt = (value, end) => {
  let depth = 0;
  let quote = null;
  let regex = false;
  let characterClass = false;
  let previous = '';
  for (let index = 0; index <= end; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (regex) {
      if (char === '\\') index += 1;
      else if (char === '[') characterClass = true;
      else if (char === ']') characterClass = false;
      else if (char === '/' && !characterClass) regex = false;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '/' && previous === '(') regex = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index === end;
      if (depth < 0) return false;
    }
    if (!/\s/.test(char)) previous = char;
  }
  return false;
};

const originalReviewedGrant = (value, currentPath) => {
  if (currentPath[0] !== 'rules') return value;
  const permission = currentPath.at(-1);
  const name = currentPath.slice(1, -1).join('/');
  const boundary = sourcePassengerRuleBoundaries.find(([candidate, kind]) => candidate === name && kind === permission);
  if (!boundary || typeof value !== 'string') return value;
  // This suffix is a reviewed AND constraint, never an alternate grant. Only
  // its exact template at an inventoried permission boundary can be excluded.
  value = unwrapReviewedAuthorityConstraints(value);
  const suffix = constrainSourcePassengerRule('', boundary[2]).slice(1);
  if (!value.startsWith('(') || !value.endsWith(suffix)) return value;
  if (!closesOuterGrantAt(value, value.length - suffix.length)) return value;
  const grant = value.slice(1, -suffix.length);
  return constrainSourcePassengerRule(grant, boundary[2]) === value ? grant : value;
};

const findDriverAuthorityRulesWithoutPolicy = (value, currentPath = [], missing = []) => {
  if (typeof value === 'string') {
    const grant = originalReviewedGrant(value, currentPath);
    if (grant.includes("root.child('app_sessions/' + auth.uid + '/principalType').val() === 'driver'")
      && (!grant.includes('driver_login_policy/v1/generation') || !grant.includes('driverLoginPolicyGeneration'))) {
      missing.push(currentPath.join('/'));
    }
    return missing;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      findDriverAuthorityRulesWithoutPolicy(child, [...currentPath, key], missing);
    }
  }
  return missing;
};

module.exports = { findDriverAuthorityRulesWithoutPolicy, originalReviewedGrant };
