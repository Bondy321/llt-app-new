#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const definitionPath = path.join(repositoryRoot, 'contracts/definitions/contracts.v1.json');
const definitions = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));

const outputs = [
  { path: 'src/shared/contracts/generated/contracts.js', format: 'esm' },
  { path: 'functions/src/contracts/generated/contracts.js', format: 'cjs' },
  { path: 'web-admin/src/shared/contracts/generated/contracts.js', format: 'esm' },
  { path: 'contracts/types/generated/contracts.d.ts', format: 'types' },
  { path: 'src/shared/contracts/generated/appSession.js', format: 'cjs', focus: 'appSession' },
  { path: 'src/shared/contracts/generated/appSession.d.ts', format: 'focused-types', focus: 'appSession' },
  { path: 'src/shared/contracts/generated/loginResponses.js', format: 'cjs', focus: 'loginResponses' },
  { path: 'src/shared/contracts/generated/loginResponses.d.ts', format: 'focused-types', focus: 'loginResponses' },
  { path: 'src/shared/contracts/generated/mediaResponses.js', format: 'cjs', focus: 'mediaResponses' },
  { path: 'src/shared/contracts/generated/mediaResponses.d.ts', format: 'focused-types', focus: 'mediaResponses' },
  { path: 'src/shared/contracts/generated/notificationPayload.js', format: 'cjs', focus: 'notificationPayload' },
  { path: 'src/shared/contracts/generated/notificationPayload.d.ts', format: 'focused-types', focus: 'notificationPayload' },
  { path: 'src/shared/contracts/generated/accountDeletion.js', format: 'cjs', focus: 'accountDeletion' },
  { path: 'src/shared/contracts/generated/accountDeletion.d.ts', format: 'focused-types', focus: 'accountDeletion' },
  { path: 'functions/src/contracts/generated/appSession.js', format: 'cjs', focus: 'appSession' },
  { path: 'functions/src/contracts/generated/appSession.d.ts', format: 'focused-types', focus: 'appSession' },
  { path: 'functions/src/contracts/generated/accountDeletion.js', format: 'cjs', focus: 'accountDeletion' },
  { path: 'functions/src/contracts/generated/accountDeletion.d.ts', format: 'focused-types', focus: 'accountDeletion' },
  { path: 'web-admin/src/shared/contracts/generated/appSession.js', format: 'esm', focus: 'appSession' },
  { path: 'web-admin/src/shared/contracts/generated/appSession.d.ts', format: 'focused-types', focus: 'appSession' },
];

const focusedContracts = Object.freeze({
  appSession: ['AppSession', 'ClientAppSession'],
  loginResponses: ['PassengerLoginResponse', 'DriverLoginResponse', 'DriverAssignmentResponse', 'ClientAppSession'],
  mediaResponses: ['ResolvedMediaResponse'],
  notificationPayload: ['NotificationPayload'],
  accountDeletion: [
    'AccountDeletionReceipt',
    'AccountDeletionSafePhase',
    'AccountDeletionSafeSummary',
    'AccountDeletionRequest',
    'AccountDeletionAcceptedResponse',
    'AccountDeletionStatusRequest',
    'AccountDeletionStatusResponse',
    'PendingAccountDeletionRecord',
    'AccountDeletionRolloutRecord',
  ],
});

