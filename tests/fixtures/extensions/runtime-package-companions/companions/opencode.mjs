// Synthetic V1 module; no real harness, credential, network or model request.
export default async function () {
  return {
    'tool.execute.before': async (_input, output) => { output.args.fixtureCompanion = true; },
    'tool.execute.after': async (_input, output) => { output.output = 'fixture package result'; },
  };
}
