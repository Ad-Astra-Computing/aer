// Starts the observer the way bootstrap does, runs the app, prints what it saw.
import { startFrameworkObserver } from '../../../dist/frameworks/observe.js';
const observer = startFrameworkObserver();
await import(process.argv[2]);
process.stdout.write(`OBSERVED:${JSON.stringify(observer.observed())}\n`);
observer.stop();
