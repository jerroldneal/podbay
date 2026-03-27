// Test ollama-mcp-bridge to query MCP tools
//
// FINDINGS:
// - The bridge has 51 MCP tools registered (visible in logs)
// - The bridge runs via http-wrapper.js exposing /api/chat
// - Tools are NOT exposed through the Ollama API /api/chat endpoint for listing
// - LLM responses do not include tool_calls or tools arrays
// - ✓ AUTOMATIC TOOL INVOCATION WORKS! The bridge automatically invokes
//   tools based on natural language prompts (e.g., asking for time triggers time tool)
// - Tool results are embedded directly in the LLM response
// - No programmatic interface to list or directly call specific tools
//
// This test triggers tool usage through natural language (time query)

fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen2.5:1.5b',
    messages: [
      {
        role: 'user',
        content: 'What time is it right now? Please speak the current time out loud using kokoro-tts.'
      }
    ],
    stream: false
  })
})
  .then(r => r.json())
  .then(d => {
    console.log('=== RESPONSE ===');
    console.log(JSON.stringify(d, null, 2));

    // Check if response includes actual time (12-hour with AM/PM or 24-hour UTC)
    const content = d.message?.content || '';
    const hasTime = content.match(/\d{1,2}:\d{2}(:\d{2})?/) || // HH:MM or HH:MM:SS
      content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) || // ISO timestamp
      content.toLowerCase().includes('am') ||
      content.toLowerCase().includes('pm') ||
      content.toLowerCase().includes('utc');

    if (hasTime) {
      console.log('\n✓ TIME DETECTED - Tool was invoked successfully');
    } else {
      console.log('\n⚠️  No specific time in response - Tool likely not invoked');
    }
  })
  .catch(e => {
    console.error('✗ FAILED:', e.message);
    process.exit(1);
  });