const runtimeValidatorSource = `
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const actualType = (value) => Number.isInteger(value) ? 'integer' : Array.isArray(value) ? 'array' : typeof value;
const matchesType = (value, expected) => {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => type === 'object' ? isRecord(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : actualType(value) === type);
};
const visitKeys = (value, callback, path = '') => {
  if (!isRecord(value)) return;
  Object.entries(value).forEach(([key, nested]) => {
    callback(key, nested, path ? \`${'${path}'}.${'${key}'}\` : key);
    if (isRecord(nested)) visitKeys(nested, callback, path ? \`${'${path}'}.${'${key}'}\` : key);
  });
};
const validateContract = (name, value, options = {}) => {
  const contract = CONTRACTS[name];
  if (!contract) return { valid: false, errors: [\`unknown contract: ${'${name}'}\`] };
  const errors = [];
  if (contract.kind === 'string') {
    if (typeof value !== 'string') errors.push('value must be a string');
    else if (contract.pattern && !(new RegExp(contract.pattern, 'u')).test(value)) errors.push('value has an invalid format');
    if (typeof value === 'string' && contract.maximumLengths?.self && value.length > contract.maximumLengths.self) errors.push('value is too long');
    return { valid: errors.length === 0, errors };
  }
  if (!isRecord(value)) return { valid: false, errors: ['value must be an object'] };
  const allowed = new Set([...(contract.requiredProperties || []), ...(contract.optionalProperties || [])]);
  (contract.requiredProperties || []).forEach((property) => {
    if (!Object.prototype.hasOwnProperty.call(value, property)) errors.push(\`${'${property}'} is required\`);
  });
  if (contract.rejectUnknownProperties) Object.keys(value).forEach((property) => {
    if (!allowed.has(property)) errors.push(\`${'${property}'} is not allowed\`);
  });
  Object.entries(contract.properties || {}).forEach(([property, rule]) => {
    if (!Object.prototype.hasOwnProperty.call(value, property)) return;
    const candidate = value[property];
    if (candidate === null && rule.nullable === true) return;
    if (!matchesType(candidate, rule.type)) errors.push(\`${'${property}'} has an invalid type\`);
    if (Object.prototype.hasOwnProperty.call(rule, 'const') && candidate !== rule.const) errors.push(\`${'${property}'} has an invalid constant value\`);
    if (rule.enum && !rule.enum.includes(candidate)) errors.push(\`${'${property}'} has an unexpected value\`);
    if (typeof candidate === 'string' && rule.minLength && candidate.length < rule.minLength) errors.push(\`${'${property}'} is too short\`);
    if (typeof candidate === 'string' && rule.maxLength && candidate.length > rule.maxLength) errors.push(\`${'${property}'} is too long\`);
    if (typeof candidate === 'string' && rule.pattern && !(new RegExp(rule.pattern, 'u')).test(candidate)) errors.push(\`${'${property}'} has an invalid format\`);
    if (typeof candidate === 'number' && rule.minimum !== undefined && candidate < rule.minimum) errors.push(\`${'${property}'} is below its minimum\`);
    if (typeof candidate === 'number' && rule.maximum !== undefined && candidate > rule.maximum) errors.push(\`${'${property}'} exceeds its maximum\`);
    if (Array.isArray(candidate) && rule.maxItems !== undefined && candidate.length > rule.maxItems) errors.push(\`${'${property}'} has too many items\`);
  });
  if (options.clientProjection === true) (contract.forbiddenClientProjection || []).forEach((property) => {
    if (Object.prototype.hasOwnProperty.call(value, property)) errors.push(\`${'${property}'} is forbidden from client projections\`);
  });
  for (const constraint of contract.constraints || []) {
    if (constraint === 'driverPrincipalMatchesDriverId' && value.principalType === 'driver' && value.principalId !== \`driver:${'${value.driverId}'}\`) errors.push('driver principal does not match driverId');
    if (constraint === 'passengerPrincipalIsOpaque' && value.principalType === 'passenger' && !/^pax_v2_[a-f0-9]{32}$/u.test(value.principalId || '')) errors.push('passenger principal is not opaque');
    if (constraint === 'expiryAfterIssue' && Number(value.expiresAtMs) <= Number(value.lastAuthenticatedAtMs ?? value.issuedAtMs)) errors.push('session expiry must follow authentication');
    if (constraint === 'idempotencyEqualsId' && value.id && value.idempotencyKey !== value.id) errors.push('idempotency key must equal the record id');
    if (constraint === 'notificationRouteSemantics') {
      if (value.timestamp && value.expiresAtMs && Number(value.expiresAtMs) <= Number(value.timestamp)) errors.push('notification expiry must follow timestamp');
      if (value.screen === 'Chat' && (!value.tourId || !value.messageId)) errors.push('chat notification requires tourId and messageId');
      if (value.screen === 'Itinerary' && !value.tourId) errors.push('itinerary notification requires tourId');
      if (value.screen === 'DriverTourPack' && (!value.tourId || !value.departureKey || !value.revision)) errors.push('driver pack notification requires tourId, departureKey and revision');
      if (value.screen === 'SafetyAlertDetail' && (!value.tourId || !value.eventId)) errors.push('safety detail notification requires tourId and eventId');
      if (value.screen === 'MarketingNotificationDetail' && (!value.categoryKey || !value.broadcastId || value.tourId)) errors.push('marketing detail notification requires categoryKey and broadcastId without tourId');
    }
    if (constraint === 'noDurableMediaUrls') visitKeys(value, (key) => {
      if (/^(?:sourceUrl|thumbnailUrl|viewerUrl|downloadUrl|downloadToken)$/u.test(key)) errors.push(\`${'${key}'} is a forbidden durable media field\`);
    });
    if (constraint === 'noCredentialFields') visitKeys(value, (key) => {
      if (/^(?:bookingRef|email|normalizedPassengerEmail|phone|phoneNumber)$/iu.test(key)) errors.push(\`${'${key}'} is a forbidden credential field\`);
    });
    if (constraint === 'expectedSessionIdOnlyWhileRequesting' && Object.prototype.hasOwnProperty.call(value, 'expectedSessionId') && value.state !== 'requesting') errors.push('expectedSessionId is only allowed while requesting');
  }
  return { valid: errors.length === 0, errors };
};`;

