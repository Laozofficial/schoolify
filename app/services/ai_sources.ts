import env from '#start/env'
import { AiError } from '#services/ai'
import { cloudinaryClient } from '#services/cloudinary'

/**
 * Turn files a teacher uploaded (photos of notes or past papers, PDFs, text
 * files) into model input parts. Only files on this school portal's own
 * Cloudinary account are accepted, so a crafted URL cannot make the server
 * fetch arbitrary addresses.
 */

export type SourcePart = Record<string, unknown>

const MAX_FILES = 8
const MAX_PDF_BYTES = 15 * 1024 * 1024
const MAX_TEXT_CHARS = 20_000
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']

function cloudName() {
  return env.get('CLOUDINARY_CLOUD_NAME') ?? ''
}

function extOf(url: string) {
  const path = new URL(url).pathname
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return (m?.[1] ?? '').toLowerCase()
}

function assertOwnCloudinary(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new AiError('One of the files has an invalid address. Upload it again.', 400)
  }
  const cloud = cloudName()
  if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com' || !cloud || !u.pathname.startsWith(`/${cloud}/`)) {
    throw new AiError('Only files uploaded here can be used. Upload the file again.', 400)
  }
}

/**
 * Images are resized on Cloudinary's side (long edge 2000 px is plenty for
 * handwriting) and HEIC photos from iPhones are converted to JPEG, which
 * the model can read.
 */
function imageUrl(url: string) {
  let out = url.includes('/image/upload/') ? url.replace('/image/upload/', '/image/upload/c_limit,w_2000,q_auto/') : url
  if (/\.(heic|heif)$/i.test(out)) out = out.replace(/\.(heic|heif)$/i, '.jpg')
  return out
}

async function fetchLimited(url: string, maxBytes: number): Promise<Buffer> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new AiError('Could not read one of the uploaded files. Upload it again.', 400)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > maxBytes) throw new AiError('That file is too large. Use a PDF under 15 MB, or photos of the pages.', 413)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new AiError('That file is too large. Use a PDF under 15 MB, or photos of the pages.', 413)
    return buf
  } catch (e) {
    if (e instanceof AiError) throw e
    throw new AiError('Could not read one of the uploaded files. Upload it again.', 400)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Many Cloudinary accounts block direct PDF delivery, so PDFs are fetched
 * through a short-lived signed download link from the Admin API instead.
 */
function signedDownloadUrl(url: string): string {
  const u = new URL(url)
  const m = /\/(image|raw)\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+)$/.exec(u.pathname)
  if (!m) return url
  const resourceType = m[1] as 'image' | 'raw'
  const path = decodeURIComponent(m[2])
  const dot = path.lastIndexOf('.')
  const publicId = resourceType === 'raw' || dot < 0 ? path : path.slice(0, dot)
  const format = dot < 0 ? '' : path.slice(dot + 1)
  return cloudinaryClient().utils.private_download_url(publicId, format, {
    resource_type: resourceType,
    type: 'upload',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  })
}

export async function loadSources(urls: string[]): Promise<{ parts: SourcePart[]; text: string; summary: string[] }> {
  const list = [...new Set(urls.map((u) => String(u ?? '').trim()).filter(Boolean))]
  if (list.length > MAX_FILES) throw new AiError(`Use up to ${MAX_FILES} files at a time.`, 400)
  const parts: SourcePart[] = []
  const summary: string[] = []
  let text = ''
  for (const [i, url] of list.entries()) {
    assertOwnCloudinary(url)
    const ext = extOf(url)
    const name = `file-${i + 1}.${ext || 'bin'}`
    if (IMAGE_EXT.includes(ext) || (!ext && url.includes('/image/upload/'))) {
      parts.push({ type: 'image_url', image_url: { url: imageUrl(url), detail: 'high' } })
      summary.push(`${name}: photo or scan`)
    } else if (ext === 'pdf') {
      const buf = await fetchLimited(signedDownloadUrl(url), MAX_PDF_BYTES)
      parts.push({ type: 'file', file: { filename: name, file_data: `data:application/pdf;base64,${buf.toString('base64')}` } })
      summary.push(`${name}: PDF document`)
    } else if (ext === 'txt' || ext === 'csv') {
      const buf = await fetchLimited(url, 2 * 1024 * 1024)
      text += `\n\n[${name}]\n` + buf.toString('utf8').slice(0, MAX_TEXT_CHARS)
      summary.push(`${name}: text`)
    } else {
      throw new AiError('Word and PowerPoint files cannot be read directly. Save them as PDF, or upload photos of the pages.', 415)
    }
  }
  return { parts, text: text.trim(), summary }
}
