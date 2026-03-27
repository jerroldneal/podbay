fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen2.5:1.5b',
    messages: [
      { role: 'user', content: 'Test' }
    ],
    stream: false
  })
})
  .then(r => r.json())
  .then(d => {
    console.log({ d })
    console.log('✓ SUCCESS:', JSON.stringify(d, null, 2));
  })
  .catch(e => {
    console.error('✗ FAILED:', e.message);
    process.exit(1);
  });