const generateRuntime = (format) => {
  const serialized = JSON.stringify(definitions, null, 2);
  const header = `'use strict';\n\n// GENERATED by scripts/contracts/generateContracts.js. Do not edit manually.\n`;
  const declarations = `const SCHEMA_SET_VERSION = ${definitions.schemaSetVersion};\nconst CONTRACTS = Object.freeze(${serialized}.contracts);\n${runtimeValidatorSource}\n`;
  return format === 'cjs'
    ? `${header}${declarations}\nmodule.exports = { SCHEMA_SET_VERSION, CONTRACTS, validateContract };\n`
    : `${header}${declarations}\nexport { SCHEMA_SET_VERSION, CONTRACTS, validateContract };\n`;
};

const generateFocusedRuntime = (format, focus) => {
  const names = focusedContracts[focus];
  if (!names) throw new Error(`Unknown focused contract adapter: ${focus}`);
  const selected = Object.fromEntries(names.map((name) => [name, definitions.contracts[name]]));
  const header = `'use strict';\n\n// GENERATED by scripts/contracts/generateContracts.js. Do not edit manually.\n`;
  const declarations = `const SCHEMA_SET_VERSION = ${definitions.schemaSetVersion};\nconst CONTRACTS = Object.freeze(${JSON.stringify(selected, null, 2)});\n${runtimeValidatorSource}\n`;
  const combinationHelpers = `
const combineResults = (...results) => ({
  valid: results.every((result) => result.valid),
  errors: results.flatMap((result) => result.errors),
});
const rejectKeysDeep = (value, keys) => {
  const errors = [];
  visitKeys(value, (key, _nested, keyPath) => {
    if (keys.has(key)) errors.push(\`${'${keyPath}'} is forbidden at this boundary\`);
  });
  return { valid: errors.length === 0, errors };
};
`;
  const sessionHelpers = `
const validateClientAppSession = (value) => validateContract('ClientAppSession', value, { clientProjection: true });
const validateRemoteAppSession = (value) => {
  const full = validateContract('AppSession', value);
  if (full.valid) return full;
  if (isRecord(value) && value.status === 'active') {
    const { status: _status, ...clientSession } = value;
    const reduced = validateClientAppSession(clientSession);
    if (reduced.valid) return reduced;
  }
  return validateClientAppSession(value);
};
`;
  const loginHelpers = `
${combinationHelpers}
${sessionHelpers}
const validateNestedSession = (value) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'session')
  ? validateClientAppSession(value.session)
  : { valid: true, errors: [] };
const validatePassengerLoginResponse = (value) => combineResults(
  validateContract('PassengerLoginResponse', value, { clientProjection: true }),
  validateNestedSession(value),
  rejectKeysDeep(value, new Set(['email', 'normalizedPassengerEmail', 'password'])),
);
const validateDriverLoginResponse = (value) => combineResults(
  validateContract('DriverLoginResponse', value, { clientProjection: true }),
  validateNestedSession(value),
  rejectKeysDeep(value, new Set(['authUid', 'driverCode'])),
);
const validateDriverAssignmentResponse = (value) => combineResults(
  validateContract('DriverAssignmentResponse', value, { clientProjection: true }),
  validateNestedSession(value),
  rejectKeysDeep(value, new Set(['authUid', 'driverCode'])),
);
`;
  const mediaHelpers = `
${combinationHelpers}
const validateResolvedMediaResponse = (value) => combineResults(
  validateContract('ResolvedMediaResponse', value, { clientProjection: true }),
  rejectKeysDeep(value, new Set(['storageCredentials', 'downloadToken'])),
);
`;
  const notificationHelpers = `
${combinationHelpers}
const validateNotificationPayload = (value) => combineResults(
  validateContract('NotificationPayload', value, { clientProjection: true }),
  rejectKeysDeep(value, new Set(['bookingRef', 'email', 'phone', 'signedUrl', 'token'])),
);
`;
  const accountDeletionHelpers = `
${combinationHelpers}
const ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS = new Set(['deletionId', 'authUid', 'originalAuthUid', 'bookingRef', 'email', 'phone', 'phoneNumber', 'driverId', 'tourId', 'storagePath', 'messageId']);
const ACCOUNT_DELETION_PENDING_PRIVATE_FIELDS = new Set(['deletionId', 'authUid', 'bookingRef', 'email', 'phone', 'phoneNumber', 'driverId', 'tourId', 'storagePath', 'messageId']);
const validateOptionalSafeSummary = (value) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'summary')
  ? validateAccountDeletionSafeSummary(value.summary)
  : { valid: true, errors: [] };
const projectContract = (name, value) => {
  if (!isRecord(value)) return {};
  const projected = {};
  for (const key of CONTRACTS[name].safeClientProjection || []) {
    if (Object.prototype.hasOwnProperty.call(value, key)) projected[key] = value[key];
  }
  return projected;
};
const validateAccountDeletionReceipt = (value) => validateContract('AccountDeletionReceipt', value, { clientProjection: true });
const validateAccountDeletionSafePhase = (value) => validateContract('AccountDeletionSafePhase', value, { clientProjection: true });
const validateAccountDeletionSafeSummary = (value) => combineResults(
  validateContract('AccountDeletionSafeSummary', value, { clientProjection: true }),
  rejectKeysDeep(value, ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS),
);
const validateAccountDeletionRequest = (value) => combineResults(
  validateContract('AccountDeletionRequest', value, { clientProjection: true }),
  rejectKeysDeep(value, ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS),
);
const validateAccountDeletionAcceptedResponse = (value) => combineResults(
  validateContract('AccountDeletionAcceptedResponse', value, { clientProjection: true }),
  rejectKeysDeep(value, ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS),
);
const validateAccountDeletionStatusRequest = (value) => combineResults(
  validateContract('AccountDeletionStatusRequest', value, { clientProjection: true }),
  rejectKeysDeep(value, ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS),
);
const validateAccountDeletionStatusResponse = (value) => combineResults(
  validateContract('AccountDeletionStatusResponse', value, { clientProjection: true }),
  validateOptionalSafeSummary(value),
  rejectKeysDeep(value, ACCOUNT_DELETION_REMOTE_PRIVATE_FIELDS),
);
const validatePendingAccountDeletionRecord = (value) => combineResults(
  validateContract('PendingAccountDeletionRecord', value, { clientProjection: true }),
  validateOptionalSafeSummary(value),
  rejectKeysDeep(value, ACCOUNT_DELETION_PENDING_PRIVATE_FIELDS),
);
const validateAccountDeletionRolloutRecord = (value) => validateContract('AccountDeletionRolloutRecord', value);
const projectAccountDeletionRequest = (value) => projectContract('AccountDeletionRequest', value);
const projectAccountDeletionAcceptedResponse = (value) => projectContract('AccountDeletionAcceptedResponse', value);
const projectAccountDeletionStatusRequest = (value) => projectContract('AccountDeletionStatusRequest', value);
const projectAccountDeletionStatusResponse = (value) => {
  const projected = projectContract('AccountDeletionStatusResponse', value);
  if (isRecord(projected.summary)) projected.summary = projectContract('AccountDeletionSafeSummary', projected.summary);
  return projected;
};
const projectPendingAccountDeletionRecord = (value) => {
  const projected = projectContract('PendingAccountDeletionRecord', value);
  if (isRecord(projected.summary)) projected.summary = projectContract('AccountDeletionSafeSummary', projected.summary);
  return projected;
};
const projectAccountDeletionRolloutRecord = (value) => projectContract('AccountDeletionRolloutRecord', value);
`;
  const helpersByFocus = {
    appSession: sessionHelpers,
    loginResponses: loginHelpers,
    mediaResponses: mediaHelpers,
    notificationPayload: notificationHelpers,
    accountDeletion: accountDeletionHelpers,
  };
  const exportsByFocus = {
    appSession: ['SCHEMA_SET_VERSION', 'validateClientAppSession', 'validateRemoteAppSession'],
    loginResponses: ['SCHEMA_SET_VERSION', 'validatePassengerLoginResponse', 'validateDriverLoginResponse', 'validateDriverAssignmentResponse'],
    mediaResponses: ['SCHEMA_SET_VERSION', 'validateResolvedMediaResponse'],
    notificationPayload: ['SCHEMA_SET_VERSION', 'validateNotificationPayload'],
    accountDeletion: [
      'SCHEMA_SET_VERSION',
      'validateAccountDeletionReceipt',
      'validateAccountDeletionSafePhase',
      'validateAccountDeletionSafeSummary',
      'validateAccountDeletionRequest',
      'validateAccountDeletionAcceptedResponse',
      'validateAccountDeletionStatusRequest',
      'validateAccountDeletionStatusResponse',
      'validatePendingAccountDeletionRecord',
      'validateAccountDeletionRolloutRecord',
      'projectAccountDeletionRequest',
      'projectAccountDeletionAcceptedResponse',
      'projectAccountDeletionStatusRequest',
      'projectAccountDeletionStatusResponse',
      'projectPendingAccountDeletionRecord',
      'projectAccountDeletionRolloutRecord',
    ],
  };
  const helpers = helpersByFocus[focus];
  const exports = exportsByFocus[focus].join(', ');
  return format === 'cjs'
    ? `${header}${declarations}${helpers}\nmodule.exports = { ${exports} };\n`
    : `${header}${declarations}${helpers}\nexport { ${exports} };\n`;
};

