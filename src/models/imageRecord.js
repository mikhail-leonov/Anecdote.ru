/**
 * src/models/imageRecord.js
 * -----------------------------------------------------------------------------
 * The data model for a single downloaded image, as persisted in
 * data/downloaded-images.json. Centralising the shape here keeps the
 * persistence format in one place.
 * -----------------------------------------------------------------------------
 */

import { normalizeUrl } from '../utils/index.js';

/**
 * Build an image record.
 * @param {object} p
 * @param {string} p.url        original image URL
 * @param {string} p.filename   filename saved under data/images/
 * @param {string} p.sha256     SHA-256 hex of the file bytes
 * @param {number} p.bytes      file size in bytes
 * @returns {{url:string, normalizedUrl:string, filename:string,
 *            sha256:string, bytes:number, downloadedAt:string}}
 */
export function createImageRecord({ url, filename, sha256, bytes }) {
  return {
    url,
    normalizedUrl: normalizeUrl(url),
    filename,
    sha256,
    bytes,
    downloadedAt: new Date().toISOString(),
  };
}

export default createImageRecord;
