import { WindowFinder } from './src/capture/windowFinder';

async function main() {
  console.log('=== Debug WindowFinder ===\n');

  const wf = new WindowFinder();

  console.log('1. First findWeChatWindow() call:');
  let win = wf.findWeChatWindow();
  console.log(`   Result: ${win ? `"${win.title}" at (${win.x},${win.y}) ${win.width}x${win.height}` : 'null'}`);

  if (!win) {
    console.log('\n2. Retrying after 1 second...');
    await new Promise(r => setTimeout(r, 1000));
    win = wf.findWeChatWindow();
    console.log(`   Result: ${win ? `"${win.title}" at (${win.x},${win.y}) ${win.width}x${win.height}` : 'null'}`);
  }

  if (!win) {
    console.log('\n3. Trying again with fresh instance...');
    const wf2 = new WindowFinder();
    win = wf2.findWeChatWindow();
    console.log(`   Result: ${win ? `"${win.title}" at (${win.x},${win.y}) ${win.width}x${win.height}` : 'null'}`);
  }
}

main().catch(console.error);
