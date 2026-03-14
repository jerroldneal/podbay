// Recipe 2 — Client with one tool
(function () {
  var client = new window.PodBayBrokerClient({
    clientId: 'greeter',
    tools: [{
      name: 'say_hello',
      description: 'Returns a greeting',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name']
      },
      handler: function (args) {
        return { greeting: 'Hello, ' + args.name };
      }
    }]
  });
  client.connect();
})();