const propertyType = (rule = {}) => {
  const typeNames = (Array.isArray(rule.type) ? rule.type : [rule.type]).map((type) => {
    if (rule.enum) return rule.enum.map((value) => JSON.stringify(value)).join(' | ');
    if (type === 'integer' || type === 'number') return 'number';
    if (type === 'boolean') return 'boolean';
    if (type === 'array') return 'unknown[]';
    if (type === 'object') return 'Record<string, unknown>';
    return 'string';
  });
  const union = [...new Set(typeNames)].join(' | ');
  return rule.nullable ? `${union} | null` : union;
};

const generateTypes = () => {
  const lines = ['// GENERATED by scripts/contracts/generateContracts.js. Do not edit manually.', ''];
  for (const [name, contract] of Object.entries(definitions.contracts)) {
    if (contract.kind === 'string') {
      lines.push(`export type ${name} = string;`, '');
      continue;
    }
    const required = new Set(contract.requiredProperties || []);
    lines.push(`export interface ${name} {`);
    for (const property of [...(contract.requiredProperties || []), ...(contract.optionalProperties || [])]) {
      lines.push(`  ${property}${required.has(property) ? '' : '?'}: ${propertyType(contract.properties?.[property])};`);
    }
    lines.push('}', '');
  }
  lines.push('export interface ContractValidationResult {', '  valid: boolean;', '  errors: string[];', '}');
  return `${lines.join('\n')}\n`;
};

