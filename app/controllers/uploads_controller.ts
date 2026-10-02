import type { HttpContext } from '@adonisjs/core/http'
import { uploadToCloudinary } from '#services/cloudinary'
import env from '#start/env'

/** Accepts every common student-file type Nigerian schools need to attach. */
const ALLOWED_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'svg',
  'pdf',
  'doc',
  'docx',
  'txt',
  'rtf',
  'xls',
  'xlsx',
  'csv',
  'ppt',
  'pptx',
] as const

export default class UploadsController {
  /**
   * POST /api/v1/uploads (multipart/form-data)
   * Single-file upload - returns Cloudinary URL + metadata.
   */
  async store({ request, response, serialize }: HttpContext) {
    if (!env.get('CLOUDINARY_CLOUD_NAME')) {
      return response.internalServerError({
        message: 'Cloudinary is not configured on the server.',
      })
    }

    const file = request.file('file', {
      extnames: ALLOWED_EXTS as unknown as string[],
      size: '25mb',
    })

    if (!file) {
      return response.badRequest({ message: 'No file uploaded (field name: file).' })
    }
    if (!file.isValid) {
      return response.badRequest({ message: file.errors?.[0]?.message ?? 'Invalid file' })
    }
    if (!file.tmpPath) {
      return response.badRequest({ message: 'File is not readable' })
    }

    const folder = String(request.input('folder') ?? 'school-portal')
    const uploaded = await uploadToCloudinary(file.tmpPath, { folder })

    return serialize({
      url: uploaded.url,
      publicId: uploaded.publicId,
      resourceType: uploaded.resourceType,
      format: uploaded.format,
      bytes: uploaded.bytes,
      originalFilename: uploaded.originalFilename,
    })
  }
}
