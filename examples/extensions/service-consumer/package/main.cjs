exports.activate = panda => panda.commands.register('sample.service-consumer/greet', async () => {
  let call = await panda.services.start({ service: 'sample.service-provider/greeting', version: '1.0.0', method: 'hello', input: 'PandaCode' });
  const events = [];
  try {
    while (call.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 20));
      call = await panda.services.poll({ request: call.request });
      events.push(...call.events);
    }
    if (call.error) throw new Error(call.error);
    await panda.ui.showDialog({ title: 'Public service exchange', fields: [], successMessage: `${call.output}; ${events.map(event => event.value).join('; ')}` });
  } finally { await panda.services.dispose({ request: call.request }); }
});
