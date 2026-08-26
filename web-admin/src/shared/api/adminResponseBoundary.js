// @ts-check

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isAdminActionSuccessResponse = (value) => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && /** @type {Record<string, unknown>} */ (value).success === true
);
