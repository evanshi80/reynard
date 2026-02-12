import { sendToContact, activateWeChat } from './src/wechat';

async function main() {
  console.log('=== Test: Send to 三人成虎 (群聊) ===\n');

  // Activate WeChat first
  console.log('1. Activating WeChat...');
  const activated = await activateWeChat();
  console.log('   Activated:', activated);

  // Wait for window to be ready
  await new Promise(r => setTimeout(r, 800));

  // Send message
  console.log('2. Sending message...');
  const ok = await sendToContact('三人成虎', 'OCR预处理测试！', '群聊');
  console.log('\nResult:', ok);
}

main().catch(console.error);
