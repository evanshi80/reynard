import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const psScriptPath = path.resolve(process.cwd(), 'find_window.ps1');

function getDpiScale(): number {
  try {
    const output = execSync('powershell -Command "Get-CimInstance -ClassName Win32_DesktopMonitor | Select-Object -ExpandProperty PixelsPerXLogicalInch"', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    const dpi = parseInt(output);
    if (!isNaN(dpi) && dpi > 0) {
      return dpi / 96;
    }
  } catch {}
  return 1.0;
}

function getWindowBounds(): { x: number; y: number; width: number; height: number } | null {
  try {
    const command = 'powershell -ExecutionPolicy Bypass -File "' + psScriptPath + '"';
    console.log('Command:', command);
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();

    console.log('Raw output:', output);

    if (!output || output === 'NONE' || output.length < 10) {
      return null;
    }

    const parts = output.split('|');
    if (parts.length >= 5) {
      const coords = parts[2].split(',');
      if (coords.length === 4) {
        const dpiScale = getDpiScale();
        const logicalX = parseInt(coords[0]);
        const logicalY = parseInt(coords[1]);
        const logicalWidth = parseInt(coords[2]);
        const logicalHeight = parseInt(coords[3]);

        console.log(`DPI: ${dpiScale}, Logical: ${logicalX},${logicalY} ${logicalWidth}x${logicalHeight}`);

        const physicalX = Math.round(logicalX * dpiScale);
        const physicalY = Math.round(logicalY * dpiScale);
        const physicalWidth = Math.round(logicalWidth * dpiScale);
        const physicalHeight = Math.round(logicalHeight * dpiScale);

        console.log(`Physical: ${physicalX},${physicalY} ${physicalWidth}x${physicalHeight}`);

        return {
          x: physicalX,
          y: physicalY,
          width: physicalWidth,
          height: physicalHeight,
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
}

async function capture() {
  const robot = require('robotjs');

  const bounds = getWindowBounds();
  if (!bounds) {
    console.log('No window bounds found');
    return;
  }

  console.log('Capturing at:', bounds);

  try {
    const bitmap = robot.screen.capture(bounds.x, bounds.y, bounds.width, bounds.height);
    console.log('Bitmap:', bitmap.width, 'x', bitmap.height);

    // Convert to PNG
    const rgbBuffer = Buffer.alloc(bounds.width * bounds.height * 3);
    for (let i = 0; i < bounds.width * bounds.height; i++) {
      rgbBuffer[i * 3] = bitmap.image[i * 4];
      rgbBuffer[i * 3 + 1] = bitmap.image[i * 4 + 1];
      rgbBuffer[i * 3 + 2] = bitmap.image[i * 4 + 2];
    }

    const sharp = require('sharp');
    const imageBuffer = await sharp(rgbBuffer, {
      raw: { width: bounds.width, height: bounds.height, channels: 3 },
    }).png().toBuffer();

    fs.writeFileSync('data/screenshots/test_capture.png', imageBuffer);
    console.log('Saved to data/screenshots/test_capture.png, size:', imageBuffer.length);
  } catch (error) {
    console.error('Capture error:', error);
  }
}

capture();
