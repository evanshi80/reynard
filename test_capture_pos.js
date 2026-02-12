const robot = require('robotjs');

console.log('Testing capture at different positions...\n');

// Get screen size
const size = robot.getScreenSize();
console.log('Screen size:', size.width, 'x', size.height);

// Current detection shows: 329,329 1920x1025
console.log('\nCurrent detection: 329,329 1920x1025');
console.log('This would capture from x=329 to x=2249 (329+1920)');
console.log('Screen is only 2560 wide, so this is within bounds');

// Capture at detected position
const bitmap = robot.screen.capture(329, 329, 1920, 1025);
console.log('Bitmap raw pixels:', bitmap.image.length);
console.log('Expected pixels:', 1920 * 1025 * 4);

// Test capturing at x=0 (left edge of screen)
console.log('\n--- Testing x=0 (left screen) ---');
const leftBitmap = robot.screen.capture(0, 0, 500, 500);
console.log('Left screen capture:', leftBitmap.image.length);

// Test capturing at x=2560-500 (right edge)
console.log('\n--- Testing right side of screen ---');
const rightBitmap = robot.screen.capture(2060, 329, 500, 500);
console.log('Right screen capture:', rightBitmap.image.length);
