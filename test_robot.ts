import robot from 'robotjs';

console.log('RobotJS loaded');

// Get screen size
const screenSize = robot.getScreenSize();
console.log('Screen size:', screenSize.width, 'x', screenSize.height);

// Capture full screen
console.log('Capturing full screen...');
const bitmap = robot.screen.capture(0, 0, screenSize.width, screenSize.height);
console.log('Bitmap:', bitmap.width, 'x', bitmap.height);

// Capture a small area (center of screen)
const centerX = Math.floor(screenSize.width / 2);
const centerY = Math.floor(screenSize.height / 2);
const captureW = 500;
const captureH = 400;

console.log(`Capturing at ${centerX},${centerY} size ${captureW}x${captureH}...`);
const smallBitmap = robot.screen.capture(centerX, centerY, captureW, captureH);
console.log('Small bitmap:', smallBitmap.width, 'x', smallBitmap.height);

console.log('Done!');
