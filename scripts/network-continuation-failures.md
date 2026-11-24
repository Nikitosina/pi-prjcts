# Network continuation

- A worker or Coordinator gives up after Durable retries a transport failure; a later request on the same model would succeed.
- A host restart loses the pending deadline, repeats a retry, or resets its growing, bounded delay.
- Stop, archive, pause, a changed model or a newer input leaves a stale retry that starts work again.
- A quota, auth or context-window error mentioning a connection goes down the network path.