const generateFocusedTypes = (focus) => {
  const exportsByFocus = {
    appSession: ['validateClientAppSession', 'validateRemoteAppSession'],
    loginResponses: ['validatePassengerLoginResponse', 'validateDriverLoginResponse', 'validateDriverAssignmentResponse'],
    mediaResponses: ['validateResolvedMediaResponse'],
    notificationPayload: ['validateNotificationPayload'],
    accountDeletion: [
      'validateAccountDeletionReceipt',
      'validateAccountDeletionSafePhase',
      'validateAccountDeletionSafeSummary',
      'validateAccountDeletionRequest',
      'validateAccountDeletionAcceptedResponse',
      'validateAccountDeletionStatusRequest',
      'validateAccountDeletionStatusResponse',
      'validatePendingAccountDeletionRecord',
      'validateAccountDeletionRolloutRecord',
    ],
  };
  const validators = exportsByFocus[focus];
  if (!validators) throw new Error(`Unknown focused contract declaration: ${focus}`);
  return [
    '// GENERATED by scripts/contracts/generateContracts.js. Do not edit manually.',
    'export const SCHEMA_SET_VERSION: number;',
    'export interface ContractValidationResult { valid: boolean; errors: string[]; }',
    ...validators.map((name) => `export function ${name}(value: unknown): ContractValidationResult;`),
    ...(focus === 'accountDeletion' ? [
      'export function projectAccountDeletionRequest(value: unknown): Record<string, unknown>;',
      'export function projectAccountDeletionAcceptedResponse(value: unknown): Record<string, unknown>;',
      'export function projectAccountDeletionStatusRequest(value: unknown): Record<string, unknown>;',
      'export function projectAccountDeletionStatusResponse(value: unknown): Record<string, unknown>;',
      'export function projectPendingAccountDeletionRecord(value: unknown): Record<string, unknown>;',
      'export function projectAccountDeletionRolloutRecord(value: unknown): Record<string, unknown>;',
    ] : []),
    '',
  ].join('\n');
};

const contentFor = (output) => output.format === 'types'
  ? generateTypes()
  : output.format === 'focused-types' ? generateFocusedTypes(output.focus)
  : output.focus ? generateFocusedRuntime(output.format, output.focus) : generateRuntime(output.format);

const run = ({ check = false } = {}) => {
  const stale = [];
  for (const output of outputs) {
    const absolutePath = path.join(repositoryRoot, output.path);
    const expected = contentFor(output);
    if (check) {
      if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, 'utf8') !== expected) stale.push(output.path);
      continue;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, expected, 'utf8');
  }
  if (stale.length > 0) throw new Error(`Generated contract adapters are stale: ${stale.join(', ')}`);
  return outputs.map((output) => output.path);
};

if (require.main === module) {
  try {
    const check = process.argv.includes('--check');
    const paths = run({ check });
    process.stdout.write(check
      ? `Contract adapters are current (${paths.length} files).\n`
      : `Generated ${paths.length} contract adapter files.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { definitions, generateFocusedRuntime, generateFocusedTypes, generateRuntime, generateTypes, run };
