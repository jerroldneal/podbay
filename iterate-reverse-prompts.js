#!/usr/bin/env node
/**
 * Iterate through reverse-prompt queue
 * Connects to broker, calls get_queued_prompt repeatedly,
 * processes each prompt, and provides responses
 */

import { stdin as input, stdout as output } from 'process';
import readline from 'readline';
import WebSocket from 'ws';

const BROKER_URL = 'ws://localhost:3099';
let ws = null;
let callCounter = 0;
let responses = [];

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(BROKER_URL);

    ws.on('open', () => {
      console.log('[open] Connected to broker at', BROKER_URL);
      resolve();
    });

    ws.on('close', () => {
      console.log('[close] Disconnected from broker');
    });

    ws.on('error', (err) => {
      console.error('[error]', err.message);
      reject(err);
    });

    ws.on('message', (data) => {
      handleMessage(data);
    });
  });
}

function handleMessage(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch (_) {
    console.error('[parse error]', rawData.toString().slice(0, 100));
    return;
  }

  if (msg.type === 'registered') {
    console.log('[registered] Ready to call tools');
    // Start iterating the queue
    setTimeout(() => getNextPrompt(), 500);
  }
}

function send(msg) {
  ws.send(JSON.stringify(msg));
}

function callTool(toolName, args) {
  return new Promise((resolve) => {
    const callId = ++callCounter;

    // Listen for the result
    const origOnMessage = ws.onmessage;
    const timeout = setTimeout(() => {
      console.log(`[timeout] Tool ${toolName} call ${callId} did not return result`);
      resolve(null);
      ws.addEventListener('message', origOnMessage);
    }, 30000);

    const listener = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data.toString());
      } catch (_) {
        return;
      }

      // Broker tools don't return responses in websocket directly
      // We need to use HTTP POST instead
    };

    ws.addEventListener('message', listener);

    // For now, we'll use HTTP POST to call tools
    callToolViaHttp(toolName, args)
      .then(resolve)
      .finally(() => {
        clearTimeout(timeout);
        ws.removeEventListener('message', listener);
      });
  });
}

async function callToolViaHttp(toolName, args) {
  try {
    // The broker HTTP endpoint is at port 3098 based on the code we saw
    const response = await fetch('http://localhost:3098/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args || {}
        },
        id: callCounter
      })
    });

    if (!response.ok) {
      console.error(`[http error] ${toolName}: ${response.status}`);
      return null;
    }

    const json = await response.json();
    if (json.error) {
      console.error(`[rpc error] ${json.error.message}`);
      return null;
    }

    if (json.result && json.result.content) {
      for (const item of json.result.content) {
        if (item.type === 'text') {
          try {
            return JSON.parse(item.text);
          } catch (_) {
            return item.text;
          }
        }
      }
    }

    return json.result;
  } catch (err) {
    console.error(`[call error] ${toolName}:`, err.message);
    return null;
  }
}

async function getNextPrompt(previousResponse = null) {
  const args = previousResponse ? { response: previousResponse } : {};

  console.log(`\n[calling] reverse-prompt__get_queued_prompt ${previousResponse ? 'with response' : '(initial)'}`);
  const result = await callToolViaHttp('reverse-prompt__get_queued_prompt', args);

  if (!result) {
    console.log('[error] No result from get_queued_prompt');
    closeAndExit();
    return;
  }

  console.log('[result]', JSON.stringify(result, null, 2));

  // Check if we have a prompt
  if (result.empty || result.prompt === 'check back in 15 seconds' || !result.prompt) {
    console.log('[done] Queue is empty or paused. Exiting.');
    responses.push({
      index: responses.length + 1,
      prompt: 'No more prompts',
      response: 'Queue empty'
    });
    closeAndExit();
    return;
  }

  const promptText = result.prompt;
  const promptNum = result.promptNumber || responses.length + 1;

  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[PROMPT ${promptNum}]\n`);
  console.log(promptText);
  console.log(`\n[${'='.repeat(60)}]\n`);

  // Prompt user for response
  const rl = readline.createInterface({ input, output });

  rl.question('[YOUR RESPONSE]\n> ', (answer) => {
    rl.close();

    responses.push({
      index: promptNum,
      prompt: promptText,
      response: answer
    });

    console.log(`[recorded] Response ${promptNum}: "${answer}"`);

    // Continue to next prompt
    setTimeout(() => getNextPrompt(answer), 500);
  });
}

async function closeAndExit() {
  console.log('\n[summary] Collected responses:');
  responses.forEach((r) => {
    console.log(`  ${r.index}. Q: ${r.prompt.substring(0, 40)}...`);
    console.log(`     A: ${r.response.substring(0, 60)}...`);
  });

  if (ws) ws.close();
  process.exit(0);
}

// Start
console.log('[start] Connecting to broker and iterating reverse-prompt queue');
connect()
  .then(() => {
    // Register as a client (optional, but good practice)
    send({
      type: 'register',
      clientId: 'reverse-prompt-iterator',
      tools: []
    });
  })
  .catch((err) => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
