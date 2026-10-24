'use strict';

module.exports = {
  ...require('./driverDevicePolicy'),
  verifyStaffSessionAuthority: require('./staffEnrolment').verifyStaffSessionAuthority,
};
