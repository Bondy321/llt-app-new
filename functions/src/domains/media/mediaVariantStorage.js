'use strict';

/** @type {(...args: any[]) => any} */
const buildPhotoVariantPaths = ({ visibility, tourId, ownerKey, filename }) => {
  const extensionlessName = filename.replace(/\.[^/.]+$/, "");
  const viewerPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/viewers/${extensionlessName}_viewer.jpg`
    : `group_tour_photos/${tourId}/viewers/${extensionlessName}_viewer.jpg`;
  const thumbnailPath = visibility === "private"
    ? `private_tour_photos/${tourId}/${ownerKey}/thumbnails/${extensionlessName}_thumb.jpg`
    : `group_tour_photos/${tourId}/thumbnails/${extensionlessName}_thumb.jpg`;

  return { viewerPath, thumbnailPath };
};



const retireVariantObject = async ({ bucket, path, expectedGeneration, sourcePath, sourceGeneration, sourceRole, visibility }) => {
  const file = bucket.file(path);
  const isSentinel = metadata => metadata?.metadata?.cancelled === 'true'
    && metadata.metadata.sourcePath === sourcePath && Number(metadata.size) === 0;
  const isLateOwnedVariant = metadata => expectedGeneration === 'missing' && sourceGeneration && sourceGeneration !== 'missing'
    && metadata?.metadata?.sourcePath === sourcePath && metadata.metadata.sourceGeneration === sourceGeneration
    && metadata.metadata.sourceRole === sourceRole && metadata.metadata.visibility === visibility;
  const read = async () => { try { return (await file.getMetadata())[0]; } catch (error) { if (Number(error.code) === 404) return null; throw error; } };
  if (!expectedGeneration) throw Object.assign(new Error('Variant generation unavailable'), { code: 'MEDIA_GENERATION_UNAVAILABLE' });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await read();
    if (isSentinel(existing)) return false;
    // Re-capture only a formerly missing target created by the exact old source
    // worker. A replacement of an already captured generation remains forbidden.
    const generation = !existing ? 0 : isLateOwnedVariant(existing) ? existing.generation
      : expectedGeneration === 'missing' ? 0 : expectedGeneration;
    try {
      await file.save(Buffer.alloc(0), { resumable: false, preconditionOpts: { ifGenerationMatch: generation },
        metadata: { contentType: 'application/octet-stream', cacheControl: 'private,no-store',
          metadata: { cancelled: 'true', sourceRole: 'cancelled-variant', sourcePath } } });
      return true;
    } catch (error) {
      if (Number(error.code) !== 412) throw error;
      const current = await read();
      if (isSentinel(current)) return false;
      if (!isLateOwnedVariant(current) || attempt === 3) throw error;
    }
  }
};

const saveVariantOnce = async ({ file, buffer, metadata }) => {
  let created = true;
  const matches = current => current.metadata?.cancelled !== 'true' && Number(current.size) > 0
    && ['sourcePath', 'sourceGeneration', 'sourceRole', 'visibility'].every(key => current.metadata?.[key] === metadata.metadata[key]);
  try {
    await file.save(buffer, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
    const [current] = await file.getMetadata();
    if (!matches(current)) throw error;
    created = false;
  }
  const [current] = await file.getMetadata();
  if (!matches(current) || !current.generation) throw Object.assign(new Error('Variant object changed'), { code: 'MEDIA_OBJECT_CHANGED' });
  return { generation: current.generation, created };
};

module.exports = { retireVariantObject, saveVariantOnce, buildPhotoVariantPaths };
