import { WindowFinder } from './src/capture/windowFinder';
import { activateWeChat } from './src/wechat';
import Tesseract from 'tesseract.js';

async function main() {
  console.log('=== OCR Debug ===\n');

  // Activate WeChat first
  console.log('1. Activating WeChat...');
  await activateWeChat();
  await new Promise(r => setTimeout(r, 1000));

  // Find window
  const wf = new WindowFinder();
  const win = wf.findWeChatWindow();

  if (!win) {
    console.log('Window not found!');
    return;
  }

  console.log(`Window: ${win.title} at (${win.x},${win.y}) ${win.width}x${win.height}`);
  wf.setWindowHandle(win.handle);
  const dpi = wf.getDpiScaleForLastWindow();
  console.log(`DPI: ${dpi}`);

  // Capture sidebar region
  const sidebarW = Math.min(Math.round(win.width * 0.35), 400);
  const region = { x: win.x, y: win.y + 50, w: sidebarW, h: Math.min(win.height - 50, 600) };
  console.log(`Capture region: (${region.x}, ${region.y}) ${region.w}x${region.h}\n`);

  // Run OCR directly
  const robot = require('robotjs');
  const sharp = require('sharp');

  const physX = Math.round(region.x * dpi);
  const physY = Math.round(region.y * dpi);
  const physW = Math.round(region.w * dpi);
  const physH = Math.round(region.h * dpi);

  console.log(`Physical capture: (${physX}, ${physY}) ${physW}x${physH}`);

  const capture = robot.screen.capture(physX, physY, physW, physH);
  const img = capture.image;

  // Convert RGB to BGR
  const pixels = Buffer.from(img);
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i];
    pixels[i] = pixels[i + 2];
    pixels[i + 2] = b;
  }

  // Preprocess
  const pngBuffer = await sharp(pixels, {
    raw: { width: capture.width, height: capture.height, channels: 4 },
  })
    .resize({ width: capture.width * 2, height: capture.height * 2, kernel: 'lanczos3' })
    .modulate({ saturation: 0.3 })
    .linear(1.2, -30)
    .png({ compressionLevel: 9 })
    .toBuffer();

  console.log(`Preprocessed image: ${pngBuffer.length} bytes\n`);

  // OCR
  const Tesseract = require('tesseract.js');
  const worker = await Tesseract.createWorker('chi_sim', 1, {
    logger: (m: any) => {
      if (m.status === 'recognizing text') {
        process.stdout.write(`\rOCR: ${(m.progress * 100).toFixed(0)}%`);
      }
    }
  });

  console.log('\nAll OCR text:');
  const { data } = await worker.recognize(pngBuffer, {}, { blocks: true });

  if (data.blocks) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.trim().replace(/\s+/g, '');
          const y = Math.round(line.bbox.y0 / 2);
          console.log(`  "${line.text.trim()}" -> "${text}" y=${y}`);
        }
      }
    }
  }

  await worker.terminate();
}

main().catch(console.error);
