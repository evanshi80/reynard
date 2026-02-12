import Tesseract from 'tesseract.js';
import sharp from 'sharp';

async function main() {
  console.log('Testing chi_sim with blocks output...');
  const w = await Tesseract.createWorker('chi_sim');

  // Take a screenshot of top-left 400x300 area
  const robot = require('robotjs');
  const capture = robot.screen.capture(0, 0, 400, 300);
  const img = capture.image;
  for (let i = 0; i < img.length; i += 4) {
    const b = img[i]; img[i] = img[i + 2]; img[i + 2] = b;
  }
  const png = await sharp(Buffer.from(img), {
    raw: { width: capture.width, height: capture.height, channels: 4 }
  }).png().toBuffer();

  const result = await w.recognize(png, {}, { blocks: true });
  console.log('Text:', JSON.stringify(result.data.text.substring(0, 200)));
  console.log('Blocks:', result.data.blocks?.length ?? 'null');

  if (result.data.blocks) {
    for (const block of result.data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          console.log(`  Line: "${line.text.trim()}" bbox=(${line.bbox.x0},${line.bbox.y0})-(${line.bbox.x1},${line.bbox.y1}) conf=${line.confidence.toFixed(1)}`);
        }
      }
    }
  }

  await w.terminate();
}

main().catch(console.error);
