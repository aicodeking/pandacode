exports.activate = () => {};
// Only the manifest export is public. privateMethod is deliberately not exported there.
exports.services = {
  'sample.service-provider/greeting': {
    async hello(name, call) {
      await call.emit(`Consumer ${call.consumer}; project ${call.context.projectId ?? 'none'}`);
      return `Hello ${name}`;
    },
    privateMethod() { return 'private'; },
  },
};
