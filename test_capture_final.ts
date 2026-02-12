import { getCapturer } from './src/capture/screenshot';
import fs from 'fs';
import path from 'path';

async function main() {
  const capturer = getCapturer();
  console.log('Capturing screenshot...');

  const screenshot = await capturer.capture();

  if (screenshot) {
    console.log('Screenshot captured:', screenshot.length, 'bytes');

    // Save manually
    const saveDir = 'data/screenshots';
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    const filename = path.join(saveDir, `test_${Date.now()}.png`);
    fs.writeFileSync(filename, screenshot);
    console.log('Saved to:', filename);
  } else {
    console.log('Failed to capture screenshot');
  }
}

main();
