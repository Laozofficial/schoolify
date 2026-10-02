import { v2 as cloudinary } from 'cloudinary'
import env from '#start/env'

let configured = false
export function cloudinaryClient() {
  if (!configured) {
    cloudinary.config({
      cloud_name: env.get('CLOUDINARY_CLOUD_NAME'),
      api_key: env.get('CLOUDINARY_API_KEY'),
      api_secret: env.get('CLOUDINARY_API_SECRET'),
      secure: true,
    })
    configured = true
  }
  return cloudinary
}

/**
 * Uploads a local file to Cloudinary. Uses `resource_type: 'auto'` so images,
 * PDFs and Office docs are all accepted without callers picking a type.
 */
export async function uploadToCloudinary(
  filePath: string,
  opts: { folder?: string; publicId?: string } = {}
) {
  const client = cloudinaryClient()
  const res = await client.uploader.upload(filePath, {
    resource_type: 'auto',
    folder: opts.folder ?? 'school-portal',
    public_id: opts.publicId,
    use_filename: true,
    unique_filename: true,
    overwrite: false,
  })
  return {
    url: res.secure_url,
    publicId: res.public_id,
    resourceType: res.resource_type,
    format: res.format,
    bytes: res.bytes,
    originalFilename: res.original_filename,
  }
}
