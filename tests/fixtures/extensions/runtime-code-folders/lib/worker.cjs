// Worker thread of the code folder: answers twice its input plus two.
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage(workerData * 2 + 2);
