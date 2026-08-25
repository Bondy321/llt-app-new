'use strict';

const { fetchPrivatePhotosPage, fetchTourPhotosPage } = require('./photo/photoFetchService');
const {
  buildGroupPhotoAuthHeaders,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  createBlob,
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
} = require('./photo/photoMediaService');
const { uploadPhoto } = require('./photo/photoUploadService');
const {
  subscribeToPrivatePhotos,
  subscribeToTourPhotos,
} = require('./photo/photoSubscriptionService');
const {
  deleteGroupPhoto,
  deletePrivatePhoto,
  updatePhotoCaption,
  uploadPhotoDirect,
} = require('./photo/photoMutationService');

module.exports = {
  buildGroupPhotoAuthHeaders,
  buildGroupPhotoEndpointUrl,
  buildPrivatePhotoEndpointUrl,
  createBlob,
  deleteGroupPhoto,
  deletePrivatePhoto,
  fetchPrivatePhotosPage,
  fetchTourPhotosPage,
  resolveGroupPhotoMedia,
  resolvePrivatePhotoMedia,
  subscribeToPrivatePhotos,
  subscribeToTourPhotos,
  updatePhotoCaption,
  uploadPhoto,
  uploadPhotoDirect,
};
