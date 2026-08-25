'use strict';

const admin = require('firebase-admin');

if (admin.apps.length === 0) admin.initializeApp();

module.exports = { admin };
