// src/services/storage.ts
// Vendor-abstracted storage layer. The API never touches file binaries:
// clients upload directly to Cloudinary using a signed payload issued here.
// Swapping to S3 presigned POSTs later = reimplement this file only.
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../utils/envelope.js';

export interface SignedUpload {
  upload_url: string;
  fields: Record<string, string>;
  public_id: string;
  expires_at: string;
}

export class StorageService {
  isConfigured(): boolean {
    return Boolean(
      config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret,
    );
  }

  /**
   * Cloudinary signed-upload contract: sign the sorted param string + api_secret
   * with SHA-1. Client POSTs the file plus these fields directly to Cloudinary.
   */
  signUpload(folder: 'covers' | 'body-images', userId: string): SignedUpload {
    if (!this.isConfigured()) {
      throw new ApiError(503, 'storage_unavailable', 'File storage is not configured');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${folder}/${userId}/${randomUUID()}`;
    const params: Record<string, string> = {
      folder,
      public_id: publicId,
      timestamp: String(timestamp),
    };

    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signature = createHash('sha1')
      .update(toSign + config.cloudinary.apiSecret)
      .digest('hex');

    return {
      upload_url: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/image/upload`,
      fields: { ...params, api_key: config.cloudinary.apiKey, signature },
      public_id: publicId,
      expires_at: new Date((timestamp + 3600) * 1000).toISOString(),
    };
  }
}
