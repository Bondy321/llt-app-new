export async function boundedRequest(operation, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The request did not finish. Check your connection and retry.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
