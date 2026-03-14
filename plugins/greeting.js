
(function () {
  alert('Hello from the greeting plugin! This plugin registers a "greet-from-file" tool with the MCP broker that returns a greeting message. Check the console for details.');
  var client = new window.PodBayBrokerClient({
    clientId: 'example-pod',
    tools: [
      {
        name: 'greet-from-file',
        description: 'Returns a greeting message',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to greet'
            }
          },
          required: ['name']
        },
        handler: function (args) {
          var msg = 'Hello, ' + (args.name || 'World') + '! Greetings from PodBay example pod.';
          console.log('[PodBay] ' + msg);
          return { greeting: msg };
        }
      }
    ]
  });
  client.connect();
  console.log('[PodBay] Example pod greeting tool registered with broker');
  window.greetingClientPlugin = client; // expose for testing
})();
