// Post-processing for masked jobs: crop the padding that was added to reach a supported
// aspect ratio, then paste the original image back wherever the restore mask is white.
import sharp from 'sharp';

async function rawRgb(buffer, width, height) {
  const { data, info } = await sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
  return data;
}

/**
 * result: {buffer} returned by the model
 * job.pad: {x,y,w,h} normalized content rectangle inside the image that was sent
 * job.restoreFile: grayscale mask at source resolution (white = keep the original pixel)
 */
export async function postProcess(result, job, readImage) {
  const meta = await sharp(result.buffer).metadata();
  const RW = meta.width;
  const RH = meta.height;
  let region = { left: 0, top: 0, width: RW, height: RH };
  if (job.pad) {
    const left = Math.max(0, Math.round(job.pad.x * RW));
    const top = Math.max(0, Math.round(job.pad.y * RH));
    region = {
      left,
      top,
      width: Math.max(1, Math.min(RW - left, Math.round(job.pad.w * RW))),
      height: Math.max(1, Math.min(RH - top, Math.round(job.pad.h * RH))),
    };
  }
  const W = region.width;
  const H = region.height;
  const content = await sharp(result.buffer).extract(region).removeAlpha().png().toBuffer();
  if (!job.restoreFile) return { mime: 'image/png', buffer: content };

  const original = await rawRgb(readImage(job.sourceFile).buffer, W, H);
  const mask = await sharp(readImage(job.restoreFile).buffer)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .extractChannel(0)
    .raw()
    .toBuffer();
  const overlay = await sharp(original, { raw: { width: W, height: H, channels: 3 } })
    .joinChannel(mask, { raw: { width: W, height: H, channels: 1 } })
    .png()
    .toBuffer();
  const buffer = await sharp(content).composite([{ input: overlay }]).png().toBuffer();
  return { mime: 'image/png', buffer };
}
