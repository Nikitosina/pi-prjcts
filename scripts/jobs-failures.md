# Jobs report delivery failures

- Two steers answered by the same turn must not post duplicate failure reports to the coordinator.
- The newest steer must settle the agent and Job and post the full Ready payload, whether the oldest or newest reporter sees their shared answer first.
- A shared quota failure must start one recovery path, not one per reporter.
- Repeating `agents send` with the same request id must deliver one message.
- Distinct follow-up answers, Ready reports, restart continuation and stop must retain their existing behavior.
