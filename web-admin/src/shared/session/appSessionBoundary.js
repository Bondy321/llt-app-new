// @ts-check

import { validateRemoteAppSession } from '../contracts/generated/appSession.js';

/** @param {unknown} value */
export const isValidRemoteAppSession = (value) => validateRemoteAppSession(value).valid;
