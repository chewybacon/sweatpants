// await-event-horizon.ts
async function doWork(): Promise<void> {
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 100000));
  } finally {
    console.log('Cleaning up...');  // Will this run?
  }
}

const promise = doWork();

// Simulate user pressing Ctrl+C after 1 second
setTimeout(() => {
  console.log('Exiting...');
  process.exit(0);
}, 1000);
